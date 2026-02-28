import "dotenv/config";
import fs           from "node:fs";
import path         from "node:path";
import { fileURLToPath } from "node:url";
import Fastify      from "fastify";
import cors         from "@fastify/cors";
import rateLimit    from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { config }  from "./config.js";
import { logger }  from "./utils/logger.js";
import { initDb, closeDb, getQueries } from "./db/index.js";
import { registerProxyRoutes } from "./proxy/handler.js";
import { calculateCost }       from "./utils/pricing.js";
import { initializeBudgets }   from "./services/budgetManager.js";
import { startScheduler, stopScheduler } from "./services/scheduler.js";
import { loadRoutingRules }    from "./proxy/middleware/modelRouter.js";
import { registerAuthRoutes }  from "./api/auth.js";
import { registerApiRoutes }   from "./api/routes.js";
import { registerWebSocket }   from "./api/websocket.js";
import { initAlerter }        from "./services/alerter.js";

const app = Fastify({
  logger:     false,       // We use our own pino instance
  trustProxy: config.NODE_ENV === "production",
  bodyLimit:  10 * 1024 * 1024, // 10 MB — supports vision + large prompts
  genReqId:   () => Math.random().toString(36).slice(2, 10),
});

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

// Build allowed origins: always include localhost variants for dev/Docker health checks;
// in production, honour the ALLOWED_ORIGINS env var (comma-separated).
const allowedOrigins: (string | RegExp)[] = [
  "http://localhost:3000",
  "http://localhost:5173",
  `http://localhost:${config.PORT}`,
  /^http:\/\/localhost:\d+$/,
];
if (config.ALLOWED_ORIGINS) {
  for (const o of config.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)) {
    allowedOrigins.push(o);
  }
}

await app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
});

// Global rate limit — 500 req/min per IP for dashboard /api/* routes.
// Proxy routes override to PROXY_RATE_LIMIT (default 300/min).
// Login overrides to 5/min. The higher global prevents dashboard navigation
// from hitting limits when each page fires 3-7 parallel API calls.
await app.register(rateLimit, {
  global:     true,
  max:        500,
  timeWindow: "1 minute",
  keyGenerator: (req) => req.ip,
});

// ---------------------------------------------------------------------------
// Security headers — applied to every response
// ---------------------------------------------------------------------------

app.addHook("onSend", async (_req, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-XSS-Protection", "1; mode=block");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'",
  );
  if (config.NODE_ENV === "production") {
    // Only sent over HTTPS — reminds operators to put TLS in front.
    reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
});

// ---------------------------------------------------------------------------
// Dashboard static files  (/dashboard/* → dist/dashboard/)
// ---------------------------------------------------------------------------

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const dashboardDist  = path.join(__dirname, "..", "dist", "dashboard");

if (fs.existsSync(dashboardDist)) {
  // wildcard: false → plugin does NOT register GET /dashboard/* itself,
  // so our explicit route below is the only wildcard handler (no duplicate).
  await app.register(fastifyStatic, {
    root:          dashboardDist,
    prefix:        "/dashboard/",
    wildcard:      false,
    decorateReply: true,
  });

  app.get("/dashboard", async (_req, reply) => reply.redirect(301, "/dashboard/"));

  // Serve real asset files as-is; fall back to index.html for SPA deep routes.
  app.get("/dashboard/*", async (req, reply) => {
    const star     = (req.params as Record<string, string>)["*"] ?? "";
    const filePath = path.join(dashboardDist, decodeURIComponent(star));
    if (star && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return reply.sendFile(decodeURIComponent(star), dashboardDist);
    }
    return reply.sendFile("index.html", dashboardDist);
  });
}

// ---------------------------------------------------------------------------
// Health (unauthenticated)
// ---------------------------------------------------------------------------

app.get("/",       async () => ({ status: "ok", version: "1.0.0" }));
app.get("/health", async () => ({ status: "ok", version: "1.0.0" }));

// ---------------------------------------------------------------------------
// Proxy routes  (POST /v1/* and POST /openai/v1/*)
// ---------------------------------------------------------------------------

await registerProxyRoutes(app);

// ---------------------------------------------------------------------------
// Mock endpoint — test the full pipeline without hitting real APIs
//
// POST /test/mock-request
// Body (all optional):
//   model              string   default "claude-sonnet-4-20250514"
//   input_tokens       number   default 100
//   output_tokens      number   default 50
//   cache_read_tokens  number   default 0
//   cache_write_tokens number   default 0
//   session_id         string   default null
//   provider           string   default "anthropic"
// ---------------------------------------------------------------------------

interface MockBody {
  model?:              string;
  input_tokens?:       number;
  output_tokens?:      number;
  cache_read_tokens?:  number;
  cache_write_tokens?: number;
  session_id?:         string;
  provider?:           "anthropic" | "openai" | "google";
}

app.post("/test/mock-request", async (req, reply) => {
  // Disabled in production — this endpoint bypasses real API calls and creates
  // synthetic data. Expose it only during development/testing.
  if (config.NODE_ENV === "production") {
    return reply.status(404).send({ error: "Not found" });
  }

  const b = (req.body ?? {}) as MockBody;

  const model            = b.model             ?? "claude-sonnet-4-20250514";
  const inputTokens      = b.input_tokens       ?? 100;
  const outputTokens     = b.output_tokens       ?? 50;
  const cacheReadTokens  = b.cache_read_tokens   ?? 0;
  const cacheWriteTokens = b.cache_write_tokens  ?? 0;
  const sessionId        = b.session_id          ?? null;
  // Auto-detect provider from model name when not explicitly supplied.
  // gpt-* / o1-* / o3-* → openai; everything else → anthropic.
  const provider         = b.provider ?? (
    /^(gpt-|o1-|o3-)/.test(model) ? "openai" : "anthropic"
  );

  const costUsd = calculateCost(
    model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  );

  const requestId = getQueries().insertRequest({
    timestamp:          Date.now(),
    provider,
    model,
    input_tokens:       inputTokens,
    output_tokens:      outputTokens,
    cache_read_tokens:  cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    cost_usd:           costUsd,
    session_id:         sessionId,
    request_type:       "chat",
    duration_ms:        1,
    blocked:            0,
  });

  logger.info(
    { requestId, model, costUsd, inputTokens, outputTokens },
    "Mock request logged",
  );

  // Looks like a real Anthropic Messages API response so OpenClaw-compatible
  // tooling can process it without modification.
  return reply.send({
    id:            `msg_mock_${requestId}`,
    type:          "message",
    role:          "assistant",
    content:       [{ type: "text", text: "This is a mock response from TokPinch. The full pipeline is working." }],
    model,
    stop_reason:   "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens:                inputTokens,
      output_tokens:               outputTokens,
      cache_read_input_tokens:     cacheReadTokens,
      cache_creation_input_tokens: cacheWriteTokens,
    },
    // TokPinch-only metadata — not present in real Anthropic responses
    _tokpinch: {
      requestId,
      costUsd: Number(costUsd.toFixed(6)),
      logged:  true,
    },
  });
});

// ---------------------------------------------------------------------------
// Dashboard auth (POST /api/auth/login — rate-limited to 5/min)
// ---------------------------------------------------------------------------

registerAuthRoutes(app);

// ---------------------------------------------------------------------------
// Dashboard API routes (all behind JWT auth)
// ---------------------------------------------------------------------------

registerApiRoutes(app);

// ---------------------------------------------------------------------------
// WebSocket live feed (/ws?token=<jwt>)
// ---------------------------------------------------------------------------

await registerWebSocket(app);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  try {
    initDb(config.DB_PATH);
    initializeBudgets();
    initAlerter();
    startScheduler();
    loadRoutingRules();

    await app.listen({ port: config.PORT, host: "0.0.0.0" });

    logger.info(
      `\u{1F6E1}\uFE0F  TokPinch v1.0.0 \u2014 Proxy running on port ${config.PORT}`,
    );
    logger.info(
      {
        port:          config.PORT,
        logLevel:      config.LOG_LEVEL,
        smartRouting:  config.SMART_ROUTING_ENABLED,
        loopDetection: config.LOOP_DETECTION_ENABLED,
        budgetDaily:   config.BUDGET_DAILY   ?? "unlimited",
        budgetMonthly: config.BUDGET_MONTHLY ?? "unlimited",
        dbPath:        config.DB_PATH,
      },
      "Configuration loaded",
    );
  } catch (err) {
    logger.error(err, "Failed to start server");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutdown signal received — closing server gracefully");
  try {
    await app.close();
    stopScheduler();
    closeDb();
    logger.info("Server closed");
    process.exit(0);
  } catch (err) {
    logger.error(err, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await start();
