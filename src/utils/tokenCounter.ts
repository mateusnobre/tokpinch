/**
 * Rough pre-request token estimator.
 *
 * ONLY used for pre-flight budget checks — the actual token counts always
 * come from the API response's `usage` field and are logged from there.
 *
 * Rule of thumb: 1 token ≈ 4 characters for English text.
 */

type ContentBlock = { type?: string; text?: string };
type Message = { role: string; content: unknown };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateRequestTokens(messages: Message[]): number {
  let total = 3; // Priming tokens added by the API
  for (const msg of messages) {
    total += estimateTokens(contentToText(msg.content));
    total += 4; // Per-message overhead (role + separator)
  }
  return total;
}
