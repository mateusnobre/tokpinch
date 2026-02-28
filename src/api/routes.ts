/**
 * Dashboard REST API routes — all prefixed with /api, all require JWT auth.
 *
 * Endpoint map:
 *
 *  GET  /api/costs/today            — today's aggregate cost row
 *  GET  /api/costs/daily?days=30    — N most recent daily summaries
 *  GET  /api/costs/hourly?date=...  — 24 hourly data points for a single day
 *  GET  /api/costs/by-model         — cost breakdown per model
 *  GET  /api/costs/by-session       — cost breakdown per session
 *  GET  /api/costs/summary          — today / week / month / all-time / avg
 *
 *  GET  /api/budgets                — current budget status
 *  PUT  /api/budgets                — update daily and/or monthly limits
 *  POST /api/budgets/:type/override — resume a paused budget
 *
 *  GET  /api/requests               — paginated request history
 *  GET  /api/requests/live          — last 10 requests (polling)
 *
 *  GET  /api/alerts                 — recent alerts
 *
 *  GET  /api/status                 — server health + uptime
 *  GET  /api/routing-stats          — smart routing savings
 *  GET  /api/settings               — current config (secrets redacted)
 *  GET  /api/settings/alerts        — alert channel preferences
 *  POST /api/settings/alerts        — update alert channel preferences
 */

import fs                    from "node:fs";
import os                    from "node:os";
import path                  from "node:path";
import { z }                 from "zod";
import type { FastifyInstance } from "fastify";
import { config }            from "../config.js";
import { getQueries }        from "../db/index.js";
import { getBudgetStatus, setLimit, overridePause } from "../services/budgetManager.js";
import { getAlertPreferences, setAlertPreferences } from "../services/alerter.js";
import { getRoutingRules }   from "../proxy/middleware/modelRouter.js";
import { broadcast }         from "./websocket.js";
import { verifyToken }       from "./auth.js";
import { createLogger }      from "../utils/logger.js";

const log = createLogger("api");

// ---------------------------------------------------------------------------
// Common preHandler — all routes below require a valid JWT
// ---------------------------------------------------------------------------

const auth = { preHandler: verifyToken };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** ISO date string for `daysAgo` days before today. */
function daysAgoStr(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Start-of-day Unix ms for a YYYY-MM-DD string. */
function startOfDayMs(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getTime();
}

/** End-of-day Unix ms for a YYYY-MM-DD string. */
function endOfDayMs(dateStr: string): number {
  return new Date(`${dateStr}T23:59:59.999Z`).getTime();
}

/** Parse a Unix-ms query param; falls back to the provided default. */
function parseMs(raw: string | undefined, defaultMs: number): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : defaultMs;
}

/**
 * Redact a secret string for display in /api/settings.
 * Keeps the prefix (up to the first 8 chars) and the last 4 chars,
 * masking everything in between.
 */
function redact(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 8)}...[redacted]...${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const TimeRangeQuery = z.object({
  start: z.string().optional(),
  end:   z.string().optional(),
});

const DaysQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const DateQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
    .optional(),
});

const PaginationQuery = z.object({
  limit:  z.coerce.number().int().min(1).max(5000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const AlertsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

const UpdateBudgetsBody = z.object({
  daily:   z.number().positive().optional(),
  monthly: z.number().positive().optional(),
}).refine(
  (b) => b.daily !== undefined || b.monthly !== undefined,
  { message: "At least one of daily or monthly must be provided" },
);

const BudgetTypeParam = z.object({
  type: z.enum(["daily", "monthly"]),
});

const AlertPreferencesBody = z.object({
  telegramEnabled: z.boolean().optional(),
  emailEnabled:    z.boolean().optional(),
  digestTimeUtc:   z
    .string()
    .regex(/^\d{2}:\d{2}$/, "digestTimeUtc must be HH:MM")
    .optional(),
}).refine(
  (b) => b.telegramEnabled !== undefined || b.emailEnabled !== undefined || b.digestTimeUtc !== undefined,
  { message: "At least one field must be provided" },
);

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerApiRoutes(app: FastifyInstance): void {

  // -------------------------------------------------------------------------
  // GET /api/costs/today
  // -------------------------------------------------------------------------
  app.get("/api/costs/today", auth, async (_req, reply) => {
    const today = todayStr();
    const row   = getQueries().getDailyCost(today);
    return reply.send(row ?? {
      date:               today,
      total_cost:         0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      request_count:      0,
      blocked_count:      0,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/costs/daily?days=30
  // -------------------------------------------------------------------------
  app.get("/api/costs/daily", auth, async (req, reply) => {
    const parsed = DaysQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const { days } = parsed.data;

    const rows = [];
    for (let i = 0; i < days; i++) {
      const dateStr = daysAgoStr(i);
      const row     = getQueries().getDailyCost(dateStr);
      rows.push(row ?? {
        date:                dateStr,
        total_cost:          0,
        total_input_tokens:  0,
        total_output_tokens: 0,
        request_count:       0,
        blocked_count:       0,
      });
    }
    // Return oldest-first so charts can plot left-to-right
    rows.reverse();
    return reply.send(rows);
  });

  // -------------------------------------------------------------------------
  // GET /api/costs/hourly?date=YYYY-MM-DD
  // -------------------------------------------------------------------------
  app.get("/api/costs/hourly", auth, async (req, reply) => {
    const parsed = DateQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const date = parsed.data.date ?? todayStr();
    const rows = getQueries().getHourlyCosts(date);

    // Fill in hours with zero activity so the dashboard always gets 24 points
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    const full   = Array.from({ length: 24 }, (_, h) =>
      byHour.get(h) ?? { hour: h, cost: 0, input_tokens: 0, output_tokens: 0, request_count: 0 },
    );
    return reply.send({ date, hours: full });
  });

  // -------------------------------------------------------------------------
  // GET /api/costs/by-model?start=<ms>&end=<ms>
  // -------------------------------------------------------------------------
  app.get("/api/costs/by-model", auth, async (req, reply) => {
    const parsed = TimeRangeQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const now   = Date.now();
    const start = parseMs(parsed.data.start, now - 30 * 86_400_000);
    const end   = parseMs(parsed.data.end,   now);
    return reply.send(getQueries().getCostByModel(start, end));
  });

  // -------------------------------------------------------------------------
  // GET /api/costs/by-session?start=<ms>&end=<ms>
  // -------------------------------------------------------------------------
  app.get("/api/costs/by-session", auth, async (req, reply) => {
    const parsed = TimeRangeQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const now   = Date.now();
    const start = parseMs(parsed.data.start, now - 30 * 86_400_000);
    const end   = parseMs(parsed.data.end,   now);
    return reply.send(getQueries().getCostBySession(start, end));
  });

  // -------------------------------------------------------------------------
  // GET /api/costs/summary
  // -------------------------------------------------------------------------
  app.get("/api/costs/summary", auth, async (_req, reply) => {
    const today     = todayStr();
    const yearMonth = today.slice(0, 7);

    const todayRow   = getQueries().getDailyCost(today);
    const monthRow   = getQueries().getMonthlyCost(yearMonth);
    const allTimeRow = getQueries().getAllTimeCost();

    // Week = last 7 days including today
    let weekCost = 0;
    for (let i = 0; i < 7; i++) {
      const row = getQueries().getDailyCost(daysAgoStr(i));
      weekCost += row?.total_cost ?? 0;
    }

    const allTimeCost = allTimeRow?.total_cost ?? 0;
    const dayCount    = Math.max(1, getQueries().countActiveDays());
    const avgDaily    = allTimeCost / dayCount;

    return reply.send({
      today:      todayRow?.total_cost  ?? 0,
      this_week:  weekCost,
      this_month: monthRow?.total_cost  ?? 0,
      all_time:   allTimeCost,
      avg_daily:  avgDaily,
      // Pass through full row details for dashboard context
      today_detail:    todayRow    ?? null,
      month_detail:    monthRow    ?? null,
      all_time_detail: allTimeRow  ?? null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/budgets
  // -------------------------------------------------------------------------
  app.get("/api/budgets", auth, async (_req, reply) => {
    return reply.send(getBudgetStatus());
  });

  // -------------------------------------------------------------------------
  // PUT /api/budgets
  // -------------------------------------------------------------------------
  app.put("/api/budgets", auth, async (req, reply) => {
    const parsed = UpdateBudgetsBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const { daily, monthly } = parsed.data;

    if (daily   !== undefined) setLimit("daily",   daily);
    if (monthly !== undefined) setLimit("monthly", monthly);

    const status = getBudgetStatus();
    broadcast({ type: "budget", data: status });
    log.info({ daily, monthly }, "Budget limits updated via API");
    return reply.send(status);
  });

  // -------------------------------------------------------------------------
  // POST /api/budgets/:type/override
  // -------------------------------------------------------------------------
  app.post<{ Params: { type: string } }>(
    "/api/budgets/:type/override",
    auth,
    async (req, reply) => {
      const parsed = BudgetTypeParam.safeParse(req.params);
      if (!parsed.success) {
        return reply.status(400).send({ error: "type must be 'daily' or 'monthly'" });
      }
      overridePause(parsed.data.type);
      const status = getBudgetStatus();
      broadcast({ type: "budget", data: status });
      log.info({ budgetType: parsed.data.type }, "Budget override applied via API");
      return reply.send(status);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/requests?limit=50&offset=0
  // -------------------------------------------------------------------------
  app.get("/api/requests", auth, async (req, reply) => {
    const parsed = PaginationQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const { limit, offset } = parsed.data;
    const rows = getQueries().getPaginatedRequests(limit, offset);
    return reply.send({ limit, offset, rows });
  });

  // -------------------------------------------------------------------------
  // GET /api/requests/live — last 10 requests for polling live feed
  // -------------------------------------------------------------------------
  app.get("/api/requests/live", auth, async (_req, reply) => {
    return reply.send(getQueries().getRecentRequests(10));
  });

  // -------------------------------------------------------------------------
  // GET /api/alerts?limit=20
  // -------------------------------------------------------------------------
  app.get("/api/alerts", auth, async (req, reply) => {
    const parsed = AlertsQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    return reply.send(getQueries().getAlerts(parsed.data.limit));
  });

  // -------------------------------------------------------------------------
  // GET /api/status
  // -------------------------------------------------------------------------

  const _startedAt = Date.now();

  app.get("/api/status", auth, async (_req, reply) => {
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(path.resolve(config.DB_PATH)).size;
    } catch {
      // DB path may not be accessible (e.g. in-memory) — ignore
    }

    return reply.send({
      status:        "ok",
      version:       "1.0.0",
      uptimeMs:      Date.now() - _startedAt,
      platform:      os.platform(),
      nodeVersion:   process.version,
      dbSizeBytes,
      smartRouting:  config.SMART_ROUTING_ENABLED,
      loopDetection: config.LOOP_DETECTION_ENABLED,
      budgetDaily:   config.BUDGET_DAILY   ?? null,
      budgetMonthly: config.BUDGET_MONTHLY ?? null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/routing-stats?start=<ms>&end=<ms>
  // -------------------------------------------------------------------------
  app.get("/api/routing-stats", auth, async (req, reply) => {
    const parsed = TimeRangeQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const now   = Date.now();
    const start = parseMs(parsed.data.start, now - 30 * 86_400_000);
    const end   = parseMs(parsed.data.end,   now);
    return reply.send({
      enabled: config.SMART_ROUTING_ENABLED,
      rules:   getRoutingRules(),
      stats:   getQueries().getRoutingStats(start, end),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/settings — current config, secrets redacted
  // -------------------------------------------------------------------------
  app.get("/api/settings", auth, async (_req, reply) => {
    return reply.send({
      port:          config.PORT,
      nodeEnv:       config.NODE_ENV,
      logLevel:      config.LOG_LEVEL,
      // API keys — redact to first 8 chars + last 4
      anthropicApiKey: redact(config.ANTHROPIC_API_KEY),
      openaiApiKey:    redact(config.OPENAI_API_KEY),
      // Auth — never expose
      dashboardPassword: "[redacted]",
      jwtSecret:         "[redacted]",
      // Budgets
      budgetDaily:   config.BUDGET_DAILY   ?? null,
      budgetMonthly: config.BUDGET_MONTHLY ?? null,
      // Alerts
      alertTelegramConfigured: !!config.ALERT_TELEGRAM_TOKEN,
      alertEmailConfigured:    !!config.ALERT_EMAIL_TO,
      // Feature flags
      smartRoutingEnabled:  config.SMART_ROUTING_ENABLED,
      loopDetectionEnabled: config.LOOP_DETECTION_ENABLED,
      loopMaxRpm:           config.LOOP_MAX_RPM,
      loopCooldownSeconds:  config.LOOP_COOLDOWN_SECONDS,
      // Storage
      dbPath: config.DB_PATH,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/settings/alerts — retrieve current alert preferences
  // -------------------------------------------------------------------------
  app.get("/api/settings/alerts", auth, async (_req, reply) => {
    return reply.send(getAlertPreferences());
  });

  // -------------------------------------------------------------------------
  // POST /api/settings/alerts — update alert channel preferences
  // -------------------------------------------------------------------------
  app.post("/api/settings/alerts", auth, async (req, reply) => {
    const parsed = AlertPreferencesBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten().fieldErrors });
    }
    const updated = setAlertPreferences(parsed.data);
    log.info(parsed.data, "Alert preferences updated via API");
    return reply.send(updated);
  });

  log.info("API routes registered");
}
