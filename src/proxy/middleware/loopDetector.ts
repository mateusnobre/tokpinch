/**
 * Loop Detector — prevents the "$200 overnight" runaway-agent scenario.
 *
 * Architecture:
 *   - Fully in-memory: fixed-size circular buffer (100 entries), never grows.
 *   - Pure functions checked on every proxy request in the hot path.
 *   - djb2 hash for input fingerprinting — zero crypto overhead.
 *   - Four independent detection rules; first to fire wins.
 *   - Per-session cooldowns with exponential backoff (base → 2× → … → 30 min).
 *   - Fires an async alert to the DB; never delays the hot-path response.
 */

import { config } from "../../config.js";
import { createLogger } from "../../utils/logger.js";
import { queueAlert } from "../../services/alerter.js";


const log = createLogger("loop-detector");

// ---------------------------------------------------------------------------
// djb2 — fast 32-bit non-cryptographic hash
// ---------------------------------------------------------------------------

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0; // keep unsigned 32-bit
  }
  return h;
}

// ---------------------------------------------------------------------------
// Input fingerprint — hash first 200 chars of the first user message
// ---------------------------------------------------------------------------

export function hashInput(
  messages: Array<{ role: string; content: unknown }>,
): number {
  const first = messages.find((m) => m.role === "user");
  if (!first) return 0;

  let text = "";
  if (typeof first.content === "string") {
    text = first.content.slice(0, 200);
  } else if (Array.isArray(first.content)) {
    for (const block of first.content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text" && block.text) {
        text = block.text.slice(0, 200);
        break;
      }
    }
  }

  return text.length === 0 ? 0 : djb2(text);
}

// ---------------------------------------------------------------------------
// Circular buffer — fixed size, overwrites oldest entry
// ---------------------------------------------------------------------------

const BUFFER_SIZE = 100;

interface BufferEntry {
  timestamp:   number;
  sessionId:   string;
  model:       string;
  inputHash:   number;
  requestType: string;
  costUsd:     number;
}

const _buf  = new Array<BufferEntry | null>(BUFFER_SIZE).fill(null);
let   _head = 0; // next write position

function bufferAdd(entry: BufferEntry): void {
  _buf[_head] = entry;
  _head       = (_head + 1) % BUFFER_SIZE;
}

/** All non-null buffer entries (up to BUFFER_SIZE). */
function bufferAll(): BufferEntry[] {
  return _buf.filter((e): e is BufferEntry => e !== null);
}

// ---------------------------------------------------------------------------
// Per-session cooldowns with exponential backoff
// ---------------------------------------------------------------------------

interface CooldownEntry {
  until:      number; // ms timestamp when cooldown expires
  durationMs: number; // duration that was applied (used to double next time)
}

const _cooldowns = new Map<string, CooldownEntry>();

const MAX_COOLDOWN_MS     = 30 * 60_000; // 30 minutes hard cap
const DOUBLING_WINDOW_MS  = 30 * 60_000; // reset multiplier if quiet this long

function baseCooldownMs(): number {
  return (config.LOOP_COOLDOWN_SECONDS ?? 300) * 1_000;
}

function nextCooldownMs(sessionId: string, now: number): number {
  const base  = baseCooldownMs();
  const entry = _cooldowns.get(sessionId);
  if (!entry) return base;
  // If the last cooldown ended long ago treat the session as fresh
  if (now - entry.until > DOUBLING_WINDOW_MS) return base;
  return Math.min(entry.durationMs * 2, MAX_COOLDOWN_MS);
}

function applyCooldown(sessionId: string, now: number): void {
  const durationMs = nextCooldownMs(sessionId, now);
  _cooldowns.set(sessionId, { until: now + durationMs, durationMs });
}

function isInCooldown(sessionId: string, now: number): boolean {
  const entry = _cooldowns.get(sessionId);
  return entry != null && entry.until > now;
}

function cooldownRemainingMs(sessionId: string, now: number): number {
  const entry = _cooldowns.get(sessionId);
  if (!entry || entry.until <= now) return 0;
  return entry.until - now;
}

// ---------------------------------------------------------------------------
// Detection thresholds
// ---------------------------------------------------------------------------

const RAPID_FIRE_WINDOW_MS      =      60_000; //  1 minute
const REPEATED_CONTENT_WINDOW   =  5 * 60_000; //  5 minutes
const REPEATED_CONTENT_LIMIT    = 5;            //  > 5 identical inputs
const COST_SPIRAL_WINDOW        =  5 * 60_000; //  5 minutes
const COST_SPIRAL_LIMIT_USD     = 2.00;
const HEARTBEAT_STORM_WINDOW    = 10 * 60_000; // 10 minutes
const HEARTBEAT_STORM_LIMIT     = 10;           //  > 10 heartbeats

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface LoopCheckParams {
  sessionId:        string | null;
  inputHash:        number;
  requestType:      "chat" | "heartbeat" | "tool_call" | "unknown";
  estimatedCostUsd: number;
  model:            string;
}

export interface LoopResult {
  blocked:  boolean;
  reason?:  "loop_detected";
  message?: string;
}

// ---------------------------------------------------------------------------
// Alert helper
// ---------------------------------------------------------------------------

function fireAlert(message: string, sessionId: string): void {
  // Session-scoped dedup key: at most one external notification per session per 5 minutes.
  // The alert is always written to the DB by queueAlert (audit trail).
  queueAlert("loop_detected", message, `loop_detected-${sessionId}`);
}

function buildBlockResult(
  sessionId: string,
  detail:    string,
  now:       number,
): LoopResult {
  const remainingMin = (cooldownRemainingMs(sessionId, now) / 60_000).toFixed(1);
  const message      =
    `[TokPinch] Loop detected: session ${sessionId} ${detail}. ` +
    `Paused for ${remainingMin} more minute(s).`;
  return { blocked: true, reason: "loop_detected", message };
}

// ---------------------------------------------------------------------------
// Core loop check — called by the proxy handler on every request
// ---------------------------------------------------------------------------

export function checkLoop(params: LoopCheckParams): LoopResult {
  const { sessionId, inputHash, requestType, estimatedCostUsd, model } = params;

  if (!config.LOOP_DETECTION_ENABLED || !sessionId) {
    return { blocked: false };
  }

  const now = Date.now();

  // 1. Already in cooldown — bail fast, don't add to buffer
  if (isInCooldown(sessionId, now)) {
    return buildBlockResult(sessionId, "is in cooldown", now);
  }

  // 2. Record this request in the circular buffer
  bufferAdd({ timestamp: now, sessionId, model, inputHash, requestType, costUsd: estimatedCostUsd });

  // 3. Pull only this session's entries for rule evaluation
  const sessionEntries = bufferAll().filter((e) => e.sessionId === sessionId);

  // --- Rule 1: Rapid fire — >LOOP_MAX_RPM requests in 60 s ---
  const maxRpm      = config.LOOP_MAX_RPM ?? 20;
  const rapidWindow = sessionEntries.filter((e) => now - e.timestamp < RAPID_FIRE_WINDOW_MS);
  if (rapidWindow.length > maxRpm) {
    const detail = `made ${rapidWindow.length} requests in 60 s (limit: ${maxRpm})`;
    log.warn({ sessionId, count: rapidWindow.length, maxRpm }, "Loop rule 1 fired: rapid fire");
    applyCooldown(sessionId, now);
    fireAlert(`🔄 Loop detected! Session ${sessionId} ${detail}. Spending $${estimatedCostUsd.toFixed(4)}. Paused for ${((_cooldowns.get(sessionId)!.durationMs) / 60_000).toFixed(0)} minute(s).`, sessionId);
    return buildBlockResult(sessionId, detail, now);
  }

  // --- Rule 2: Repeated content — >5 requests with same hash in 5 min ---
  const contentWindow = sessionEntries.filter((e) => now - e.timestamp < REPEATED_CONTENT_WINDOW);
  const hashCounts    = new Map<number, number>();
  for (const e of contentWindow) {
    hashCounts.set(e.inputHash, (hashCounts.get(e.inputHash) ?? 0) + 1);
  }
  for (const [hash, count] of hashCounts) {
    if (hash !== 0 && count > REPEATED_CONTENT_LIMIT) {
      const detail = `sent identical content ${count} times in 5 minutes`;
      log.warn({ sessionId, hash, count }, "Loop rule 2 fired: repeated content");
      applyCooldown(sessionId, now);
      fireAlert(`🔄 Loop detected! Session ${sessionId} ${detail}. Spending $${estimatedCostUsd.toFixed(4)}. Paused for ${((_cooldowns.get(sessionId)!.durationMs) / 60_000).toFixed(0)} minute(s).`, sessionId);
      return buildBlockResult(sessionId, detail, now);
    }
  }

  // --- Rule 3: Cost spiral — >$2 in 5 min ---
  const costWindow = sessionEntries.filter((e) => now - e.timestamp < COST_SPIRAL_WINDOW);
  const totalCost  = costWindow.reduce((sum, e) => sum + e.costUsd, 0);
  if (totalCost > COST_SPIRAL_LIMIT_USD) {
    const detail = `spent $${totalCost.toFixed(4)} in 5 minutes (limit: $${COST_SPIRAL_LIMIT_USD.toFixed(2)})`;
    log.warn({ sessionId, totalCost }, "Loop rule 3 fired: cost spiral");
    applyCooldown(sessionId, now);
    fireAlert(`🔄 Loop detected! Session ${sessionId} ${detail}. Paused for ${((_cooldowns.get(sessionId)!.durationMs) / 60_000).toFixed(0)} minute(s).`, sessionId);
    return buildBlockResult(sessionId, detail, now);
  }

  // --- Rule 4: Heartbeat storm — >10 heartbeats in 10 min ---
  const hbWindow = sessionEntries.filter(
    (e) => now - e.timestamp < HEARTBEAT_STORM_WINDOW && e.requestType === "heartbeat",
  );
  if (hbWindow.length > HEARTBEAT_STORM_LIMIT) {
    const detail = `sent ${hbWindow.length} heartbeat requests in 10 minutes (limit: ${HEARTBEAT_STORM_LIMIT})`;
    log.warn({ sessionId, heartbeats: hbWindow.length }, "Loop rule 4 fired: heartbeat storm");
    applyCooldown(sessionId, now);
    fireAlert(`🔄 Loop detected! Session ${sessionId} ${detail}. Spending $${estimatedCostUsd.toFixed(4)}. Paused for ${((_cooldowns.get(sessionId)!.durationMs) / 60_000).toFixed(0)} minute(s).`, sessionId);
    return buildBlockResult(sessionId, detail, now);
  }

  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Inspection helpers (read-only, used by tests and dashboard)
// ---------------------------------------------------------------------------

/** Current cooldown entry for a session, or undefined if none/expired. */
export function getCooldown(sessionId: string): CooldownEntry | undefined {
  return _cooldowns.get(sessionId);
}

// ---------------------------------------------------------------------------
// Testing helpers — reset module-level state between test cases
// ---------------------------------------------------------------------------

/** Clear only the circular buffer (preserves cooldown state). */
export function _resetBuffer(): void {
  _buf.fill(null);
  _head = 0;
}

/** Full reset — clears buffer AND all cooldowns. Use in beforeEach. */
export function _resetState(): void {
  _resetBuffer();
  _cooldowns.clear();
}
