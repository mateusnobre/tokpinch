import { config } from "../config.js";
import { getQueries } from "../db/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("middleware");

// Requests per window per session before we call it a loop
const LOOP_THRESHOLD  = 30;
const LOOP_WINDOW_MS  = 60_000; // 1 minute

export interface MiddlewareResult {
  blocked:  boolean;
  reason?:  "budget_exceeded" | "loop_detected";
  message?: string;
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

export function checkBudget(estimatedCostUsd: number): MiddlewareResult {
  const queries = getQueries();
  const today   = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (config.BUDGET_DAILY) {
    const row          = queries.getDailyCost(today);
    const currentSpend = row?.total_cost ?? 0;

    if (currentSpend + estimatedCostUsd > config.BUDGET_DAILY) {
      log.warn(
        { currentSpend, budget: config.BUDGET_DAILY },
        "Daily budget exceeded",
      );
      return {
        blocked: true,
        reason:  "budget_exceeded",
        message: `Daily budget of $${config.BUDGET_DAILY.toFixed(2)} has been reached ` +
                 `($${currentSpend.toFixed(4)} spent today). ` +
                 `Check your TokPinch dashboard to increase the limit.`,
      };
    }
  }

  if (config.BUDGET_MONTHLY) {
    const yearMonth    = today.slice(0, 7); // YYYY-MM
    const row          = queries.getMonthlyCost(yearMonth);
    const currentSpend = row?.total_cost ?? 0;

    if (currentSpend + estimatedCostUsd > config.BUDGET_MONTHLY) {
      log.warn(
        { currentSpend, budget: config.BUDGET_MONTHLY },
        "Monthly budget exceeded",
      );
      return {
        blocked: true,
        reason:  "budget_exceeded",
        message: `Monthly budget of $${config.BUDGET_MONTHLY.toFixed(2)} has been reached ` +
                 `($${currentSpend.toFixed(4)} spent this month). ` +
                 `Check your TokPinch dashboard to increase the limit.`,
      };
    }
  }

  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Loop detection
// ---------------------------------------------------------------------------

export function checkLoopDetection(sessionId: string | null): MiddlewareResult {
  if (!config.LOOP_DETECTION_ENABLED || !sessionId) return { blocked: false };

  const queries     = getQueries();
  const windowStart = Date.now() - LOOP_WINDOW_MS;

  // Count unblocked requests from this session in the rolling window
  const recentCount = queries
    .getRequestsByTimeRange(windowStart, Date.now())
    .filter((r) => r.session_id === sessionId && r.blocked === 0)
    .length;

  if (recentCount >= LOOP_THRESHOLD) {
    log.warn(
      { sessionId, recentCount, windowMs: LOOP_WINDOW_MS },
      "Loop detected — blocking request",
    );
    return {
      blocked: true,
      reason:  "loop_detected",
      message: `Loop detected: session made ${recentCount} requests in the last ` +
               `${LOOP_WINDOW_MS / 1000}s (threshold: ${LOOP_THRESHOLD}). ` +
               `If this is intentional, disable loop detection in your TokPinch config.`,
    };
  }

  return { blocked: false };
}
