/**
 * Alerter — external notification delivery for TokPinch.
 *
 * Channels: Telegram (native fetch → Bot API) + Email (nodemailer SMTP).
 *
 * Design:
 *  - Preferences are loaded from data/alert-preferences.json at init and
 *    can be updated at runtime via setAlertPreferences().
 *  - queueAlert() inserts to the DB (audit trail, unconditional) then
 *    dispatches to all configured channels asynchronously — never blocks
 *    the proxy hot path.
 *  - Dedup: alerts with the same dedupKey are suppressed for a type-specific
 *    window. Budget alerts use a period-scoped key (once per period).
 *    Loop alerts use a session-scoped key (once every 5 min per session).
 *  - Retry: each channel is retried once after 60 s on first failure.
 *  - sendDailyDigest() formats a rich summary and calls queueAlert().
 */

import fs   from "node:fs";
import path from "node:path";
import nodemailer   from "nodemailer";
import type { Transporter } from "nodemailer";
import { config }       from "../config.js";
import { getQueries }   from "../db/index.js";
import { createLogger } from "../utils/logger.js";
import type { AlertRecord } from "../db/queries.js";

const log = createLogger("alerter");

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export interface AlertPreferences {
  telegramEnabled: boolean;
  emailEnabled:    boolean;
  /** "HH:MM" UTC — when to send the daily digest. Default: "09:00". */
  digestTimeUtc:   string;
}

const PREFS_FILE = path.resolve(process.cwd(), "data/alert-preferences.json");

let _prefs: AlertPreferences = {
  telegramEnabled: !!config.ALERT_TELEGRAM_TOKEN,
  emailEnabled:    !!(config.ALERT_EMAIL_TO && config.ALERT_EMAIL_SMTP_HOST),
  digestTimeUtc:   "09:00",
};

export function getAlertPreferences(): AlertPreferences {
  return { ..._prefs };
}

export function setAlertPreferences(
  partial: Partial<AlertPreferences>,
): AlertPreferences {
  _prefs = { ..._prefs, ...partial };
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(_prefs, null, 2), "utf8");
    log.info({ prefs: _prefs }, "Alert preferences saved");
  } catch (err) {
    log.warn({ err }, "Failed to persist alert preferences");
  }
  return { ..._prefs };
}

// ---------------------------------------------------------------------------
// Dedup — prevent alert storms for the same event
// ---------------------------------------------------------------------------

/** dedupKey → Unix ms when last delivered externally */
const _sent = new Map<string, number>();

/**
 * Per-type rate-limit windows (ms).
 * Budget alerts use very long windows — the period-scoped dedupKey already
 * ensures at most one alert per budget period.
 */
const RATE_LIMIT_MS: Record<AlertRecord["type"], number> = {
  budget_warning:   30 * 24 * 60 * 60_000, // 30 days (use period key)
  budget_exceeded:  30 * 24 * 60 * 60_000,
  loop_detected:         5 * 60_000,        // 5 minutes per session
  daily_digest:     23 * 60 * 60_000,       // 23 hours
};

function canSendExternal(
  dedupKey: string,
  type:     AlertRecord["type"],
): boolean {
  const last = _sent.get(dedupKey);
  if (last === undefined) return true;
  return Date.now() - last > RATE_LIMIT_MS[type];
}

// ---------------------------------------------------------------------------
// Channel clients (initialised once by initAlerter)
// ---------------------------------------------------------------------------

let _telegramReady:  boolean   = false;
let _emailTransport: Transporter | undefined;

export function initAlerter(): void {
  // Load persisted preferences (may override env-derived defaults)
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const raw = JSON.parse(
        fs.readFileSync(PREFS_FILE, "utf8"),
      ) as Partial<AlertPreferences>;
      _prefs = { ..._prefs, ...raw };
      log.info({ prefs: _prefs }, "Alert preferences loaded from disk");
    }
  } catch (err) {
    log.warn({ err }, "Failed to load alert preferences — using defaults");
  }

  // Telegram — uses native fetch (Node 18+), no third-party HTTP library needed
  if (config.ALERT_TELEGRAM_TOKEN && config.ALERT_TELEGRAM_CHAT_ID) {
    _telegramReady = true;
    log.info("Telegram alerting configured");
  }

  // Email (nodemailer SMTP)
  if (config.ALERT_EMAIL_TO && config.ALERT_EMAIL_SMTP_HOST) {
    try {
      _emailTransport = nodemailer.createTransport({
        host:   config.ALERT_EMAIL_SMTP_HOST,
        port:   config.ALERT_EMAIL_SMTP_PORT,
        secure: config.ALERT_EMAIL_SMTP_PORT === 465,
        auth:   config.ALERT_EMAIL_SMTP_USER
          ? { user: config.ALERT_EMAIL_SMTP_USER, pass: config.ALERT_EMAIL_SMTP_PASS ?? "" }
          : undefined,
      });
      log.info({ to: config.ALERT_EMAIL_TO }, "Email alerting configured");
    } catch (err) {
      log.warn({ err }, "Failed to initialise email transport");
    }
  }
}

// ---------------------------------------------------------------------------
// Channel send helpers
// ---------------------------------------------------------------------------

async function sendTelegram(message: string): Promise<void> {
  if (!_telegramReady || !config.ALERT_TELEGRAM_CHAT_ID || !_prefs.telegramEnabled) return;
  const url = `https://api.telegram.org/bot${config.ALERT_TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: config.ALERT_TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

function emailHtml(message: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TokPinch Alert</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:32px auto;color:#222;">
  <div style="border-left:4px solid #e74c3c;padding:16px 20px;background:#fdf9f9;border-radius:0 8px 8px 0;">
    <h2 style="margin:0 0 12px;font-size:17px;color:#c0392b;">TokPinch Alert</h2>
    <p style="margin:0;font-size:15px;line-height:1.6;">${escaped}</p>
  </div>
  <p style="font-size:11px;color:#999;margin-top:20px;">Sent by <strong>TokPinch</strong> &middot; LLM Cost Guard</p>
</body></html>`;
}

async function sendEmail(subject: string, message: string): Promise<void> {
  if (!_emailTransport || !config.ALERT_EMAIL_TO || !_prefs.emailEnabled) return;
  await _emailTransport.sendMail({
    from:    config.ALERT_EMAIL_SMTP_USER ?? "tokpinch@localhost",
    to:      config.ALERT_EMAIL_TO,
    subject: `TokPinch: ${subject}`,
    text:    message,
    html:    emailHtml(message),
  });
}

/**
 * Dispatch message to all configured channels.
 * Each channel is retried once after 60 s on failure.
 * Marks the DB record as delivered only when all channels succeeded.
 */
async function dispatchToChannels(
  alertId: string,
  type:    AlertRecord["type"],
  message: string,
): Promise<void> {
  const subject     = type.replace(/_/g, " ");
  let   tgFailed    = false;
  let   emailFailed = false;

  // --- First attempt ---
  try {
    await sendTelegram(message);
  } catch (err) {
    log.warn({ err, alertId }, "Telegram delivery failed — scheduling retry");
    tgFailed = true;
  }

  try {
    await sendEmail(subject, message);
  } catch (err) {
    log.warn({ err, alertId }, "Email delivery failed — scheduling retry");
    emailFailed = true;
  }

  if (!tgFailed && !emailFailed) {
    try { getQueries().markAlertDelivered(alertId); } catch { /* non-critical */ }
    return;
  }

  // --- Retry once after 60 s ---
  setTimeout(async () => {
    let retryOk = true;
    try {
      if (tgFailed)    await sendTelegram(message);
    } catch (err) {
      log.error({ err, alertId }, "Telegram retry failed — giving up");
      retryOk = false;
    }
    try {
      if (emailFailed) await sendEmail(subject, message);
    } catch (err) {
      log.error({ err, alertId }, "Email retry failed — giving up");
      retryOk = false;
    }
    if (retryOk) {
      try { getQueries().markAlertDelivered(alertId); } catch { /* non-critical */ }
    }
  }, 60_000).unref();
}

// ---------------------------------------------------------------------------
// Async queue — serialises DB insert + dispatch without blocking the caller
// ---------------------------------------------------------------------------

let _chain = Promise.resolve();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Queue an alert for DB storage and optional external delivery.
 *
 * @param type      Alert type — controls rate-limit window.
 * @param message   Plain-text message. Telegram receives it as-is (HTML OK).
 *                  Email wraps it in an HTML template.
 * @param dedupKey  If provided, external delivery is suppressed when the same
 *                  key was sent within the type's rate-limit window.
 *                  Use a period-scoped key for budget alerts, e.g.
 *                    "budget_warning-daily-2026-02-22"
 *                  or a session-scoped key for loop alerts, e.g.
 *                    "loop_detected-session-abc123"
 *                  Omit to always deliver externally (unique key per alert).
 */
export function queueAlert(
  type:      AlertRecord["type"],
  message:   string,
  dedupKey?: string,
): void {
  _chain = _chain
    .then(async () => {
      // Always insert to DB — unconditional audit trail
      let alertId: string;
      try {
        alertId = getQueries().insertAlert({ type, message, channel: null });
      } catch (err) {
        log.warn({ err, type }, "Failed to insert alert to DB");
        return;
      }

      // Dedup check for external delivery
      const key = dedupKey ?? `${type}-${alertId}`; // unique key → always send
      if (!canSendExternal(key, type)) {
        log.debug({ type, key }, "Alert suppressed by dedup — stored in DB only");
        return;
      }
      _sent.set(key, Date.now()); // mark before dispatch (prevents concurrent dupes)

      const hasTelegram = _telegramReady && !!config.ALERT_TELEGRAM_CHAT_ID && _prefs.telegramEnabled;
      const hasEmail    = !!_emailTransport && !!config.ALERT_EMAIL_TO && _prefs.emailEnabled;

      if (!hasTelegram && !hasEmail) {
        log.debug({ type }, "No alert channels enabled — stored in DB only");
        return;
      }

      await dispatchToChannels(alertId, type, message);
    })
    .catch((err) => {
      log.error({ err }, "Unexpected error in alert queue");
    });
}

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------

export interface DigestData {
  date:          string;
  totalCost:     number;
  requestCount:  number;
  blockedCount:  number;
  /** Top models sorted by cost DESC. */
  topModels:     Array<{ model: string; cost: number; request_count: number }>;
  dailyBudget:   { currentSpend: number; limitUsd: number; status: string } | null;
  monthlyBudget: { currentSpend: number; limitUsd: number; status: string } | null;
}

/**
 * Format and queue a daily digest alert.
 * Skipped automatically when there was no activity (request_count === 0).
 */
export function sendDailyDigest(data: DigestData): void {
  if (data.requestCount === 0) {
    log.debug({ date: data.date }, "No activity — skipping daily digest");
    return;
  }

  const topModel    = data.topModels[0];
  const topModelStr = topModel
    ? ` Top model: ${topModel.model} ($${topModel.cost.toFixed(2)}, ${topModel.request_count} req).`
    : "";

  const blockedStr = data.blockedCount > 0 ? ` (${data.blockedCount} blocked)` : "";

  let budgetStr = "";
  if (data.dailyBudget) {
    const pct = ((data.dailyBudget.currentSpend / data.dailyBudget.limitUsd) * 100).toFixed(0);
    budgetStr += ` Daily budget: ${pct}% used ($${data.dailyBudget.currentSpend.toFixed(2)} of $${data.dailyBudget.limitUsd.toFixed(2)}).`;
  }
  if (data.monthlyBudget) {
    const pct = ((data.monthlyBudget.currentSpend / data.monthlyBudget.limitUsd) * 100).toFixed(0);
    budgetStr += ` Monthly: ${pct}% used.`;
  }

  const message =
    `📊 TokPinch Daily Report (${data.date}):\n` +
    `$${data.totalCost.toFixed(4)} spent · ${data.requestCount} request(s)${blockedStr}.` +
    topModelStr +
    budgetStr;

  queueAlert("daily_digest", message, `daily_digest-${data.date}`);
}
