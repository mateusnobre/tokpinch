import { Transform, type TransformCallback } from "node:stream";

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * A Transform stream that passes every byte through UNCHANGED and IMMEDIATELY,
 * while also parsing the SSE event stream on the side to extract token usage.
 *
 * When the stream ends, `onFinished` is called with the accumulated usage.
 *
 * Handles both Anthropic and OpenAI SSE formats:
 *
 *   Anthropic:
 *     message_start → usage.input_tokens  (+ cache_read/write)
 *     message_delta → usage.output_tokens
 *
 *   OpenAI (requires stream_options.include_usage = true in request):
 *     last data chunk before [DONE] → usage.prompt_tokens / completion_tokens
 */
export class SSEInterceptor extends Transform {
  private textBuffer = "";
  readonly usage: StreamUsage = {
    inputTokens:      0,
    outputTokens:     0,
    cacheReadTokens:  0,
    cacheWriteTokens: 0,
  };
  private readonly onFinished: (usage: StreamUsage) => void;

  constructor(onFinished: (usage: StreamUsage) => void) {
    super();
    this.onFinished = onFinished;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback): void {
    this.push(chunk); // Forward immediately — zero added latency
    this.textBuffer += chunk.toString("utf8");
    this.parseBuffer();
    cb();
  }

  _flush(cb: TransformCallback): void {
    // Parse any remaining bytes in the buffer
    if (this.textBuffer.trim()) {
      this.parseEvent(this.textBuffer);
    }
    this.onFinished(this.usage);
    cb();
  }

  private parseBuffer(): void {
    // SSE events are delimited by double-newlines
    const events = this.textBuffer.split("\n\n");
    // Keep the last (potentially incomplete) chunk in the buffer
    this.textBuffer = events.pop() ?? "";
    for (const event of events) {
      this.parseEvent(event);
    }
  }

  private parseEvent(event: string): void {
    // Extract the data: line from the event block
    const dataLine = event
      .split("\n")
      .find((l) => l.startsWith("data: "));

    if (!dataLine) return;

    const jsonStr = dataLine.slice("data: ".length).trim();
    if (!jsonStr || jsonStr === "[DONE]") return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return; // Malformed JSON — ignore silently, never crash the proxy
    }

    this.extractUsage(parsed);
  }

  private extractUsage(ev: Record<string, unknown>): void {
    const type = ev.type as string | undefined;

    // ----- Anthropic -------------------------------------------------------
    // message_start carries input token counts (and cache stats)
    if (type === "message_start") {
      const msg = ev.message as Record<string, unknown> | undefined;
      const u = msg?.usage as Record<string, number> | undefined;
      if (u) {
        this.usage.inputTokens      += u.input_tokens                  ?? 0;
        this.usage.cacheReadTokens  += u.cache_read_input_tokens        ?? 0;
        this.usage.cacheWriteTokens += u.cache_creation_input_tokens    ?? 0;
      }
    }

    // message_delta carries output token count
    if (type === "message_delta") {
      const u = ev.usage as Record<string, number> | undefined;
      if (u) {
        this.usage.outputTokens += u.output_tokens ?? 0;
      }
    }

    // ----- OpenAI ----------------------------------------------------------
    // Usage appears in the last chunk when stream_options.include_usage=true.
    // These chunks have no `type` field (that's Anthropic-specific).
    if (!type && ev.usage && typeof ev.usage === "object") {
      const u = ev.usage as Record<string, number>;
      // Overwrite rather than accumulate — OpenAI gives cumulative totals
      if (u.prompt_tokens     !== undefined) this.usage.inputTokens  = u.prompt_tokens;
      if (u.completion_tokens !== undefined) this.usage.outputTokens = u.completion_tokens;
    }
  }
}
