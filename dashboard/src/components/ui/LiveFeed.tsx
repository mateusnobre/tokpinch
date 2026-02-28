import { motion, AnimatePresence } from "framer-motion";
import { Shield, Zap, MessageSquare, Activity } from "lucide-react";
import type { WsRequestEvent } from "../../types";

export interface FeedItem {
  id:           string;
  timestamp:    number;
  model:        string;
  originalModel?: string | null;
  provider:     string;
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number;
  durationMs:   number;
  blocked:      boolean;
  sessionId?:   string | null;
}

interface LiveFeedProps {
  items: FeedItem[];
}

function ModelIcon({ type }: { type: string }) {
  if (type === "heartbeat") return <Activity size={13} className="text-info" />;
  if (type === "tool_call")  return <Zap      size={13} className="text-warning" />;
  return <MessageSquare size={13} className="text-secondary" />;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5000)   return "just now";
  if (diff < 60000)  return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

function shortModel(model: string): string {
  // claude-sonnet-4-20250514 → claude-sonnet-4
  return model.replace(/-\d{8}$/, "").replace(/^claude-/, "").replace(/^gpt-/, "gpt-");
}

export function LiveFeed({ items }: LiveFeedProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted">
        <Activity size={32} className="mb-2 opacity-30" />
        <span className="text-sm">Waiting for requests…</span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 overflow-hidden">
      <AnimatePresence mode="popLayout" initial={false}>
        {items.map((item) => (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: -20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-xs transition-all ${
              item.blocked
                ? "bg-accent/5 border-accent/20"
                : "bg-surface-el border-border/50"
            }`}
          >
            {item.blocked ? (
              <Shield size={13} className="text-accent flex-shrink-0" />
            ) : (
              <ModelIcon type="chat" />
            )}

            <div className="flex-1 min-w-0">
              <span className={`font-mono font-medium truncate ${item.blocked ? "text-accent" : "text-primary"}`}>
                {item.originalModel ? (
                  <>
                    <span className="line-through text-muted mr-1">{shortModel(item.originalModel)}</span>
                    {shortModel(item.model)}
                  </>
                ) : shortModel(item.model)}
              </span>
              {item.sessionId && (
                <span className="ml-2 text-muted truncate">{item.sessionId.slice(0, 8)}</span>
              )}
            </div>

            <div className="flex items-center gap-2 text-muted flex-shrink-0">
              <span className="font-mono">{(item.inputTokens + item.outputTokens).toLocaleString()} tok</span>
              <span className="font-mono text-accent">${item.costUsd.toFixed(4)}</span>
              <span className="text-muted">{relativeTime(item.timestamp)}</span>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function wsEventToFeedItem(event: WsRequestEvent["data"]): FeedItem {
  return {
    id:           event.requestId,
    timestamp:    Date.now(),
    model:        event.model,
    originalModel: event.originalModel,
    provider:     event.provider,
    inputTokens:  event.inputTokens,
    outputTokens: event.outputTokens,
    costUsd:      event.costUsd,
    durationMs:   event.durationMs,
    blocked:      event.blocked,
    sessionId:    event.sessionId,
  };
}
