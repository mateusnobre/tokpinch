import { useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { DailyCostRow, HourlyCostRow } from "../../types";

type TimeRange = "today" | "week" | "month";

interface CostChartProps {
  hourlyData: HourlyCostRow[];
  dailyData:  DailyCostRow[];
}

interface ChartPoint {
  label: string;
  cost:  number;
  requests: number;
}

function hourlyToPoints(data: HourlyCostRow[]): ChartPoint[] {
  return data.map((h) => ({
    label:    `${String(h.hour).padStart(2, "0")}:00`,
    cost:     h.cost,
    requests: h.request_count,
  }));
}

function dailyToPoints(data: DailyCostRow[]): ChartPoint[] {
  return data.map((d) => ({
    label:    d.date.slice(5),  // MM-DD
    cost:     d.total_cost,
    requests: d.request_count,
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const cost = payload[0]?.value as number;
  const reqs = payload[1]?.value as number;
  return (
    <div className="bg-surface-el border border-border rounded-lg p-3 shadow-xl text-xs">
      <div className="font-mono text-muted mb-1">{label}</div>
      <div className="font-mono text-accent font-medium">${cost?.toFixed(6)}</div>
      <div className="text-muted">{reqs} request{reqs !== 1 ? "s" : ""}</div>
    </div>
  );
}

export function CostChart({ hourlyData, dailyData }: CostChartProps) {
  const [range, setRange] = useState<TimeRange>("today");

  const points =
    range === "today"
      ? hourlyToPoints(hourlyData)
      : range === "week"
      ? dailyToPoints(dailyData.slice(-7))
      : dailyToPoints(dailyData);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-head font-semibold text-primary">Cost Over Time</h3>
        <div className="flex gap-1">
          {(["today", "week", "month"] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                range === r
                  ? "bg-accent text-white"
                  : "text-muted hover:text-secondary hover:bg-surface-el"
              }`}
            >
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#E63946" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#E63946" stopOpacity={0.0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#27272A" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "#71717A", fontFamily: "JetBrains Mono" }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#71717A", fontFamily: "JetBrains Mono" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => v === 0 ? "0" : `$${v.toFixed(v < 0.01 ? 4 : 2)}`}
            width={60}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="cost"
            stroke="#E63946"
            strokeWidth={2}
            fill="url(#costGrad)"
            dot={false}
            activeDot={{ r: 4, fill: "#E63946", stroke: "#09090B", strokeWidth: 2 }}
            isAnimationActive={true}
            animationDuration={800}
          />
          <Area
            type="monotone"
            dataKey="requests"
            stroke="transparent"
            fill="transparent"
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
