/**
 * Loop Detector — unit tests
 *
 * All time is controlled via vi.useFakeTimers() / vi.setSystemTime().
 * The DB is mocked so no disk I/O occurs.
 * config.js is mocked so env vars can be tuned per describe block.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoist mock config (must run before any import that transitively loads config)
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  LOG_LEVEL:              "silent" as const,
  NODE_ENV:               "test"   as const,
  LOOP_DETECTION_ENABLED: true,
  LOOP_MAX_RPM:           20,
  LOOP_COOLDOWN_SECONDS:  300, // 5 minutes = 300 000 ms
}));

vi.mock("../src/config.js", () => ({ config: mockConfig }));

// Mock DB — only insertAlert matters; we test return values, not side effects
vi.mock("../src/db/index.js", () => ({
  getQueries: () => ({ insertAlert: vi.fn() }),
}));

import {
  checkLoop,
  hashInput,
  getCooldown,
  _resetState,
  _resetBuffer,
  type LoopCheckParams,
} from "../src/proxy/middleware/loopDetector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a LoopCheckParams with sensible defaults, easily overridden. */
function req(
  sessionId: string,
  overrides: Partial<LoopCheckParams> = {},
): LoopCheckParams {
  return {
    sessionId,
    inputHash:        42,
    requestType:      "chat",
    estimatedCostUsd: 0.001,
    model:            "claude-sonnet-4",
    ...overrides,
  };
}

/**
 * Send n requests for a session, each 1 s apart starting from t=0.
 * Uses a UNIQUE hash per request (i + 1) so Rule 2 (repeated content)
 * never fires accidentally during Rule 1 (rapid fire) tests.
 * Pass { inputHash: X } in overrides to force a fixed hash (for Rule 2 tests).
 */
function sendN(
  n:         number,
  sessionId: string,
  overrides: Partial<LoopCheckParams> = {},
) {
  const results = [];
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(i * 1_000);
    const perRequest: Partial<LoopCheckParams> =
      "inputHash" in overrides
        ? { ...overrides }                           // caller set explicit hash
        : { inputHash: i + 1, ...overrides };        // unique per request
    results.push(checkLoop(req(sessionId, perRequest)));
  }
  return results;
}

// ---------------------------------------------------------------------------
// State reset + fake timers (runs before every test)
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  _resetState();
  // Restore defaults (individual tests may override)
  mockConfig.LOOP_DETECTION_ENABLED = true;
  mockConfig.LOOP_MAX_RPM           = 20;
  mockConfig.LOOP_COOLDOWN_SECONDS  = 300;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// hashInput
// ---------------------------------------------------------------------------

describe("hashInput", () => {
  it("returns 0 for empty messages", () => {
    expect(hashInput([])).toBe(0);
  });

  it("returns 0 when there is no user message", () => {
    expect(hashInput([{ role: "assistant", content: "hi" }])).toBe(0);
  });

  it("returns non-zero for a user text message", () => {
    expect(hashInput([{ role: "user", content: "Hello" }])).toBeGreaterThan(0);
  });

  it("returns the same hash for identical content", () => {
    const a = hashInput([{ role: "user", content: "same" }]);
    const b = hashInput([{ role: "user", content: "same" }]);
    expect(a).toBe(b);
  });

  it("returns different hashes for different content", () => {
    const a = hashInput([{ role: "user", content: "text A" }]);
    const b = hashInput([{ role: "user", content: "text B" }]);
    expect(a).not.toBe(b);
  });

  it("extracts text from content-block arrays", () => {
    const a = hashInput([{ role: "user", content: [{ type: "text", text: "block" }] }]);
    const b = hashInput([{ role: "user", content: "block" }]);
    expect(a).toBe(b);
  });

  it("only uses the first 200 characters", () => {
    const a = hashInput([{ role: "user", content: "x".repeat(200) }]);
    const b = hashInput([{ role: "user", content: "x".repeat(201) }]);
    expect(a).toBe(b); // 201st char is trimmed — hashes match
  });
});

// ---------------------------------------------------------------------------
// Feature flag + null session
// ---------------------------------------------------------------------------

describe("bypass conditions", () => {
  it("always returns allowed when LOOP_DETECTION_ENABLED is false", () => {
    mockConfig.LOOP_DETECTION_ENABLED = false;
    const results = sendN(50, "sess-disabled", { estimatedCostUsd: 0.5 });
    expect(results.every((r) => !r.blocked)).toBe(true);
  });

  it("skips detection when sessionId is null", () => {
    const r = checkLoop({ ...req("ignored"), sessionId: null });
    expect(r.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Normal traffic — should NOT trigger any rule
// ---------------------------------------------------------------------------

describe("normal traffic pattern", () => {
  it("allows 10 spread-out requests (10 s apart)", () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * 10_000);
      results.push(checkLoop(req("sess-normal", { inputHash: i + 1 })));
    }
    expect(results.every((r) => !r.blocked)).toBe(true);
  });

  it("allows exactly LOOP_MAX_RPM requests in 60 s — threshold is strictly >max", () => {
    // 20 unique-content requests all within 60 s → count = 20, not > 20
    const results = sendN(20, "sess-edge"); // sendN uses unique hashes
    expect(results.every((r) => !r.blocked)).toBe(true);
  });

  it("does not cross-contaminate different sessions", () => {
    sendN(19, "sess-A"); // bring A close to threshold
    const r = checkLoop(req("sess-B"));
    expect(r.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — Rapid fire
// ---------------------------------------------------------------------------

describe("Rule 1: rapid fire (>LOOP_MAX_RPM in 60 s)", () => {
  it("blocks the 21st request when 21 arrive within 60 s", () => {
    const results = sendN(21, "sess-rapid");
    expect(results[20]!.blocked).toBe(true);
    expect(results[20]!.reason).toBe("loop_detected");
  });

  it("the first 20 requests all pass", () => {
    const results = sendN(21, "sess-rapid2");
    expect(results.slice(0, 20).every((r) => !r.blocked)).toBe(true);
  });

  it("respects a custom LOOP_MAX_RPM", () => {
    mockConfig.LOOP_MAX_RPM = 5;
    const results = sendN(6, "sess-custom-rpm");
    expect(results[5]!.blocked).toBe(true);
    expect(results.slice(0, 5).every((r) => !r.blocked)).toBe(true);
  });

  it("does not trigger when requests are spread beyond the 60 s window", () => {
    // 21 requests at 4 s each = 84 s total.
    // At i=20 (t=80 s), the window covers t=20..80 s → only ~15 entries — below 20.
    const results: ReturnType<typeof checkLoop>[] = [];
    for (let i = 0; i < 21; i++) {
      vi.setSystemTime(i * 4_000);
      results.push(checkLoop(req("sess-spread", { inputHash: i + 1 })));
    }
    expect(results[20]!.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — Repeated content
// ---------------------------------------------------------------------------

describe("Rule 2: repeated content (>5 identical inputs in 5 min)", () => {
  it("blocks the 6th request with the same hash", () => {
    const SAME = 999_999;
    const results = [];
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(i * 10_000); // 10 s apart, all within 5 min
      results.push(checkLoop(req("sess-repeat", { inputHash: SAME })));
    }
    expect(results.slice(0, 5).every((r) => !r.blocked)).toBe(true);
    expect(results[5]!.blocked).toBe(true);
    expect(results[5]!.reason).toBe("loop_detected");
  });

  it("does not trigger on exactly 5 identical requests (threshold is strictly >5)", () => {
    const SAME = 777_777;
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(i * 10_000);
      expect(checkLoop(req("sess-repeat-edge", { inputHash: SAME })).blocked).toBe(false);
    }
  });

  it("does not trigger when identical content is spread beyond 5 min", () => {
    const SAME = 111_111;
    // 6 requests, 70 s apart → at i=5 (t=350 s), i=0 (t=0) is outside 5-min window
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(i * 70_000);
      expect(checkLoop(req("sess-repeat-spread", { inputHash: SAME })).blocked).toBe(false);
    }
  });

  it("treats hash=0 (no user content) as unknown — never triggers Rule 2", () => {
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * 1_000);
      expect(checkLoop(req("sess-hash-zero", { inputHash: 0 })).blocked).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — Cost spiral
// ---------------------------------------------------------------------------

describe("Rule 3: cost spiral (>$2 in 5 min)", () => {
  it("blocks when cumulative cost exceeds $2 within 5 min", () => {
    // 3 × $0.80 = $2.40; after the 3rd request total crosses $2
    const results = [];
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i * 10_000);
      results.push(checkLoop(req("sess-cost", { inputHash: i + 1, estimatedCostUsd: 0.80 })));
    }
    expect(results[0]!.blocked).toBe(false); // $0.80
    expect(results[1]!.blocked).toBe(false); // $1.60
    expect(results[2]!.blocked).toBe(true);  // $2.40 > $2.00
  });

  it("does not trigger on expensive requests spread beyond 5 min", () => {
    // 4 min apart; at i=2 (t=8 min) only i=1 and i=2 are in the 5-min window → $1.60
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i * 4 * 60_000);
      expect(
        checkLoop(req("sess-cost-spread", { inputHash: i + 1, estimatedCostUsd: 0.80 })).blocked,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — Heartbeat storm
// ---------------------------------------------------------------------------

describe("Rule 4: heartbeat storm (>10 in 10 min)", () => {
  it("blocks the 11th heartbeat within 10 min", () => {
    const results = [];
    for (let i = 0; i < 11; i++) {
      vi.setSystemTime(i * 30_000); // 30 s apart, all within 10 min
      results.push(checkLoop(req("sess-hb", { requestType: "heartbeat", inputHash: i + 1 })));
    }
    expect(results.slice(0, 10).every((r) => !r.blocked)).toBe(true);
    expect(results[10]!.blocked).toBe(true);
  });

  it("does not count non-heartbeat types toward the heartbeat threshold", () => {
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * 30_000);
      checkLoop(req("sess-hb-mixed", { requestType: "heartbeat", inputHash: i + 1 }));
    }
    // An 11th chat request should NOT trigger the heartbeat rule
    vi.setSystemTime(10 * 30_000);
    const chat = checkLoop(req("sess-hb-mixed", { requestType: "chat", inputHash: 99 }));
    expect(chat.blocked).toBe(false);
  });

  it("does not trigger on exactly 10 heartbeats (threshold is strictly >10)", () => {
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * 30_000);
      expect(
        checkLoop(req("sess-hb-edge", { requestType: "heartbeat", inputHash: i + 1 })).blocked,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Cooldown
// ---------------------------------------------------------------------------

describe("cooldown period", () => {
  // Rule 1 fires at the 21st request (i=20, t=20 000 ms).
  // cooldown.until = 20 000 + 300 000 = 320 000 ms.

  it("blocks all requests while the cooldown is active", () => {
    sendN(21, "sess-cd");
    // 1 s after trigger — solidly in cooldown
    vi.setSystemTime(21_000);
    expect(checkLoop(req("sess-cd")).blocked).toBe(true);
    // 1 s before expiry (319 000 < 320 000)
    vi.setSystemTime(20_000 + 300_000 - 1_000); // = 319 000
    expect(checkLoop(req("sess-cd")).blocked).toBe(true);
  });

  it("allows requests once the cooldown expires", () => {
    sendN(21, "sess-cd-expire");
    // 1 s after expiry (321 000 > 320 000)
    vi.setSystemTime(20_000 + 300_000 + 1_000); // = 321 000
    expect(checkLoop(req("sess-cd-expire", { inputHash: 9999 })).blocked).toBe(false);
  });

  it("sets the correct cooldown duration (base = LOOP_COOLDOWN_SECONDS)", () => {
    sendN(21, "sess-cd-dur");
    const entry = getCooldown("sess-cd-dur");
    expect(entry).toBeDefined();
    expect(entry!.durationMs).toBe(300_000); // 5 min
  });

  it("blocked requests during cooldown do NOT add to the buffer", () => {
    // Trigger loop, then send 100 cooldown-blocked requests.
    // After the cooldown expires the session should be able to make
    // 20 clean requests without re-triggering.
    sendN(21, "sess-cd-buf");
    const triggerTime = 20_000;
    // Spam 100 requests during cooldown — should all be blocked but not buffered
    for (let i = 0; i < 100; i++) {
      vi.setSystemTime(triggerTime + 1_000 + i * 100);
      checkLoop(req("sess-cd-buf", { inputHash: i + 100 }));
    }
    // After cooldown, 20 clean requests should pass (buffer not poisoned)
    const afterCooldown = triggerTime + 300_000 + 1_000;
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(afterCooldown + i * 1_000);
      expect(
        checkLoop(req("sess-cd-buf", { inputHash: i + 1_000 })).blocked,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Exponential backoff
// ---------------------------------------------------------------------------

describe("exponential backoff on repeated loops", () => {
  it("doubles the cooldown on the second loop detection", () => {
    // ---- First loop ----
    sendN(21, "sess-exp");
    const firstEntry = getCooldown("sess-exp")!;
    expect(firstEntry.durationMs).toBe(300_000); // 5 min

    // ---- Advance past first cooldown ----
    // Trigger was at t=20 000; cooldown expires at t=320 000.
    const afterFirst = 20_000 + firstEntry.durationMs + 1_000; // = 321 001
    // Do NOT call _resetState() — we need the cooldown map to survive.

    // ---- Second loop (starts immediately after first cooldown) ----
    for (let i = 0; i < 21; i++) {
      vi.setSystemTime(afterFirst + i * 1_000);
      checkLoop(req("sess-exp", { inputHash: i + 100 })); // unique hashes
    }

    const secondEntry = getCooldown("sess-exp")!;
    expect(secondEntry.durationMs).toBe(600_000); // 10 min (doubled)
  });

  it("caps the backoff at 30 minutes", () => {
    mockConfig.LOOP_COOLDOWN_SECONDS = 60; // 1 min base → easier to reach 30 min cap
    const session = "sess-cap";

    // triggerLoop uses _resetBuffer() — clears old entries but KEEPS cooldown state
    function triggerLoop(baseTimeMs: number) {
      _resetBuffer();
      for (let i = 0; i < 21; i++) {
        vi.setSystemTime(baseTimeMs + i * 1_000);
        checkLoop(req(session, { inputHash: i + 1 }));
      }
    }

    // Expected durations: 1 → 2 → 4 → 8 → 16 → 30 (cap) minutes
    const expectedMin = [1, 2, 4, 8, 16, 30];
    let baseTime = 0;

    for (const expectedMinutes of expectedMin) {
      triggerLoop(baseTime);
      const entry = getCooldown(session)!;
      expect(entry.durationMs).toBe(expectedMinutes * 60_000);
      // Advance past this cooldown for the next iteration
      baseTime += 21_000 + entry.durationMs + 1_000;
      vi.setSystemTime(baseTime);
    }
  });

  it("resets backoff multiplier when previous cooldown ended more than 30 min ago", () => {
    // First loop → 5 min cooldown
    sendN(21, "sess-backoff-reset");
    const firstEntry = getCooldown("sess-backoff-reset")!;
    expect(firstEntry.durationMs).toBe(300_000);

    // Jump 31 min PAST when the cooldown expired (well beyond the 30-min doubling window)
    const quietTime = 20_000 + firstEntry.durationMs + 31 * 60_000; // > 31 min after expiry
    vi.setSystemTime(quietTime);
    _resetBuffer(); // clear old entries; cooldown map is preserved for the check

    // Re-trigger — because >30 min elapsed since last cooldown, duration resets to base
    for (let i = 0; i < 21; i++) {
      vi.setSystemTime(quietTime + i * 1_000);
      checkLoop(req("sess-backoff-reset", { inputHash: i + 100 }));
    }

    const secondEntry = getCooldown("sess-backoff-reset")!;
    expect(secondEntry.durationMs).toBe(300_000); // back to base, not doubled
  });
});

// ---------------------------------------------------------------------------
// Loop that stops and then resumes
// ---------------------------------------------------------------------------

describe("loop that stops and resumes", () => {
  it("allows clean traffic after cooldown with no re-trigger", () => {
    sendN(21, "sess-resume");
    const afterCooldown = 20_000 + 300_000 + 1_000; // = 321 001

    // 5 spread-out clean requests after the cooldown
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(afterCooldown + i * 10_000);
      expect(
        checkLoop(req("sess-resume", { inputHash: i + 500 })).blocked,
      ).toBe(false);
    }
  });

  it("re-triggers with doubled cooldown if the loop resumes immediately after cooldown", () => {
    sendN(21, "sess-resume-loop");
    const firstDuration  = getCooldown("sess-resume-loop")!.durationMs; // 300 000
    const afterFirst     = 20_000 + firstDuration + 1_000;

    // Second loop burst starts right after the first cooldown expires
    for (let i = 0; i < 21; i++) {
      vi.setSystemTime(afterFirst + i * 1_000);
      checkLoop(req("sess-resume-loop", { inputHash: i + 200 }));
    }

    const secondEntry = getCooldown("sess-resume-loop")!;
    expect(secondEntry.durationMs).toBe(firstDuration * 2); // 600 000
  });
});

// ---------------------------------------------------------------------------
// Circular buffer — memory is bounded
// ---------------------------------------------------------------------------

describe("circular buffer memory bound", () => {
  it("never throws even when more than 100 entries are written", () => {
    // 150 requests — forces two full wraps of the 100-slot buffer
    for (let i = 0; i < 150; i++) {
      vi.setSystemTime(i * 100_000); // far apart → no loop trigger
      checkLoop(req(`sess-buf-${i % 5}`, { inputHash: i + 1 }));
    }
    expect(() => checkLoop(req("sess-buf-0", { inputHash: 9999 }))).not.toThrow();
  });
});
