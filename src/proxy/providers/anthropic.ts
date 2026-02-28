export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

export const anthropicProvider = {
  name: "anthropic" as const,
  baseUrl: ANTHROPIC_BASE_URL,

  parseRequest(body: Record<string, unknown>) {
    const messages =
      (body.messages as Array<{ role: string; content: unknown }>) ?? [];

    // system can be a plain string or an array of content blocks
    const sys = body.system;
    const systemText =
      typeof sys === "string"
        ? sys
        : Array.isArray(sys)
          ? (sys as Array<{ text?: string }>)
              .map((b) => b.text ?? "")
              .join(" ")
          : "";

    return {
      model: (body.model as string) ?? "unknown",
      isStreaming: body.stream === true,
      messages,
      hasTools:
        Array.isArray(body.tools) &&
        (body.tools as unknown[]).length > 0,
      systemText,
    };
  },

  parseUsage(body: Record<string, unknown>) {
    const u = (body.usage ?? {}) as Record<string, number>;
    return {
      inputTokens:      u.input_tokens                  ?? 0,
      outputTokens:     u.output_tokens                 ?? 0,
      cacheReadTokens:  u.cache_read_input_tokens        ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens    ?? 0,
    };
  },

  buildHeaders(
    incoming: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type":    "application/json",
      "accept-encoding": "identity", // No compression — we pass through plaintext
    };

    // User's API key — Anthropic wants x-api-key, strip Bearer prefix if present
    const auth = incoming["authorization"] ?? incoming["x-api-key"];
    if (auth) {
      const s = Array.isArray(auth) ? auth[0]! : auth;
      headers["x-api-key"] = s.startsWith("Bearer ") ? s.slice(7) : s;
    }

    // Pass through Anthropic-specific headers
    for (const h of ["anthropic-version", "anthropic-beta"] as const) {
      const v = incoming[h];
      if (v) headers[h] = Array.isArray(v) ? v[0]! : v;
    }

    // Guarantee a valid API version — Anthropic rejects requests without it
    if (!headers["anthropic-version"]) {
      headers["anthropic-version"] = "2023-06-01";
    }

    return headers;
  },

  // /v1/messages stays as /v1/messages on api.anthropic.com
  upstreamPath(requestPath: string): string {
    return requestPath;
  },

  formatBlockedError(reason: string, message: string): Record<string, unknown> {
    return {
      type: "error",
      error: {
        type: reason === "loop_detected" ? "overloaded_error" : "rate_limit_error",
        message: `[TokPinch] ${message}`,
      },
    };
  },
};

export type AnthropicProvider = typeof anthropicProvider;
