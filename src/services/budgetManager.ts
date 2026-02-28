/**
 * Budget Manager — the core of TokPinch's spending enforcement.
 *
 * Design decisions:
 *
 * 1. In-memory state is the source of truth for fast, synchronous checks.
 *    It is loaded from SQLite on startup and written back after every change.
 *
 * 2. Atomicity: Node.js is single-threaded. checkBudget() both reads AND
 *    reserves the estimated cost in the same synchronous call. Because there
 *    is no `await` between the read and the reserve, two concurrent requests
 *    cannot both pass a budget that only has room for one — the event loop
 *    serialises them.
 *
 * 3. After the real API responds, call recordActualSpend(estimatedCost,
 *    actualCost) to adjust the reservation with the real token counts.
 *    If the API call fails, call recordActualSpend(estimatedCost, 0) to refund.
 */

import fs   from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { getQueries } from "../db/index.js";
import { createLogger } from "../utils/logger.js";
import { queueAlert } from "./alerter.js";

const log = createLogger("budget");

// ---------------------------------------------------------------------------
// Budget config persistence (data/budget-config.json)
// Survives server restarts for limits set via the dashboard API.
// Priority: env vars > JSON file > null
// ---------------------------------------------------------------------------

const BUDGET_CONFIG_FILE = path.resolve(process.cwd(), "data/budget-config.json");

interface BudgetConfig {
  daily?:   number;
  monthly?: number;
}

function readBudgetConfig(): BudgetConfig {
  // Skip disk reads in test mode — the JSON file may contain real production data
  // that would pollute tests expecting "no limits configured".
  if (config.NODE_ENV === "test") return {};
  try {
    const raw = fs.readFileSync(BUDGET_CONFIG_FILE, "utf8");
    return JSON.parse(raw) as BudgetConfig;
  } catch {
    return {};
  }
}

function writeBudgetConfig(cfg: BudgetConfig): void {
  try {
    fs.mkdirSync(path.dirname(BUDGET_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(BUDGET_CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch (err) {
    log.error({ err }, "Failed to write budget-config.json");
  }
}

/** Merge a single limit update into the JSON config file. */
function persistBudgetConfigLimit(type: "daily" | "monthly", limitUsd: number): void {
  const cfg = readBudgetConfig();
  if (type === "daily") cfg.daily = limitUsd; else cfg.monthly = limitUsd;
  writeBudgetConfig(cfg);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BudgetStatus = "active" | "warning" | "paused" | "override";

export interface BudgetState {
  id:           string;
  type:         "daily" | "monthly";
  limitUsd:     number;
  currentSpend: number;
  status:       BudgetStatus;
  periodStart:  string;
  periodEnd:    string;
}

export interface CheckResult {
  allowed:      boolean;
  reason?:      string;
  remainingUsd: number;
  dailyStatus?:   BudgetStatus;
  monthlyStatus?: BudgetStatus;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let _daily:   BudgetState | null = null;
let _monthly: BudgetState | null = null;

const WARNING_THRESHOLD = 0.80; // 80 %

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function lastDayOfMonth(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return new Date(y, m, 0).toISOString().slice(0, 10);
}

function computeStatus(spend: number, limit: number, current: BudgetStatus): BudgetStatus {
  // Override is sticky — only a period reset clears it.
  // Must be checked before the spend >= limit guard so an over-limit
  // reconciliation (actual > estimated) doesn't flip override → paused.
  if (current === "override")              return "override";
  if (spend >= limit)                      return "paused";
  if (spend >= limit * WARNING_THRESHOLD)  return "warning";
  // Don't downgrade an active warning — only resets do that
  if (current === "warning")               return "warning";
  return "active";
}

/** Persist in-memory state to SQLite (synchronous — budget writes are rare). */
function persist(b: BudgetState): void {
  try {
    getQueries().upsertBudget({
      id:           b.id,
      type:         b.type,
      limitUsd:     b.limitUsd,
      currentSpend: b.currentSpend,
      status:       b.status,
      periodStart:  b.periodStart,
      periodEnd:    b.periodEnd,
    });
  } catch (err) {
    log.error({ err, budgetType: b.type }, "Failed to persist budget state");
  }
}

/**
 * Fire an external alert when a budget status transitions to warning or paused.
 * dedupKey is period-scoped so at most one alert fires per budget period.
 */
function maybeAlert(b: BudgetState, oldStatus: BudgetStatus): void {
  if (b.status === oldStatus) return;
  const period    = b.type === "daily" ? "Daily" : "Monthly";
  const pct       = ((b.currentSpend / b.limitUsd) * 100).toFixed(0);
  const resetText = b.type === "daily" ? "midnight UTC" : "1st of next month";

  if (b.status === "warning") {
    const msg = `⚠️ TokPinch: ${period} budget ${pct}% used. $${b.currentSpend.toFixed(4)} of $${b.limitUsd.toFixed(4)} spent.`;
    queueAlert("budget_warning", msg, `budget_warning-${b.type}-${b.periodStart}`);
  } else if (b.status === "paused") {
    const msg = `🛑 TokPinch: ${period} budget exceeded! $${b.currentSpend.toFixed(4)} spent. Requests paused until ${resetText}.`;
    queueAlert("budget_exceeded", msg, `budget_exceeded-${b.type}-${b.periodStart}`);
  }
}

function blockedResult(
  b: BudgetState,
  remainingUsd: number,
): CheckResult {
  const period = b.type === "daily" ? "day" : "month";
  const reset  = b.type === "daily"
    ? "midnight UTC"
    : `the 1st of next month`;
  return {
    allowed: false,
    reason: `${b.type.charAt(0).toUpperCase() + b.type.slice(1)} budget of `
          + `$${b.limitUsd.toFixed(2)} exceeded `
          + `($${b.currentSpend.toFixed(4)} spent this ${period}). `
          + `Resets at ${reset} or resume manually from the dashboard.`,
    remainingUsd: Math.max(0, remainingUsd),
    dailyStatus:   _daily?.status,
    monthlyStatus: _monthly?.status,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load (or create) budget records for the current periods.
 * Must be called once on server startup, after initDb().
 */
export function initializeBudgets(): void {
  // Always reset in-memory state — important for test isolation
  _daily   = null;
  _monthly = null;

  // Resolve effective limits: env vars take priority, then JSON file, then null.
  const saved = readBudgetConfig();
  const effectiveDaily   = config.BUDGET_DAILY   ?? saved.daily;
  const effectiveMonthly = config.BUDGET_MONTHLY ?? saved.monthly;

  if (!effectiveDaily && !effectiveMonthly) {
    log.debug("No budgets configured — skipping budget initialization");
    return;
  }

  const today = todayStr();

  if (effectiveDaily) {
    const row = getQueries().getBudgetForPeriod("daily");
    if (row && row.period_start === today) {
      _daily = {
        id:           row.id,
        type:         "daily",
        limitUsd:     row.limit_usd,
        currentSpend: row.current_spend,
        status:       row.status as BudgetStatus,
        periodStart:  row.period_start,
        periodEnd:    row.period_end,
      };
      log.info(
        { spend: _daily.currentSpend.toFixed(4), limit: _daily.limitUsd, status: _daily.status },
        "Daily budget loaded",
      );
    } else {
      _daily = {
        id:           nanoid(),
        type:         "daily",
        limitUsd:     effectiveDaily,
        currentSpend: 0,
        status:       "active",
        periodStart:  today,
        periodEnd:    today,
      };
      persist(_daily);
      log.info({ date: today, limit: effectiveDaily }, "Daily budget created");
    }
  }

  if (effectiveMonthly) {
    const row = getQueries().getBudgetForPeriod("monthly");
    const firstOfMonth = today.slice(0, 7) + "-01";

    if (row && row.period_start === firstOfMonth) {
      _monthly = {
        id:           row.id,
        type:         "monthly",
        limitUsd:     row.limit_usd,
        currentSpend: row.current_spend,
        status:       row.status as BudgetStatus,
        periodStart:  row.period_start,
        periodEnd:    row.period_end,
      };
      log.info(
        { spend: _monthly.currentSpend.toFixed(4), limit: _monthly.limitUsd, status: _monthly.status },
        "Monthly budget loaded",
      );
    } else {
      _monthly = {
        id:           nanoid(),
        type:         "monthly",
        limitUsd:     effectiveMonthly,
        currentSpend: 0,
        status:       "active",
        periodStart:  firstOfMonth,
        periodEnd:    lastDayOfMonth(today),
      };
      persist(_monthly);
      log.info({ month: today.slice(0, 7), limit: effectiveMonthly }, "Monthly budget created");
    }
  }
}

/**
 * Atomically check and reserve the estimated cost.
 *
 * If this returns { allowed: true }, the estimated cost has already been
 * debited from the in-memory budget. Follow up with recordActualSpend() to
 * adjust the reservation once the real token counts are known.
 *
 * If this returns { allowed: false }, NO cost was reserved.
 */
export function checkBudget(estimatedCost: number): CheckResult {
  if (!_daily && !_monthly) {
    return { allowed: true, remainingUsd: Infinity };
  }

  // --- Daily budget check + reserve ---
  if (_daily) {
    const { status, currentSpend, limitUsd } = _daily;

    if (status === "paused") {
      return blockedResult(_daily, limitUsd - currentSpend);
    }

    if (status !== "override" && currentSpend + estimatedCost > limitUsd) {
      // Transition to PAUSED — no reservation made
      _daily.status = "paused";
      persist(_daily);
      log.warn(
        { spend: currentSpend, cost: estimatedCost, limit: limitUsd },
        "Daily budget limit reached — pausing",
      );
      maybeAlert(_daily, status);
      return blockedResult(_daily, limitUsd - currentSpend);
    }

    // Reserve: debit estimated cost immediately (atomic in single-threaded Node.js)
    _daily.currentSpend += estimatedCost;
    const newStatus = computeStatus(_daily.currentSpend, limitUsd, status);
    if (newStatus !== status) {
      _daily.status = newStatus;
      log.warn(
        { status: newStatus, spend: _daily.currentSpend, limit: limitUsd },
        "Daily budget status changed",
      );
      maybeAlert(_daily, status);
    }
    persist(_daily);
  }

  // --- Monthly budget check + reserve ---
  if (_monthly) {
    const { status, currentSpend, limitUsd } = _monthly;

    if (status === "paused") {
      // Refund the daily reservation if monthly blocks us
      if (_daily) {
        _daily.currentSpend = Math.max(0, _daily.currentSpend - estimatedCost);
        _daily.status = computeStatus(_daily.currentSpend, _daily.limitUsd, _daily.status);
        persist(_daily);
      }
      return blockedResult(_monthly, limitUsd - currentSpend);
    }

    if (status !== "override" && currentSpend + estimatedCost > limitUsd) {
      _monthly.status = "paused";
      persist(_monthly);
      maybeAlert(_monthly, status);
      // Refund daily reservation
      if (_daily) {
        _daily.currentSpend = Math.max(0, _daily.currentSpend - estimatedCost);
        _daily.status = computeStatus(_daily.currentSpend, _daily.limitUsd, _daily.status);
        persist(_daily);
      }
      log.warn(
        { spend: currentSpend, cost: estimatedCost, limit: limitUsd },
        "Monthly budget limit reached — pausing",
      );
      return blockedResult(_monthly, limitUsd - currentSpend);
    }

    _monthly.currentSpend += estimatedCost;
    const newStatus = computeStatus(_monthly.currentSpend, limitUsd, status);
    if (newStatus !== status) {
      _monthly.status = newStatus;
      log.warn(
        { status: newStatus, spend: _monthly.currentSpend, limit: limitUsd },
        "Monthly budget status changed",
      );
      maybeAlert(_monthly, status);
    }
    persist(_monthly);
  }

  const dailyRemaining   = _daily   ? _daily.limitUsd   - _daily.currentSpend   : Infinity;
  const monthlyRemaining = _monthly ? _monthly.limitUsd - _monthly.currentSpend : Infinity;

  return {
    allowed:      true,
    remainingUsd: Math.min(dailyRemaining, monthlyRemaining),
    dailyStatus:   _daily?.status,
    monthlyStatus: _monthly?.status,
  };
}

/**
 * Adjust the budget reservation once the real API cost is known.
 * Pass estimatedCost = 0 and actualCost = 0 on API failure (full refund).
 */
export function recordActualSpend(estimatedCost: number, actualCost: number): void {
  const adjustment = actualCost - estimatedCost;
  if (Math.abs(adjustment) < 1e-9) return; // No meaningful difference

  if (_daily) {
    const prevDailyStatus = _daily.status;
    _daily.currentSpend = Math.max(0, _daily.currentSpend + adjustment);
    if (_daily.status !== "paused") {
      _daily.status = computeStatus(_daily.currentSpend, _daily.limitUsd, _daily.status);
      maybeAlert(_daily, prevDailyStatus);
    }
    persist(_daily);
  }

  if (_monthly) {
    const prevMonthlyStatus = _monthly.status;
    _monthly.currentSpend = Math.max(0, _monthly.currentSpend + adjustment);
    if (_monthly.status !== "paused") {
      _monthly.status = computeStatus(_monthly.currentSpend, _monthly.limitUsd, _monthly.status);
      maybeAlert(_monthly, prevMonthlyStatus);
    }
    persist(_monthly);
  }
}

/** Get a snapshot of current budget states (for dashboard / scheduler). */
export function getBudgetStatus(): {
  daily:   BudgetState | null;
  monthly: BudgetState | null;
} {
  return {
    daily:   _daily   ? { ..._daily }   : null,
    monthly: _monthly ? { ..._monthly } : null,
  };
}

/**
 * Reset the daily budget — called by the scheduler at midnight UTC.
 * @param newDate  YYYY-MM-DD of the new day
 */
export function resetDailyBudget(newDate: string): void {
  const limit = config.BUDGET_DAILY ?? readBudgetConfig().daily;
  if (!limit) return;

  _daily = {
    id:           nanoid(),
    type:         "daily",
    limitUsd:     limit,
    currentSpend: 0,
    status:       "active",
    periodStart:  newDate,
    periodEnd:    newDate,
  };
  persist(_daily);
  log.info({ date: newDate, limit }, "Daily budget reset");
}

/**
 * Reset the monthly budget — called by the scheduler on the 1st.
 * @param newDate  YYYY-MM-DD of the 1st of the new month
 */
export function resetMonthlyBudget(newDate: string): void {
  const limit = config.BUDGET_MONTHLY ?? readBudgetConfig().monthly;
  if (!limit) return;

  _monthly = {
    id:           nanoid(),
    type:         "monthly",
    limitUsd:     limit,
    currentSpend: 0,
    status:       "active",
    periodStart:  newDate,
    periodEnd:    lastDayOfMonth(newDate),
  };
  persist(_monthly);
  log.info({ month: newDate.slice(0, 7), limit }, "Monthly budget reset");
}

/**
 * Update the spending limit for an active budget period (from the dashboard).
 * The new limit is reflected immediately in-memory and persisted to SQLite.
 * Status is recomputed based on current spend vs new limit.
 */
export function setLimit(type: "daily" | "monthly", newLimitUsd: number): void {
  const b = type === "daily" ? _daily : _monthly;
  if (!b) {
    // No budget of this type loaded (e.g. none configured in env).
    // Create a minimal record so the dashboard can still set a limit.
    const today = todayStr();
    const newBudget: BudgetState = {
      id:           nanoid(),
      type,
      limitUsd:     newLimitUsd,
      currentSpend: 0,
      status:       "active",
      periodStart:  type === "daily" ? today : today.slice(0, 7) + "-01",
      periodEnd:    type === "daily" ? today : lastDayOfMonth(today),
    };
    if (type === "daily") _daily = newBudget; else _monthly = newBudget;
    persist(newBudget);
    persistBudgetConfigLimit(type, newLimitUsd);
    log.info({ type, newLimitUsd }, "Budget created via setLimit");
    return;
  }

  b.limitUsd = newLimitUsd;
  b.status   = computeStatus(b.currentSpend, newLimitUsd, b.status);
  persist(b);
  persistBudgetConfigLimit(type, newLimitUsd);
  log.info({ type, newLimitUsd, spend: b.currentSpend, status: b.status }, "Budget limit updated");
}

/**
 * Manually override a paused budget (from the dashboard).
 * Allows requests to continue despite being over the limit until next reset.
 */
export function overridePause(budgetType: "daily" | "monthly"): void {
  const b = budgetType === "daily" ? _daily : _monthly;
  if (!b) {
    log.warn({ budgetType }, "overridePause called but no budget record loaded");
    return;
  }
  b.status = "override";
  persist(b);
  log.info({ budgetType, spend: b.currentSpend, limit: b.limitUsd }, "Budget override activated");
}
