import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useCountUp } from "../../hooks/useCountUp";

interface StatCardProps {
  label:       string;
  value:       number;
  format:      "currency" | "count" | "percent";
  icon:        LucideIcon;
  iconColor?:  string;
  valueColor?: string;
  subtitle?:   string;
  trend?:      number; // positive = up, negative = down
  delay?:      number;
}

function formatValue(v: number, format: StatCardProps["format"]): string {
  if (format === "currency") {
    if (v >= 100) return `$${v.toFixed(2)}`;
    if (v >= 1)   return `$${v.toFixed(4)}`;
    return `$${v.toFixed(6)}`;
  }
  if (format === "percent") return `${v.toFixed(1)}%`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function StatCard({
  label, value, format, icon: Icon, iconColor = "text-muted",
  valueColor = "text-primary", subtitle, trend, delay = 0,
}: StatCardProps) {
  const animated = useCountUp(value);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: "easeOut" }}
      className="card-hover relative rounded-xl border border-border bg-surface p-5 overflow-hidden group hover:border-border/80"
    >
      {/* Subtle gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />

      <div className="flex items-start justify-between mb-3">
        <span className="text-xs font-medium text-secondary uppercase tracking-wider">{label}</span>
        <div className={`p-1.5 rounded-lg bg-surface-el ${iconColor} group-hover:scale-110 transition-transform`}>
          <Icon size={16} />
        </div>
      </div>

      <div className={`font-mono text-3xl font-semibold ${valueColor} tabular-nums`}>
        {formatValue(animated, format)}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {trend !== undefined && (
          <span className={`flex items-center gap-0.5 text-xs font-medium ${trend >= 0 ? "text-accent" : "text-success"}`}>
            {trend >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {Math.abs(trend).toFixed(0)} vs yesterday
          </span>
        )}
        {subtitle && (
          <span className="text-xs text-muted">{subtitle}</span>
        )}
      </div>
    </motion.div>
  );
}
