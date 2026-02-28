import { motion } from "framer-motion";
import { Badge } from "./Badge";
import type { BudgetState } from "../../types";

interface BudgetGaugeProps {
  budget: BudgetState;
  label:  string;
}

const SIZE      = 140;
const STROKE    = 10;
const R         = (SIZE - STROKE) / 2;
const CIRC      = 2 * Math.PI * R;
const ARC_FRAC  = 0.75; // 270° arc
const ARC_LEN   = CIRC * ARC_FRAC;
const OFFSET    = CIRC * (1 - ARC_FRAC) / 2;

function arcColor(pct: number): string {
  if (pct >= 1)    return "#E63946"; // accent (paused/over)
  if (pct >= 0.8)  return "#F59E0B"; // warning
  return "#00D4AA";                  // success
}

export function BudgetGauge({ budget, label }: BudgetGaugeProps) {
  const pct      = Math.min(budget.currentSpend / budget.limitUsd, 1);
  const dashLen  = ARC_LEN * pct;
  const color    = arcColor(pct);

  // SVG rotation so arc starts from bottom-left (225°)
  const rotate   = 135;

  return (
    <div className="flex flex-col items-center gap-3">
      <span className="text-xs font-medium text-secondary uppercase tracking-wider">{label}</span>
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          {/* Track */}
          <circle
            cx={SIZE / 2} cy={SIZE / 2} r={R}
            fill="none" stroke="#27272A" strokeWidth={STROKE}
            strokeDasharray={`${ARC_LEN} ${CIRC - ARC_LEN}`}
            strokeDashoffset={CIRC - OFFSET}
            strokeLinecap="round"
            transform={`rotate(${rotate} ${SIZE/2} ${SIZE/2})`}
          />
          {/* Progress */}
          <motion.circle
            cx={SIZE / 2} cy={SIZE / 2} r={R}
            fill="none" stroke={color} strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${dashLen} ${CIRC - dashLen}`}
            strokeDashoffset={CIRC - OFFSET}
            transform={`rotate(${rotate} ${SIZE/2} ${SIZE/2})`}
            initial={{ strokeDasharray: `0 ${CIRC}` }}
            animate={{ strokeDasharray: `${dashLen} ${CIRC - dashLen}` }}
            transition={{ duration: 1, ease: "easeOut", delay: 0.2 }}
            style={{ filter: `drop-shadow(0 0 6px ${color}60)` }}
          />
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-xl font-semibold text-primary tabular-nums">
            {(pct * 100).toFixed(0)}%
          </span>
          <span className="text-xs text-muted mt-0.5">used</span>
        </div>
      </div>

      <Badge status={budget.status} />

      <div className="text-center space-y-0.5">
        <div className="font-mono text-sm text-primary">
          ${budget.currentSpend.toFixed(2)}
          <span className="text-muted"> / ${budget.limitUsd.toFixed(2)}</span>
        </div>
        <div className="text-xs text-muted">
          ${Math.max(0, budget.limitUsd - budget.currentSpend).toFixed(2)} remaining
        </div>
      </div>
    </div>
  );
}
