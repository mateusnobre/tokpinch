/**
 * Fastify preHandler hook — runs on every proxy route BEFORE the request is
 * forwarded to the upstream API.
 *
 * Checks the budget, and if spending would be exceeded, returns a
 * provider-formatted error so that OpenClaw handles it the same way it would
 * handle a real upstream rate-limit response (backoff, retry visibility, etc.).
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { createLogger } from "../../utils/logger.js";
import { calculateCost } from "../../utils/pricing.js";
import { estimateRequestTokens } from "../../utils/tokenCounter.js";
import { checkBudget, recordActualSpend } from "../../services/budgetManager.js";
import { getProvider } from "../providers/index.js";
import { getQueries } from "../../db/index.js";

const log = createLogger("middleware:budget");

// ---------------------------------------------------------------------------
// Request-scoped reservations
// Each request that passes the budget check has its estimated cost reserved.
// We track it here so the handler can adjust after the real cost is known.
// ---------------------------------------------------------------------------

const reservations = new Map<string, number>(); // requestId → estimatedCost

export function getReservation(requestId: string): number {
  return reservations.get(requestId) ?? 0;
}

export function clearReservation(requestId: string): void {
  reservations.delete(requestId);
}

// ---------------------------------------------------------------------------
// preHandler hook
// ---------------------------------------------------------------------------

export async function budgetPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const provider = getProvider(req.url);
  if (!provider) return; // Non-proxy route — skip

  const body    = req.body as Record<string, unknown>;
  const parsed  = provider.parseRequest(body);
  const estimated = calculateCost(
    parsed.model,
    estimateRequestTokens(parsed.messages),
    0,
  );

  const result = checkBudget(estimated);

  if (!result.allowed) {
    const sessionId =
      (req.headers["x-openclaw-session"] as string | undefined) ??
      (req.headers["x-session-id"]       as string | undefined) ??
      null;

    log.warn(
      { requestId: req.id, model: parsed.model, reason: result.reason, sessionId },
      "Request blocked by budget check",
    );

    // Log the blocked request (async, don't delay the error response)
    setImmediate(() => {
      try {
        getQueries().insertRequest({
          timestamp:     Date.now(),
          provider:      provider.name,
          model:         parsed.model,
          input_tokens:  estimateRequestTokens(parsed.messages),
          output_tokens: 0,
          cost_usd:      0,
          session_id:    sessionId,
          request_type:  parsed.hasTools ? "tool_call" : "chat",
          duration_ms:   0,
          blocked:       1,
          block_reason:  "budget_exceeded",
        });
      } catch (err) {
        log.warn({ err }, "Failed to log blocked request");
      }
    });

    reply.status(429).send(
      provider.formatBlockedError(
        "budget_exceeded",
        result.reason ?? "Budget limit exceeded.",
      ),
    );
    return;
  }

  // Reservation made — store it so the handler can adjust after the response
  reservations.set(req.id, estimated);

  // Automatically clean up if the request somehow never records actual spend
  // (e.g. Fastify error handler fires before the handler runs)
  req.raw.once("close", () => {
    if (reservations.has(req.id)) {
      // Refund the reservation — the handler didn't record actual spend
      recordActualSpend(estimated, 0);
      reservations.delete(req.id);
    }
  });
}
