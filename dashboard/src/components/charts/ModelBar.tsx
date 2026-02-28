import { motion } from "framer-motion";
import type { ModelCostRow } from "../../types";

const COLORS = [
  "#E63946", "#3B82F6", "#00D4AA", "#F59E0B",
  "#8B5CF6", "#EC4899", "#14B8A6", "#F97316",
];

interface ModelBarProps {
  data: ModelCostRow[];
}

function shortModel(model: string): string {
  return model
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "gpt-")
    .replace(/^gemini-/, "gemini-");
}

export function ModelBar({ data }: ModelBarProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted text-sm">
        No model data for this period
      </div>
    );
  }

  const max = data[0]?.cost ?? 1;

  return (
    <div className="space-y-3">
      {data.slice(0, 6).map((row, i) => {
        const pct     = (row.cost / max) * 100;
        const color   = COLORS[i % COLORS.length];
        const total   = data.reduce((s, r) => s + r.cost, 0);
        const sharePct = total > 0 ? (row.cost / total * 100).toFixed(0) : "0";

        return (
          <div key={row.model}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-secondary font-mono truncate max-w-[60%]">
                {shortModel(row.model)}
              </span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-muted">{sharePct}%</span>
                <span className="text-primary font-mono font-medium">
                  ${row.cost.toFixed(4)}
                </span>
              </div>
            </div>
            <div className="h-1.5 bg-surface-el rounded-full overflow-hidden">
              <motion.div
                className="h-full rounded-full"
                style={{ backgroundColor: color }}
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.8, delay: i * 0.08, ease: "easeOut" }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
