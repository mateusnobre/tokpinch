import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createLogger } from "../utils/logger.js";
import { calculateCost } from "../utils/pricing.js";
import { estimateRequestTokens } from "../utils/tokenCounter.js";
import { getQueries } from "../db/index.js";
import { getProvider } from "./providers/index.js";
import { SSEInterceptor } from "./streaming.js";
import { checkLoop, hashInput } from "./middleware/loopDetector.js";
import {
  budgetPreHandler,
  getReservation,
  clearReservation,
} from "./middleware/budgetCheck.js";
import { applyRouting } from "./middleware/modelRouter.js";
import { recordActualSpend } from "../services/budgetManager.js";
import { broadcast }         from "../api/websocket.js";
import { config }            from "../config.js";

const log = createLogger("proxy");

// Response headers we never forward to clients — Node/Fastify owns these.
const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "content-length",   // Fastify recalculates from the actual buffer/stream
  "content-encoding", // We request identity encoding so this won't appear,
                      // but drop it defensively in case a provider ignores us
]);

// ---------------------------------------------------------------------------
// Core proxy logic
// ---------------------------------------------------------------------------

async function proxyRequest(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const startMs   = Date.now();
  const requestId = req.id;
  const provider  = getProvider(req.url);

  if (!provider) {
    return reply
      .status(404)
      .send({ error: "No provider registered for this path" });
  }

  // Capture provider name early — TypeScript can't narrow `provider` through
  // async boundaries or setImmediate closures after this point.
  const providerName = provider.name;

  // 1. Require the caller to supply their own API key
  const authHeader =
    (req.headers["authorization"] as string | undefined) ??
    (req.headers["x-api-key"]     as string | undefined);

  if (!authHeader) {
    return reply.status(401).send(
      provider.formatBlockedError(
        "unauthorized",
        "No API key provided. Pass your key via Authorization: Bearer <key> or x-api-key: <key>.",
      ),
    );
  }

  // 1b. Require JSON Content-Type — reject plaintext/form bodies early
  const contentType = (req.headers["content-type"] as string | undefined) ?? "";
  if (!contentType.includes("application/json")) {
    return reply.status(415).send(
      provider.formatBlockedError(
        "invalid_request",
        "Content-Type must be application/json.",
      ),
    );
  }

  // 2. Parse request metadata — never log body contents
  const body    = req.body as Record<string, unknown>;
  const parsed  = provider.parseRequest(body);
  const { model, isStreaming, messages, hasTools, systemText } = parsed;

  // Accept both x-openclaw-session (canonical) and x-session-id (alias for compatibility)
  const sessionId =
    (req.headers["x-openclaw-session"] as string | undefined) ??
    (req.headers["x-session-id"]       as string | undefined) ??
    null;

  const requestType: "chat" | "heartbeat" | "tool_call" =
    hasTools                      ? "tool_call"  :
    /heartbeat/i.test(systemText) ? "heartbeat"  :
                                    "chat";

  log.debug(
    { requestId, provider: provider.name, model, isStreaming, requestType, sessionId },
    "Proxying request",
  );

  // 3. Loop detection (budget was already checked by the preHandler)
  const loopResult = checkLoop({
    sessionId,
    inputHash:        hashInput(messages),
    requestType,
    estimatedCostUsd: getReservation(requestId),
    model,
  });
  if (loopResult.blocked) {
    setImmediate(() => {
      try {
        getQueries().insertRequest({
          timestamp:     startMs,
          provider:      providerName,
          model,
          input_tokens:  estimateRequestTokens(messages),
          output_tokens: 0,
          cost_usd:      0,
          session_id:    sessionId,
          request_type:  requestType,
          duration_ms:   Date.now() - startMs,
          blocked:       1,
          block_reason:  "loop_detected",
        });
      } catch (err) {
        log.warn({ err }, "Failed to log loop-blocked request");
      }
    });
    // Refund the budget reservation made by the preHandler
    const reserved = getReservation(requestId);
    if (reserved > 0) {
      recordActualSpend(reserved, 0);
      clearReservation(requestId);
    }
    return reply
      .status(429)
      .send(provider.formatBlockedError(loopResult.reason!, loopResult.message!));
  }

  // 4. Smart model routing (opt-in, mutates body.model when active)
  const routingResult  = applyRouting(body, { model, messages, systemText, hasTools, requestType });
  const finalModel     = routingResult ? routingResult.finalModel    : model;
  const originalModel  = routingResult ? routingResult.originalModel : null;

  // 5. Build upstream request
  const upstreamUrl    = `${provider.baseUrl}${provider.upstreamPath(req.url)}`;
  const forwardHeaders = provider.buildHeaders(
    req.headers as Record<string, string | string[] | undefined>,
  );
  const bodyStr = JSON.stringify(body);

  // 5. Forward to upstream API
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method:  "POST",
      headers: forwardHeaders,
      body:    bodyStr,
    });
  } catch (err) {
    log.error({ requestId, err, upstreamUrl }, "Upstream fetch failed");
    // Refund the full reservation — we never sent the request
    const reserved = getReservation(requestId);
    recordActualSpend(reserved, 0);
    clearReservation(requestId);
    return reply.status(502).send(
      provider.formatBlockedError(
        "upstream_error",
        "Could not reach the upstream API. Check your network or try again.",
      ),
    );
  }

  // 6. Copy upstream status + safe headers to the client reply
  reply.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  });

  // 7. Error responses from upstream — refund reservation, forward body verbatim
  if (upstream.status >= 400 || !upstream.body) {
    const reserved = getReservation(requestId);
    recordActualSpend(reserved, 0);
    clearReservation(requestId);
    const errText = upstream.body ? await upstream.text() : "";
    return reply.send(Buffer.from(errText));
  }

  // Helper: write a successful request to the DB and reconcile budget spend
  function finalise(opts: {
    inputTokens:      number;
    outputTokens:     number;
    cacheReadTokens:  number;
    cacheWriteTokens: number;
  }): void {
    const actualCost = calculateCost(
      finalModel,
      opts.inputTokens,
      opts.outputTokens,
      opts.cacheReadTokens,
      opts.cacheWriteTokens,
    );

    // Reconcile the reservation with actual cost
    const reserved = getReservation(requestId);
    recordActualSpend(reserved, actualCost);
    clearReservation(requestId);

    setImmediate(() => {
      try {
        getQueries().insertRequest({
          timestamp:          startMs,
          provider:           providerName,
          model:              finalModel,
          original_model:     originalModel,
          input_tokens:       opts.inputTokens,
          output_tokens:      opts.outputTokens,
          cache_read_tokens:  opts.cacheReadTokens,
          cache_write_tokens: opts.cacheWriteTokens,
          cost_usd:           actualCost,
          session_id:         sessionId,
          request_type:       requestType,
          duration_ms:        Date.now() - startMs,
          blocked:            0,
        });
        log.debug(
          { requestId, model: finalModel, originalModel, actualCost, durationMs: Date.now() - startMs },
          "Request logged",
        );

        // Broadcast a lightweight event to connected dashboard clients
        broadcast({
          type: "request",
          data: {
            requestId,
            provider:      providerName,
            model:         finalModel,
            originalModel,
            inputTokens:   opts.inputTokens,
            outputTokens:  opts.outputTokens,
            costUsd:       actualCost,
            sessionId,
            requestType,
            durationMs:    Date.now() - startMs,
          },
        });
      } catch (err) {
        log.warn({ err, requestId }, "Failed to log completed request");
      }
    });
  }

  // 8a. Non-streaming — buffer, parse usage, send
  if (!isStreaming) {
    const responseText = await upstream.text();

    try {
      const responseJson = JSON.parse(responseText) as Record<string, unknown>;
      const usage = provider.parseUsage(responseJson);
      finalise(usage);
    } catch {
      log.warn({ requestId }, "Could not parse usage from non-streaming response");
      const reserved = getReservation(requestId);
      recordActualSpend(reserved, 0); // Refund on parse failure
      clearReservation(requestId);
    }

    return reply.send(Buffer.from(responseText));
  }

  // 8b. Streaming — pipe through SSEInterceptor, capture usage at end
  const interceptor = new SSEInterceptor((usage) => {
    finalise(usage);
  });

  interceptor.on("error", (err) => {
    log.error({ err, requestId }, "SSE interceptor error");
    const reserved = getReservation(requestId);
    recordActualSpend(reserved, 0);
    clearReservation(requestId);
    reply.raw.destroy();
  });

  const nodeStream = Readable.fromWeb(
    upstream.body as import("stream/web").ReadableStream<Uint8Array>,
  );

  nodeStream.on("error", (err) => {
    log.error({ err, requestId }, "Upstream stream error");
    interceptor.destroy(err);
  });

  nodeStream.pipe(interceptor);
  return reply.send(interceptor);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerProxyRoutes(app: FastifyInstance): Promise<void> {
  const opts = {
    preHandler: budgetPreHandler,
    config: {
      // Proxy endpoints get a higher rate limit than the default API limit
      // since AI agents can be legitimately chatty. Configurable via PROXY_RATE_LIMIT.
      rateLimit: { max: config.PROXY_RATE_LIMIT, timeWindow: "1 minute" },
    },
  };

  // Anthropic: /v1/messages and any future /v1/* endpoints
  app.post("/v1/*",          opts, proxyRequest);

  // OpenAI-compatible: /openai/v1/chat/completions etc.
  app.post("/openai/v1/*",   opts, proxyRequest);

  log.info(
    { proxyRateLimit: config.PROXY_RATE_LIMIT },
    "Proxy routes registered: POST /v1/* and POST /openai/v1/*",
  );
}
