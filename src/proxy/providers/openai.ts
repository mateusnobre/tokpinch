export const OPENAI_BASE_URL = "https://api.openai.com";

export const openaiProvider = {
  name: "openai" as const,
  baseUrl: OPENAI_BASE_URL,

  parseRequest(body: Record<string, unknown>) {
    const messages =
      (body.messages as Array<{ role: string; content: unknown }>) ?? [];

    // For OpenAI the system prompt is a message with role="system"
    const sysMsgContent = messages.find((m) => m.role === "system")?.content;
    const systemText =
      typeof sysMsgContent === "string" ? sysMsgContent : "";

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
      inputTokens:      u.prompt_tokens     ?? 0,
      outputTokens:     u.completion_tokens  ?? 0,
      cacheReadTokens:  0,
      cacheWriteTokens: 0,
    };
  },

  buildHeaders(
    incoming: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type":    "application/json",
      "accept-encoding": "identity",
    };

    // OpenAI uses Authorization: Bearer sk-...
    const auth = incoming["authorization"] ?? incoming["x-api-key"];
    if (auth) {
      const s = Array.isArray(auth) ? auth[0]! : auth;
      headers["authorization"] = s.startsWith("Bearer ") ? s : `Bearer ${s}`;
    }

    return headers;
  },

  // Strip the /openai prefix we added to our route: /openai/v1/... → /v1/...
  upstreamPath(requestPath: string): string {
    return requestPath.replace(/^\/openai/, "");
  },

  formatBlockedError(reason: string, message: string): Record<string, unknown> {
    return {
      error: {
        message: `[TokPinch] ${message}`,
        type:    reason === "loop_detected" ? "server_error" : "insufficient_quota",
        code:    reason,
      },
    };
  },
};

export type OpenAIProvider = typeof openaiProvider;
