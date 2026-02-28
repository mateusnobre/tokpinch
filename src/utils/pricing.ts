export interface ModelPricing {
  /** USD per million input tokens */
  inputPerM: number;
  /** USD per million output tokens */
  outputPerM: number;
  /** USD per million cache-read tokens (Anthropic prompt caching) */
  cacheReadPerM?: number;
  /** USD per million cache-write tokens (Anthropic prompt caching) */
  cacheWritePerM?: number;
}

// ---------------------------------------------------------------------------
// Pricing table — USD per million tokens, current as of mid-2025.
// Ordered longest-prefix-first so the prefix match below is unambiguous.
// ---------------------------------------------------------------------------

const PRICING_TABLE: Array<[string, ModelPricing]> = [
  // Claude 4
  ["claude-opus-4",     { inputPerM: 15,   outputPerM: 75,   cacheReadPerM: 1.50,  cacheWritePerM: 18.75 }],
  ["claude-sonnet-4",   { inputPerM: 3,    outputPerM: 15,   cacheReadPerM: 0.30,  cacheWritePerM: 3.75  }],
  // Claude 3.5
  ["claude-sonnet-3-5", { inputPerM: 3,    outputPerM: 15,   cacheReadPerM: 0.30,  cacheWritePerM: 3.75  }],
  ["claude-haiku-3-5",  { inputPerM: 0.80, outputPerM: 4,    cacheReadPerM: 0.08,  cacheWritePerM: 1.00  }],
  // Claude 3
  ["claude-opus-3",     { inputPerM: 15,   outputPerM: 75,   cacheReadPerM: 1.50,  cacheWritePerM: 18.75 }],
  ["claude-sonnet-3",   { inputPerM: 3,    outputPerM: 15,   cacheReadPerM: 0.30,  cacheWritePerM: 3.75  }],
  ["claude-haiku-3",    { inputPerM: 0.25, outputPerM: 1.25, cacheReadPerM: 0.03,  cacheWritePerM: 0.30  }],
  // OpenAI — longer names first to avoid gpt-4 eating gpt-4o/gpt-4.1
  ["gpt-4.1-nano",      { inputPerM: 0.10, outputPerM: 0.40  }],
  ["gpt-4.1-mini",      { inputPerM: 0.40, outputPerM: 1.60  }],
  ["gpt-4.1",           { inputPerM: 2,    outputPerM: 8     }],
  ["gpt-4o-mini",       { inputPerM: 0.15, outputPerM: 0.60  }],
  ["gpt-4o",            { inputPerM: 2.50, outputPerM: 10    }],
  ["gpt-4-turbo",       { inputPerM: 10,   outputPerM: 30    }],
  ["gpt-4",             { inputPerM: 30,   outputPerM: 60    }],
  ["gpt-3.5-turbo",     { inputPerM: 0.50, outputPerM: 1.50  }],
  // Gemini
  ["gemini-2.5-pro",    { inputPerM: 1.25, outputPerM: 10    }],
  ["gemini-2.5-flash",  { inputPerM: 0.15, outputPerM: 0.60  }],
  ["gemini-2.0-flash",  { inputPerM: 0.10, outputPerM: 0.40  }],
];

/**
 * Look up pricing for a model ID.
 * Tries exact match first, then prefix match (e.g. "claude-sonnet-4-20250514"
 * matches the "claude-sonnet-4" entry).
 */
export function getPricing(model: string): ModelPricing | undefined {
  const m = model.toLowerCase();
  for (const [key, pricing] of PRICING_TABLE) {
    if (m === key || m.startsWith(key + "-")) return pricing;
  }
  return undefined;
}

/**
 * Calculate USD cost for a completed request.
 * Falls back to claude-sonnet-4 pricing for unknown models so no cost is
 * silently swallowed — unknown model costs show up as non-zero estimates.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  // Fallback: Sonnet-class pricing — conservative but not zero
  const p = getPricing(model) ?? { inputPerM: 3, outputPerM: 15 };
  return (
    (inputTokens      * p.inputPerM)                     / 1_000_000 +
    (outputTokens     * p.outputPerM)                    / 1_000_000 +
    (cacheReadTokens  * (p.cacheReadPerM  ?? 0))         / 1_000_000 +
    (cacheWriteTokens * (p.cacheWritePerM ?? 0))         / 1_000_000
  );
}
