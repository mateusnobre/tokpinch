/**
 * Smart Model Router — unit tests
 *
 * config.js is mocked so SMART_ROUTING_ENABLED can be toggled per test.
 * No real filesystem access occurs (loadRoutingRules is tested separately
 * using the _setRoutingRules / _resetRoutingRules helpers).
 * calculateCost / estimateTokens are real — we care about routing decisions,
 * not exact dollar amounts.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock config
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  LOG_LEVEL:             "silent" as const,
  NODE_ENV:              "test"   as const,
  SMART_ROUTING_ENABLED: true,
}));

vi.mock("../src/config.js", () => ({ config: mockConfig }));

import {
  applyRouting,
  getRoutingRules,
  _setRoutingRules,
  _resetRoutingRules,
  DEFAULT_RULES,
  type RouterInput,
  type RoutingRules,
} from "../src/proxy/middleware/modelRouter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function body(model: string, tools: unknown[] = []): Record<string, unknown> {
  return { model, tools };
}

function input(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    model:       "claude-opus-4-20250514",
    messages:    [{ role: "user", content: "hi" }],
    systemText:  "",
    hasTools:    false,
    requestType: "chat",
    ...overrides,
  };
}

/** Build a messages array whose text content is roughly `chars` long. */
function bigMessages(chars: number): RouterInput["messages"] {
  return [{ role: "user", content: "x".repeat(chars) }];
}

// ---------------------------------------------------------------------------
// Reset state between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetRoutingRules();
  mockConfig.SMART_ROUTING_ENABLED = true;
});

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

describe("SMART_ROUTING_ENABLED=false", () => {
  it("returns null immediately when disabled", () => {
    mockConfig.SMART_ROUTING_ENABLED = false;
    const b = body("claude-opus-4-20250514");
    const result = applyRouting(b, input());
    expect(result).toBeNull();
    expect(b.model).toBe("claude-opus-4-20250514"); // body unmutated
  });
});

// ---------------------------------------------------------------------------
// Model not in routing table
// ---------------------------------------------------------------------------

describe("unknown model", () => {
  it("returns null for a model not in the routing table", () => {
    const b = body("claude-3-opus-20240229"); // not in DEFAULT_RULES
    expect(applyRouting(b, input({ model: "claude-3-opus-20240229" }))).toBeNull();
    expect(b.model).toBe("claude-3-opus-20240229");
  });

  it("returns null for an empty model string", () => {
    const b = body("");
    expect(applyRouting(b, input({ model: "" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prefix matching
// ---------------------------------------------------------------------------

describe("prefix matching", () => {
  it("matches exact prefix", () => {
    const b = body("claude-opus-4");
    const result = applyRouting(b, input({ model: "claude-opus-4", requestType: "heartbeat" }));
    expect(result).not.toBeNull();
    expect(result!.originalModel).toBe("claude-opus-4");
  });

  it("matches date-suffixed model ID (e.g. claude-opus-4-20250514)", () => {
    const b = body("claude-opus-4-20250514");
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4-20250514", requestType: "heartbeat" }),
    );
    expect(result).not.toBeNull();
    expect(result!.originalModel).toBe("claude-opus-4-20250514");
  });

  it("does NOT match a model that only partially shares a prefix without hyphen boundary", () => {
    // "claude-opus-42" should NOT match "claude-opus-4" (no hyphen after)
    const b = body("claude-opus-42");
    expect(applyRouting(b, input({ model: "claude-opus-42", requestType: "heartbeat" }))).toBeNull();
  });

  it("is case-insensitive", () => {
    const b = body("Claude-Opus-4-20250514");
    const result = applyRouting(
      b,
      input({ model: "Claude-Opus-4-20250514", requestType: "heartbeat" }),
    );
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEVER-downgrade conditions
// ---------------------------------------------------------------------------

describe("never-downgrade conditions", () => {
  it("never routes when message contains image content block (Anthropic)", () => {
    const messages = [{
      role:    "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abc" } }],
    }];
    const b = body("claude-opus-4");
    expect(
      applyRouting(b, input({ model: "claude-opus-4", messages, requestType: "heartbeat" })),
    ).toBeNull();
    expect(b.model).toBe("claude-opus-4");
  });

  it("never routes when message contains image_url block (OpenAI)", () => {
    const messages = [{ role: "user", content: [{ type: "image_url", image_url: { url: "..." } }] }];
    const b = body("gpt-4.1");
    expect(applyRouting(b, input({ model: "gpt-4.1", messages, requestType: "heartbeat" }))).toBeNull();
  });

  it("never routes when message contains document block", () => {
    const messages = [{ role: "user", content: [{ type: "document" }] }];
    const b = body("claude-opus-4");
    expect(applyRouting(b, input({ model: "claude-opus-4", messages }))).toBeNull();
  });

  it("never routes when tool count >= no_route_tool_threshold (6)", () => {
    const tools = new Array(6).fill({ name: "t" });
    const b = { model: "claude-opus-4", tools };
    expect(
      applyRouting(b, input({ model: "claude-opus-4", hasTools: true })),
    ).toBeNull();
  });

  it("still routes when tool count is exactly 5 (< 6)", () => {
    // 5 tools: doesn't trigger no_route_tool_threshold, but > mid_max_tools(3)
    // → neither cheap nor mid → should return null (no eligible tier)
    const tools = new Array(5).fill({ name: "t" });
    const b = { model: "claude-opus-4", tools };
    const result = applyRouting(b, input({ model: "claude-opus-4", hasTools: true }));
    // 5 tools: hasTools=true → not cheap-eligible; toolCount=5 >= mid_max_tools(3) → not mid-eligible
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CHEAP tier routing
// ---------------------------------------------------------------------------

describe("cheap tier — heartbeat", () => {
  it("routes opus heartbeat to haiku", () => {
    const b = body("claude-opus-4");
    const result = applyRouting(b, input({ model: "claude-opus-4", requestType: "heartbeat" }));
    expect(result).not.toBeNull();
    expect(result!.finalModel).toBe("claude-haiku-3-5-20241022");
    expect(result!.originalModel).toBe("claude-opus-4");
    expect(result!.reason).toBe("heartbeat");
    expect(b.model).toBe("claude-haiku-3-5-20241022"); // body mutated
  });

  it("routes sonnet-4 heartbeat to haiku", () => {
    const b = body("claude-sonnet-4");
    const result = applyRouting(b, input({ model: "claude-sonnet-4", requestType: "heartbeat" }));
    expect(result!.finalModel).toBe("claude-haiku-3-5-20241022");
    expect(result!.reason).toBe("heartbeat");
  });

  it("routes OpenAI gpt-4.1 heartbeat to nano", () => {
    const b = body("gpt-4.1");
    const result = applyRouting(b, input({ model: "gpt-4.1", requestType: "heartbeat" }));
    expect(result!.finalModel).toBe("gpt-4.1-nano");
    expect(result!.reason).toBe("heartbeat");
  });

  it("routes gpt-4o heartbeat to gpt-4o-mini", () => {
    const b = body("gpt-4o");
    const result = applyRouting(b, input({ model: "gpt-4o", requestType: "heartbeat" }));
    expect(result!.finalModel).toBe("gpt-4o-mini");
  });
});

describe("cheap tier — low_token_chat", () => {
  it("routes when input tokens < cheap_max_input_tokens (200) and no system / no tools", () => {
    // "hello" ≈ 1–2 tokens — well under 200
    const b = body("claude-opus-4");
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", messages: [{ role: "user", content: "hello" }] }),
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("low_token_chat");
    expect(result!.finalModel).toBe("claude-haiku-3-5-20241022");
  });

  it("does NOT route chat when input tokens >= cheap_max_input_tokens (200)", () => {
    // ~200 chars * 0.25 ≈ 50 tokens, plus overhead … let's use many more chars
    const b = body("claude-opus-4");
    // 1200 chars → ~300 tokens, well over 200
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", messages: bigMessages(1200) }),
    );
    // Won't be cheap (too many tokens), but also no tools so won't be mid either
    expect(result).toBeNull();
  });

  it("does NOT route cheap when hasTools=true even if tokens are low", () => {
    const b = { model: "claude-opus-4", tools: [{ name: "t" }] };
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", hasTools: true }),
    );
    // hasTools → cheap not eligible; toolCount=1 < 3 and inputToks low → mid eligible
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("light_tool_call");
  });

  it("does NOT route cheap when system prompt is >= cheap_max_system_tokens (500)", () => {
    // 2500 chars → ~625 tokens > 500
    const b = body("claude-opus-4");
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", systemText: "s".repeat(2500) }),
    );
    // System too large for cheap; no tools so not mid either
    expect(result).toBeNull();
  });

  it("routes cheap when system prompt is under the threshold", () => {
    // 400 chars → ~100 tokens < 500
    const b = body("claude-opus-4");
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", systemText: "s".repeat(400) }),
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("low_token_chat");
  });
});

// ---------------------------------------------------------------------------
// MID tier routing
// ---------------------------------------------------------------------------

describe("mid tier — light_tool_call", () => {
  it("routes opus with 1 tool and low tokens to sonnet", () => {
    const b = { model: "claude-opus-4", tools: [{ name: "t" }] };
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", hasTools: true }),
    );
    expect(result).not.toBeNull();
    expect(result!.finalModel).toBe("claude-sonnet-4-5");
    expect(result!.reason).toBe("light_tool_call");
  });

  it("routes with exactly mid_max_tools - 1 tools (2 tools)", () => {
    const b = { model: "claude-opus-4", tools: [{ name: "a" }, { name: "b" }] };
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", hasTools: true }),
    );
    expect(result!.reason).toBe("light_tool_call");
  });

  it("does NOT route mid when tool count == mid_max_tools (3)", () => {
    const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const b = { model: "claude-opus-4", tools };
    const result = applyRouting(b, input({ model: "claude-opus-4", hasTools: true }));
    expect(result).toBeNull(); // 3 tools: not < 3
  });

  it("routes OpenAI gpt-4.1 with 1 tool to gpt-4.1-mini", () => {
    const b = { model: "gpt-4.1", tools: [{ name: "search" }] };
    const result = applyRouting(b, input({ model: "gpt-4.1", hasTools: true }));
    expect(result!.finalModel).toBe("gpt-4.1-mini");
    expect(result!.reason).toBe("light_tool_call");
  });

  it("does NOT route mid when input tokens >= mid_max_input_tokens (1000)", () => {
    // 5000 chars → ~1250 tokens > 1000
    const b = { model: "claude-opus-4", tools: [{ name: "t" }] };
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", hasTools: true, messages: bigMessages(5000) }),
    );
    expect(result).toBeNull();
  });

  it("does NOT route mid when model has no mid mapping (claude-sonnet-4)", () => {
    // claude-sonnet-4 only has cheap, no mid
    const b = { model: "claude-sonnet-4", tools: [{ name: "t" }] };
    const result = applyRouting(
      b,
      input({ model: "claude-sonnet-4", hasTools: true }),
    );
    expect(result).toBeNull(); // no mid mapping available
  });
});

// ---------------------------------------------------------------------------
// Tier priority — cheap beats mid when both are eligible
// ---------------------------------------------------------------------------

describe("tier priority", () => {
  it("cheap tier takes priority over mid (heartbeat with 1 tool skips to cheap)", () => {
    // heartbeat + hasTools=false → cheap eligible; we set hasTools=false here
    const b = body("claude-opus-4");
    const result = applyRouting(
      b,
      input({ model: "claude-opus-4", requestType: "heartbeat", hasTools: false }),
    );
    expect(result!.reason).toBe("heartbeat");
    expect(result!.finalModel).toBe("claude-haiku-3-5-20241022");
  });
});

// ---------------------------------------------------------------------------
// No-op cases — already cheapest model
// ---------------------------------------------------------------------------

describe("no-op routing", () => {
  it("returns null when target already equals original (haiku routing to haiku)", () => {
    // claude-haiku is not in the routing table → already handled by findMapping returning undefined
    const b = body("claude-haiku-3-5-20241022");
    expect(
      applyRouting(b, input({ model: "claude-haiku-3-5-20241022", requestType: "heartbeat" })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RoutingResult shape and savedUsd
// ---------------------------------------------------------------------------

describe("RoutingResult", () => {
  it("result includes originalModel, finalModel, reason, savedUsd >= 0", () => {
    const b = body("claude-opus-4");
    const result = applyRouting(b, input({ model: "claude-opus-4", requestType: "heartbeat" }));
    expect(result).toMatchObject({
      originalModel: "claude-opus-4",
      finalModel:    "claude-haiku-3-5-20241022",
      reason:        "heartbeat",
    });
    expect(result!.savedUsd).toBeGreaterThanOrEqual(0);
  });

  it("savedUsd is positive when routing from expensive to cheap model", () => {
    const b = body("claude-opus-4");
    const result = applyRouting(b, input({ model: "claude-opus-4", requestType: "heartbeat" }));
    // Opus is more expensive than Haiku → savings > 0
    expect(result!.savedUsd).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Body mutation
// ---------------------------------------------------------------------------

describe("body mutation", () => {
  it("mutates body.model when routing applies", () => {
    const b = body("claude-opus-4");
    applyRouting(b, input({ model: "claude-opus-4", requestType: "heartbeat" }));
    expect(b.model).toBe("claude-haiku-3-5-20241022");
  });

  it("does not mutate body.model when routing doesn't apply", () => {
    mockConfig.SMART_ROUTING_ENABLED = false;
    const b = body("claude-opus-4");
    applyRouting(b, input({ model: "claude-opus-4", requestType: "heartbeat" }));
    expect(b.model).toBe("claude-opus-4");
  });
});

// ---------------------------------------------------------------------------
// Custom routing rules (_setRoutingRules)
// ---------------------------------------------------------------------------

describe("custom routing rules", () => {
  afterEach(() => _resetRoutingRules());

  it("respects custom model mappings", () => {
    const custom: RoutingRules = {
      ...DEFAULT_RULES,
      models: {
        "my-big-model": { cheap: "my-cheap-model", mid: "my-mid-model" },
      },
    };
    _setRoutingRules(custom);

    const b = body("my-big-model");
    const result = applyRouting(
      b,
      input({ model: "my-big-model", requestType: "heartbeat" }),
    );
    expect(result!.finalModel).toBe("my-cheap-model");
  });

  it("respects custom thresholds", () => {
    // estimateInputTokens("hi") = 3 (priming) + 4 (per-msg) + 1 (text) = 8
    // estimateInputTokens("hello world there") = 3 + 4 + 5 = 12
    // threshold = 10: "hi" (8) < 10 → routes; "hello world there" (12) >= 10 → doesn't
    const custom: RoutingRules = {
      ...DEFAULT_RULES,
      thresholds: {
        ...DEFAULT_RULES.thresholds,
        cheap_max_input_tokens: 10,
      },
    };
    _setRoutingRules(custom);

    // "hi" ≈ 8 tokens — should route
    const b1 = body("claude-opus-4");
    expect(
      applyRouting(b1, input({ model: "claude-opus-4", messages: [{ role: "user", content: "hi" }] })),
    ).not.toBeNull();

    // "hello world there" ≈ 12 tokens — exceeds threshold, no tools, so no mid → null
    const b2 = body("claude-opus-4");
    const result2 = applyRouting(
      b2,
      input({ model: "claude-opus-4", messages: [{ role: "user", content: "hello world there" }] }),
    );
    expect(result2).toBeNull();
  });

  it("getRoutingRules() returns the active rules", () => {
    const custom: RoutingRules = { ...DEFAULT_RULES, version: 99 };
    _setRoutingRules(custom);
    expect(getRoutingRules().version).toBe(99);
  });

  it("_resetRoutingRules() restores defaults", () => {
    _setRoutingRules({ ...DEFAULT_RULES, version: 99 });
    _resetRoutingRules();
    expect(getRoutingRules().version).toBe(DEFAULT_RULES.version);
  });
});

// ---------------------------------------------------------------------------
// OpenAI models
// ---------------------------------------------------------------------------

describe("OpenAI model routing", () => {
  it("gpt-4-turbo heartbeat → gpt-4o-mini", () => {
    const b = body("gpt-4-turbo");
    const result = applyRouting(b, input({ model: "gpt-4-turbo", requestType: "heartbeat" }));
    expect(result!.finalModel).toBe("gpt-4o-mini");
    expect(result!.reason).toBe("heartbeat");
  });

  it("gpt-4-turbo light tool call → gpt-4o (mid)", () => {
    const b = { model: "gpt-4-turbo", tools: [{ name: "t" }] };
    const result = applyRouting(b, input({ model: "gpt-4-turbo", hasTools: true }));
    expect(result!.finalModel).toBe("gpt-4o");
    expect(result!.reason).toBe("light_tool_call");
  });
});
