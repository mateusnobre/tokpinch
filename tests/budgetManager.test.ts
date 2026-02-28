/**
 * Budget Manager — unit tests
 *
 * Uses an in-memory SQLite DB (":memory:") — fast, no disk artefacts.
 *
 * config.js is mocked with a mutable object so each test group can set
 * BUDGET_DAILY / BUDGET_MONTHLY independently before calling initializeBudgets().
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock config BEFORE any module that transitively imports it (logger, budgetManager …)
// vi.hoisted() runs before imports are resolved.
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
  LOG_LEVEL:      "silent" as const,   // suppress log output during tests
  NODE_ENV:       "test"   as const,
  BUDGET_DAILY:   undefined as number | undefined,
  BUDGET_MONTHLY: undefined as number | undefined,
}));

vi.mock("../src/config.js", () => ({ config: mockConfig }));

// ---------------------------------------------------------------------------
// Now import the modules that depend on config
// ---------------------------------------------------------------------------

import { initDb, closeDb } from "../src/db/index.js";
import {
  initializeBudgets,
  checkBudget,
  recordActualSpend,
  getBudgetStatus,
  resetDailyBudget,
  resetMonthlyBudget,
  overridePause,
} from "../src/services/budgetManager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(daily?: number, monthly?: number) {
  mockConfig.BUDGET_DAILY   = daily;
  mockConfig.BUDGET_MONTHLY = monthly;
  initDb(":memory:");
  initializeBudgets();
}

function teardown() {
  closeDb();
}

// ---------------------------------------------------------------------------
// No budgets configured
// ---------------------------------------------------------------------------

describe("no budgets configured", () => {
  beforeEach(() => setup());
  afterEach(teardown);

  it("allows every request when no limits are set", () => {
    const result = checkBudget(9_999_999);
    expect(result.allowed).toBe(true);
    expect(result.remainingUsd).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// Daily budget — state transitions: ACTIVE → WARNING → PAUSED
// ---------------------------------------------------------------------------

describe("daily budget state transitions", () => {
  beforeEach(() => setup(/* daily= */ 1.0));
  afterEach(teardown);

  it("starts ACTIVE with zero spend", () => {
    const { daily } = getBudgetStatus();
    expect(daily?.status).toBe("active");
    expect(daily?.currentSpend).toBe(0);
  });

  it("allows a request well under the limit", () => {
    const result = checkBudget(0.10);
    expect(result.allowed).toBe(true);

    const { daily } = getBudgetStatus();
    expect(daily?.currentSpend).toBeCloseTo(0.10);
    expect(daily?.status).toBe("active");
  });

  it("transitions to WARNING at 80 % spend", () => {
    // $0.80 of $1.00 = exactly 80 %
    checkBudget(0.80);
    const { daily } = getBudgetStatus();
    expect(daily?.status).toBe("warning");
    expect(daily?.currentSpend).toBeCloseTo(0.80);
  });

  it("transitions to PAUSED when a request would exceed the limit", () => {
    checkBudget(0.90);
    recordActualSpend(0.90, 0.90);

    // Would push us to $1.10 — over the $1.00 limit
    const result = checkBudget(0.20);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/budget/i);

    const { daily } = getBudgetStatus();
    expect(daily?.status).toBe("paused");
  });

  it("blocks ALL requests once PAUSED, even tiny ones", () => {
    checkBudget(0.90);
    recordActualSpend(0.90, 0.90);
    checkBudget(0.20); // triggers pause

    const result = checkBudget(0.001);
    expect(result.allowed).toBe(false);
  });

  it("includes a non-negative remainingUsd when blocked", () => {
    checkBudget(0.70);
    recordActualSpend(0.70, 0.70);

    const result = checkBudget(0.50); // would push to $1.20
    expect(result.allowed).toBe(false);
    expect(result.remainingUsd).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case — request that exactly hits the limit
// ---------------------------------------------------------------------------

describe("daily budget exact hit", () => {
  beforeEach(() => setup(/* daily= */ 0.50));
  afterEach(teardown);

  it("allows a request that exactly fills remaining budget", () => {
    checkBudget(0.30);
    recordActualSpend(0.30, 0.30);

    // $0.20 left — a $0.20 request must be ALLOWED (0.30 + 0.20 = 0.50 ≤ 0.50)
    const exactFit = checkBudget(0.20);
    expect(exactFit.allowed).toBe(true);
  });

  it("blocks the very next request after the limit is exactly filled", () => {
    checkBudget(0.30);
    recordActualSpend(0.30, 0.30);
    checkBudget(0.20);
    recordActualSpend(0.20, 0.20); // now at exactly $0.50

    const overflow = checkBudget(0.01);
    expect(overflow.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent requests — only one can pass when one fits
// ---------------------------------------------------------------------------

describe("concurrent-style budget enforcement", () => {
  beforeEach(() => setup(/* daily= */ 0.10));
  afterEach(teardown);

  it("only allows the first of two simultaneous requests if only one fits", () => {
    // Both arrive before either records actual spend.
    // Node.js single-threaded guarantee makes checkBudget() atomic.
    const first  = checkBudget(0.07);
    const second = checkBudget(0.07); // 0.07 + 0.07 = 0.14 > 0.10

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });

  it("allows a retry after the first request is refunded on upstream error", () => {
    const first = checkBudget(0.07);
    expect(first.allowed).toBe(true);

    // Upstream failed — refund the reservation
    recordActualSpend(0.07, 0);

    // Room is available again
    const retry = checkBudget(0.07);
    expect(retry.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordActualSpend — cost reconciliation
// ---------------------------------------------------------------------------

describe("recordActualSpend reconciliation", () => {
  beforeEach(() => setup(/* daily= */ 1.0));
  afterEach(teardown);

  it("adjusts spend downward when actual < estimated", () => {
    checkBudget(0.50);
    recordActualSpend(0.50, 0.30); // over-estimated by $0.20

    const { daily } = getBudgetStatus();
    expect(daily?.currentSpend).toBeCloseTo(0.30);
  });

  it("adjusts spend upward when actual > estimated", () => {
    checkBudget(0.20);
    recordActualSpend(0.20, 0.35);

    const { daily } = getBudgetStatus();
    expect(daily?.currentSpend).toBeCloseTo(0.35);
  });

  it("fully refunds on API failure (actual = 0)", () => {
    checkBudget(0.40);
    recordActualSpend(0.40, 0);

    const { daily } = getBudgetStatus();
    expect(daily?.currentSpend).toBeCloseTo(0);
    expect(daily?.status).toBe("active");
  });

  it("spend never goes below zero on over-refund", () => {
    checkBudget(0.10);
    recordActualSpend(0.10, 0);
    // Spurious second refund (shouldn't happen in practice, but must be safe)
    recordActualSpend(0.10, 0);

    const { daily } = getBudgetStatus();
    expect(daily!.currentSpend).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Daily budget reset — midnight UTC rollover
// ---------------------------------------------------------------------------

describe("resetDailyBudget", () => {
  beforeEach(() => setup(/* daily= */ 0.50));
  afterEach(teardown);

  it("resets spend to zero and status to active", () => {
    checkBudget(0.40);
    recordActualSpend(0.40, 0.40);
    checkBudget(0.20); // trips the limit → paused

    expect(getBudgetStatus().daily?.status).toBe("paused");

    const tomorrow = "2099-01-02";
    resetDailyBudget(tomorrow);

    const { daily } = getBudgetStatus();
    expect(daily?.currentSpend).toBe(0);
    expect(daily?.status).toBe("active");
    expect(daily?.periodStart).toBe(tomorrow);
  });

  it("allows requests again after reset", () => {
    checkBudget(0.50); // exhausts budget
    resetDailyBudget("2099-01-02");

    const result = checkBudget(0.10);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Monthly budget
// ---------------------------------------------------------------------------

describe("monthly budget", () => {
  beforeEach(() => setup(/* daily= */ 5.0, /* monthly= */ 1.0));
  afterEach(teardown);

  it("blocks when monthly limit is hit even though daily has room", () => {
    checkBudget(0.90);
    recordActualSpend(0.90, 0.90);

    // Would push monthly to $1.10 — blocked
    const result = checkBudget(0.20);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/monthly/i);
    expect(getBudgetStatus().monthly?.status).toBe("paused");
  });

  it("refunds the daily reservation when monthly blocks", () => {
    checkBudget(0.90);
    recordActualSpend(0.90, 0.90);

    const dailyBefore = getBudgetStatus().daily?.currentSpend ?? 0;

    checkBudget(0.20); // monthly blocks — daily reservation must be refunded

    const dailyAfter = getBudgetStatus().daily?.currentSpend ?? 0;
    expect(dailyAfter).toBeCloseTo(dailyBefore, 6);
  });

  it("resets monthly spend on resetMonthlyBudget", () => {
    checkBudget(0.90);
    recordActualSpend(0.90, 0.90);
    checkBudget(0.20); // trips monthly

    resetMonthlyBudget("2099-02-01");

    const { monthly } = getBudgetStatus();
    expect(monthly?.currentSpend).toBe(0);
    expect(monthly?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Override — manual resume after pause
// ---------------------------------------------------------------------------

describe("overridePause", () => {
  beforeEach(() => setup(/* daily= */ 0.10));
  afterEach(teardown);

  it("transitions PAUSED → OVERRIDE and allows requests again", () => {
    // Exhaust the daily budget
    checkBudget(0.08);
    recordActualSpend(0.08, 0.08);
    checkBudget(0.05); // over limit → paused

    expect(getBudgetStatus().daily?.status).toBe("paused");

    overridePause("daily");
    expect(getBudgetStatus().daily?.status).toBe("override");

    const result = checkBudget(0.01);
    expect(result.allowed).toBe(true);
  });

  it("keeps status as OVERRIDE after further spend (does not downgrade)", () => {
    checkBudget(0.08);
    recordActualSpend(0.08, 0.08);
    checkBudget(0.05); // paused
    overridePause("daily");

    checkBudget(0.05);
    recordActualSpend(0.05, 0.05);

    expect(getBudgetStatus().daily?.status).toBe("override");
  });

  it("returns allowed: true when status is override even with spend above limit", () => {
    checkBudget(0.08);
    recordActualSpend(0.08, 0.08);
    checkBudget(0.05); // paused (now $0.08 + $0.05 = $0.13, over $0.10)
    overridePause("daily");

    // Even though we're over the limit, override lets requests through
    const result = checkBudget(0.01);
    expect(result.allowed).toBe(true);
  });
});
