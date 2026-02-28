import type { BudgetStatus } from "../../types";

interface BadgeProps {
  status: BudgetStatus | "routed" | "blocked";
}

const styles: Record<string, string> = {
  active:   "bg-success/10 text-success border-success/20",
  warning:  "bg-warning/10 text-warning border-warning/20",
  paused:   "bg-accent/10 text-accent border-accent/20",
  override: "bg-info/10 text-info border-info/20",
  routed:   "bg-info/10 text-info border-info/20",
  blocked:  "bg-accent/10 text-accent border-accent/20",
};

const pulseStatuses = new Set(["warning", "paused"]);

export function Badge({ status }: BadgeProps) {
  const isPulsing = pulseStatuses.has(status);
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-mono font-medium rounded border ${styles[status] ?? styles.active}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${isPulsing ? "animate-pulse2" : ""}`} />
      {status.toUpperCase()}
    </span>
  );
}
