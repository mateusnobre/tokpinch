import { anthropicProvider, type AnthropicProvider } from "./anthropic.js";
import { openaiProvider, type OpenAIProvider } from "./openai.js";

export type ProviderAdapter = AnthropicProvider | OpenAIProvider;

export { anthropicProvider, openaiProvider };

/**
 * Detect which provider should handle a given request path.
 *
 * Routing:
 *   /v1/*           → Anthropic (api.anthropic.com)
 *   /openai/v1/*    → OpenAI   (api.openai.com)
 */
export function getProvider(urlPath: string): ProviderAdapter | null {
  if (urlPath.startsWith("/openai/")) return openaiProvider;
  if (urlPath.startsWith("/v1/"))     return anthropicProvider;
  return null;
}
