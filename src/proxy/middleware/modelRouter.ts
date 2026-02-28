/**
 * Smart Model Router — routes simple/cheap requests to smaller models so
 * users don't pay opus prices for heartbeats and low-complexity calls.
 *
 * OPT-IN: only active when SMART_ROUTING_ENABLED=true (default: false).
 *
 * Rules are loaded from data/routing-rules.json on startup. If the file
 * doesn't exist TokPinch writes the defaults there so users can customise.
 *
 * Core contract:
 *   applyRouting(body, request) → RoutingResult | null
 *
 * When a RoutingResult is returned:
 *   - body.model has already been mutated to the routed model
 *   - originalModel records what was requested (for DB logging + savings calc)
 *   - null means "no change, forward as-is"
 */

import fs   from "node:fs";
import path from "node:path";
import { config }          from "../../config.js";
import { createLogger }    from "../../utils/logger.js";
import { estimateTokens }  from "../../utils/tokenCounter.js";
import { calculateCost }   from "../../utils/pricing.js";

const log = createLogger("model-router");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContentBlock = { type?: string; text?: string };
type Message      = { role: string; content: unknown };

export interface RouterInput {
  model:       string;
  messages:    Message[];
  systemText:  string;
  hasTools:    boolean;
  requestType: string; // "chat" | "heartbeat" | "tool_call" | "unknown"
}

export interface RoutingResult {
  originalModel: string;
  finalModel:    string;
  savedUsd:      number; // estimated saving (positive = cheaper)
  reason:        string; // "heartbeat" | "low_token_chat" | "light_tool_call"
}

// ---------------------------------------------------------------------------
// Routing-rules schema & defaults
// ---------------------------------------------------------------------------

export interface RoutingRules {
  version: number;
  /** Numeric thresholds that control when each tier applies. */
  thresholds: {
    /** Route to cheap when input tokens < this (and other conditions met). */
    cheap_max_input_tokens:  number;
    /** Route to cheap only if system prompt is < this. */
    cheap_max_system_tokens: number;
    /** Route to mid when input tokens < this. */
    mid_max_input_tokens:    number;
    /** Route to mid only when tool count < this (strictly less than). */
    mid_max_tools:           number;
    /** NEVER route when tool count >= this (>5 complex tool use). */
    no_route_tool_threshold: number;
  };
  /**
   * Model prefix → { mid?, cheap? } target mapping.
   * Keys are matched with the same prefix-match logic as the pricing table.
   * A model with no entry is never touched (respects user's explicit choice).
   */
  models: Record<string, { mid?: string; cheap?: string }>;
}

export const DEFAULT_RULES: RoutingRules = {
  version: 1,
  thresholds: {
    cheap_max_input_tokens:  200,
    cheap_max_system_tokens: 500,
    mid_max_input_tokens:    1_000,
    mid_max_tools:           3,      // strictly < 3 → routes to mid
    no_route_tool_threshold: 6,      // >= 6 tools → never downgrade
  },
  models: {
    // Anthropic — date-suffixed IDs like "claude-opus-4-20250514" are caught
    // by prefix matching ("claude-opus-4-").
    "claude-opus-4":    { mid: "claude-sonnet-4-5",          cheap: "claude-haiku-3-5-20241022" },
    "claude-sonnet-4":  {                                     cheap: "claude-haiku-3-5-20241022" },
    "claude-sonnet-3-5":{ cheap: "claude-haiku-3-5-20241022" },
    // OpenAI
    "gpt-4.1":          { mid: "gpt-4.1-mini",  cheap: "gpt-4.1-nano"  },
    "gpt-4o":           { mid: "gpt-4o-mini",   cheap: "gpt-4o-mini"   },
    "gpt-4-turbo":      { mid: "gpt-4o",        cheap: "gpt-4o-mini"   },
  },
};

// ---------------------------------------------------------------------------
// Rules loading + hot module state
// ---------------------------------------------------------------------------

let _rules: RoutingRules = DEFAULT_RULES;

function rulesFilePath(): string {
  return path.resolve(process.cwd(), "data/routing-rules.json");
}

/**
 * Called once at server startup.
 * Reads data/routing-rules.json; writes it with defaults if it doesn't exist.
 */
export function loadRoutingRules(): void {
  const p = rulesFilePath();

  if (!fs.existsSync(p)) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(DEFAULT_RULES, null, 2), "utf8");
      log.info({ path: p }, "Created default routing-rules.json");
    } catch (err) {
      log.warn({ err }, "Could not write routing-rules.json — using built-in defaults");
    }
    _rules = DEFAULT_RULES;
    return;
  }

  try {
    const raw = fs.readFileSync(p, "utf8");
    _rules    = JSON.parse(raw) as RoutingRules;
    log.info({ path: p, version: _rules.version }, "Routing rules loaded");
  } catch (err) {
    log.warn({ err, path: p }, "Could not parse routing-rules.json — using built-in defaults");
    _rules = DEFAULT_RULES;
  }
}

/** Read-only access to current rules (for tests / dashboard). */
export function getRoutingRules(): RoutingRules { return _rules; }

/** Test helper — inject rules without touching the filesystem. */
export function _setRoutingRules(r: RoutingRules): void { _rules = r; }

/** Test helper — reset to defaults. */
export function _resetRoutingRules(): void { _rules = DEFAULT_RULES; }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Prefix-match a model ID against the rules.models keys.
 * e.g. "claude-opus-4-20250514" → matches "claude-opus-4"
 */
function findMapping(model: string): { mid?: string; cheap?: string } | undefined {
  const m = model.toLowerCase();
  for (const [prefix, mapping] of Object.entries(_rules.models)) {
    if (m === prefix || m.startsWith(prefix + "-")) return mapping;
  }
  return undefined;
}

/**
 * Returns true if any message content block is an image or document.
 * Anthropic: type="image" | type="document"
 * OpenAI:    type="image_url"
 */
function containsVisionContent(messages: Message[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlock[]) {
      if (
        block.type === "image"     ||
        block.type === "image_url" ||
        block.type === "document"
      ) return true;
    }
  }
  return false;
}

/** Rough token count for a messages array (matches estimateRequestTokens). */
function estimateInputTokens(messages: Message[]): number {
  let total = 3; // API priming overhead
  for (const msg of messages) {
    total += 4; // per-message overhead
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === "text" && b.text) total += estimateTokens(b.text);
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether to route this request to a cheaper model.
 *
 * Side-effect: if routing is applied, `body.model` is mutated in-place
 * so the updated value is used when the body is serialised for forwarding.
 *
 * Returns null if:
 *   - SMART_ROUTING_ENABLED is false
 *   - the model isn't in the routing table (user's explicit choice)
 *   - any NEVER-downgrade condition is met
 *   - the target model equals the original (already cheap enough)
 */
export function applyRouting(
  body:    Record<string, unknown>,
  request: RouterInput,
): RoutingResult | null {
  if (!config.SMART_ROUTING_ENABLED) return null;

  const { model, messages, systemText, hasTools, requestType } = request;

  const mapping = findMapping(model);
  if (!mapping) return null; // model not in routing table — respect user's choice

  const t            = _rules.thresholds;
  const tools        = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const toolCount    = tools.length;
  const hasVision    = containsVisionContent(messages);
  const inputToks    = estimateInputTokens(messages);
  const sysToks      = estimateTokens(systemText);

  // ---- NEVER downgrade conditions ----
  if (hasVision)                          return null; // needs vision capabilities
  if (toolCount >= t.no_route_tool_threshold) return null; // complex tool orchestration (> 5)

  // ---- Try CHEAP tier first ----
  let targetModel: string | undefined;
  let reason = "";

  const cheapEligible =
    (requestType === "heartbeat" || inputToks < t.cheap_max_input_tokens) &&
    !hasTools &&
    sysToks < t.cheap_max_system_tokens;

  if (cheapEligible && mapping.cheap) {
    targetModel = mapping.cheap;
    reason      = requestType === "heartbeat" ? "heartbeat" : "low_token_chat";
  }

  // ---- Try MID tier if cheap doesn't apply ----
  if (!targetModel) {
    const midEligible =
      hasTools                          &&
      toolCount < t.mid_max_tools       &&  // strictly < 3
      inputToks < t.mid_max_input_tokens;   // < 1000 tokens

    if (midEligible && mapping.mid) {
      targetModel = mapping.mid;
      reason      = "light_tool_call";
    }
  }

  if (!targetModel || targetModel === model) return null;

  // ---- Estimate savings (input-token estimate × price difference) ----
  // Use a representative 50-token output as a proxy — exact output unknown yet.
  const ESTIMATED_OUTPUT = 50;
  const originalCost = calculateCost(model,       inputToks, ESTIMATED_OUTPUT);
  const routedCost   = calculateCost(targetModel, inputToks, ESTIMATED_OUTPUT);
  const savedUsd     = Math.max(0, originalCost - routedCost);

  // ---- Apply: mutate body.model before the body is JSON-serialised ----
  body["model"] = targetModel;

  log.info(
    { original: model, routed: targetModel, reason, savedUsd: savedUsd.toFixed(6) },
    `🔀 Routed: ${model} → ${targetModel} (${reason}, saved ~$${savedUsd.toFixed(4)})`,
  );

  return { originalModel: model, finalModel: targetModel, savedUsd, reason };
}
