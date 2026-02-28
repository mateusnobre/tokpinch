/**
 * Budget period scheduler — no external cron dependency.
 *
 * Ticks every 60 seconds and detects day/month rollovers by comparing the
 * current date string to what it was on the previous tick.
 *
 * Also fires the daily digest at the user-configured UTC time (default 09:00).
 */

import { createLogger } from "../utils/logger.js";
import {
  resetDailyBudget,
  resetMonthlyBudget,
  getBudgetStatus,
} from "./budgetManager.js";
import { sendDailyDigest, getAlertPreferences } from "./alerter.js";
import { getQueries } from "../db/index.js";

const log = createLogger("scheduler");

const TICK_MS = 60_000; // 1 minute

let intervalId:       NodeJS.Timeout | null = null;
let lastDay:          string = "";
let lastMonth:        string = "";
let _digestSentDate:  string = ""; // YYYY-MM-DD of the last sent digest

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------

function maybeSendDigest(now: Date, today: string): void {
  if (_digestSentDate === today) return; // already sent today

  const { digestTimeUtc } = getAlertPreferences();
  const currentTimeUtc = now.toISOString().slice(11, 16); // "HH:MM"

  if (currentTimeUtc < digestTimeUtc) return; // not yet

  // Build DigestData from DB and current budget state
  try {
    const row = getQueries().getDailyCost(today);
    if (!row) return;

    // Top models for today (unix range: start of day to now)
    const startOfDayMs = new Date(today + "T00:00:00.000Z").getTime();
    const topModels    = getQueries()
      .getCostByModel(startOfDayMs, Date.now())
      .slice(0, 5)
      .map((m) => ({ model: m.model, cost: m.cost, request_count: m.request_count }));

    const { daily, monthly } = getBudgetStatus();

    sendDailyDigest({
      date:         today,
      totalCost:    row.total_cost,
      requestCount: row.request_count,
      blockedCount: row.blocked_count,
      topModels,
      dailyBudget:   daily
        ? { currentSpend: daily.currentSpend, limitUsd: daily.limitUsd, status: daily.status }
        : null,
      monthlyBudget: monthly
        ? { currentSpend: monthly.currentSpend, limitUsd: monthly.limitUsd, status: monthly.status }
        : null,
    });

    _digestSentDate = today;
    log.info({ date: today, digestTime: digestTimeUtc }, "Daily digest sent");
  } catch (err) {
    log.error({ err, date: today }, "Failed to send daily digest");
  }
}

// ---------------------------------------------------------------------------
// Warning checks
// ---------------------------------------------------------------------------

function checkWarningThresholds(): void {
  const { daily, monthly } = getBudgetStatus();

  if (daily?.status === "warning") {
    const pct = ((daily.currentSpend / daily.limitUsd) * 100).toFixed(1);
    log.warn(
      { spend: daily.currentSpend.toFixed(4), limit: daily.limitUsd, pct },
      "Daily budget warning threshold reached",
    );
  }

  if (monthly?.status === "warning") {
    const pct = ((monthly.currentSpend / monthly.limitUsd) * 100).toFixed(1);
    log.warn(
      { spend: monthly.currentSpend.toFixed(4), limit: monthly.limitUsd, pct },
      "Monthly budget warning threshold reached",
    );
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

function tick(): void {
  const now       = new Date();
  const today     = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const thisMonth = today.slice(0, 7);              // YYYY-MM

  // Day rollover
  if (lastDay && lastDay !== today) {
    // Send digest for the day that just ended
    maybeSendDigest(new Date(lastDay + "T23:59:00.000Z"), lastDay);
    resetDailyBudget(today);
    // Reset digest tracking for the new day
    if (_digestSentDate === lastDay) {
      // already sent for lastDay — new day starts fresh
    }
  }
  lastDay = today;

  // Month rollover (only fires on the 1st of the month)
  if (lastMonth && lastMonth !== thisMonth) {
    resetMonthlyBudget(today.slice(0, 7) + "-01");
  }
  lastMonth = thisMonth;

  // Daily digest check (runs every tick until sent)
  maybeSendDigest(now, today);

  // Warning threshold check (runs every tick)
  checkWarningThresholds();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startScheduler(): void {
  const now   = new Date();
  lastDay     = now.toISOString().slice(0, 10);
  lastMonth   = lastDay.slice(0, 7);

  intervalId = setInterval(tick, TICK_MS);
  intervalId.unref?.(); // don't keep process alive in tests
  log.info({ tickMs: TICK_MS }, "Budget scheduler started");
}

export function stopScheduler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info("Budget scheduler stopped");
  }
}
