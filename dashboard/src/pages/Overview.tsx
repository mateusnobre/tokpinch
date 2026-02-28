import { useEffect, useState, useRef, useCallback } from "react";
import { DollarSign, Calendar, Activity, Zap } from "lucide-react";
import { Layout } from "../components/layout/Layout";
import { StatCard } from "../components/ui/StatCard";
import { StatCardSkeleton, ChartSkeleton, Skeleton } from "../components/ui/Skeleton";
import { BudgetGauge } from "../components/ui/BudgetGauge";
import { CostChart } from "../components/charts/CostChart";
import { ModelBar } from "../components/charts/ModelBar";
import { LiveFeed, wsEventToFeedItem } from "../components/ui/LiveFeed";
import type { FeedItem } from "../components/ui/LiveFeed";
import { useWebSocket } from "../hooks/useWebSocket";
import {
  getCostsToday, getCostsSummary, getCostsHourly,
  getCostsDaily, getCostsByModel, getBudgets, getRoutingStats, getRequests,
} from "../api";
import type {
  DailyCostRow, HourlyCostRow, ModelCostRow,
  BudgetsResponse, RoutingStatsResponse, SummaryResponse, RequestRecord,
} from "../types";
import type { WsEvent } from "../types";

const MAX_FEED = 15;

function requestToFeedItem(r: RequestRecord): FeedItem {
  return {
    id:            r.id,
    timestamp:     r.timestamp,
    model:         r.model,
    originalModel: r.original_model ?? null,
    provider:      r.provider,
    inputTokens:   r.input_tokens,
    outputTokens:  r.output_tokens,
    costUsd:       r.cost_usd,
    durationMs:    r.duration_ms,
    blocked:       !!r.blocked,
    sessionId:     r.session_id ?? null,
  };
}

export default function OverviewPage() {
  const [today,      setToday]      = useState<DailyCostRow | null>(null);
  const [summary,    setSummary]    = useState<SummaryResponse | null>(null);
  const [hourly,     setHourly]     = useState<HourlyCostRow[]>([]);
  const [daily,      setDaily]      = useState<DailyCostRow[]>([]);
  const [byModel,    setByModel]    = useState<ModelCostRow[]>([]);
  const [budgets,    setBudgets]    = useState<BudgetsResponse | null>(null);
  const [routing,    setRouting]    = useState<RoutingStatsResponse | null>(null);
  const [feedItems,  setFeedItems]  = useState<FeedItem[]>([]);
  const [loading,    setLoading]    = useState(true);
  const yesterday = useRef<DailyCostRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, s, h, d, m, b, r, live] = await Promise.all([
        getCostsToday(),
        getCostsSummary(),
        getCostsHourly(),
        getCostsDaily(30),
        getCostsByModel(),
        getBudgets(),
        getRoutingStats(),
        getRequests(5, 0),
      ]);
      setToday(t);
      setSummary(s);
      setHourly(h.hours);
      setDaily(d);
      setByModel(m);
      setBudgets(b);
      setRouting(r);
      // Seed the live feed with the 5 most recent requests (newest first)
      setFeedItems(live.rows.map(requestToFeedItem));
      // Yesterday = second-to-last in the array
      yesterday.current = d.length >= 2 ? d[d.length - 2] : null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleWsEvent = useCallback((event: WsEvent) => {
    if (event.type === "request") {
      setFeedItems((prev) => [wsEventToFeedItem(event.data), ...prev].slice(0, MAX_FEED));
      // Refresh cost data
      getCostsToday().then(setToday).catch(() => {});
    }
    if (event.type === "budget") {
      setBudgets(event.data);
    }
  }, []);

  useWebSocket(handleWsEvent);

  const moneySaved = (routing?.stats ?? []).reduce((s, r) => s + r.total_saved, 0);
  const yesterdayRequests = yesterday.current?.request_count ?? 0;
  const todayRequests     = today?.request_count ?? 0;
  const requestTrend      = todayRequests - yesterdayRequests;

  return (
    <Layout title="Overview">
      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatCard
              label="Today's Cost"
              value={today?.total_cost ?? 0}
              format="currency"
              icon={DollarSign}
              iconColor="text-accent"
              valueColor="text-accent"
              subtitle={`${today?.request_count ?? 0} requests`}
              delay={0}
            />
            <StatCard
              label="Monthly Spend"
              value={summary?.this_month ?? 0}
              format="currency"
              icon={Calendar}
              iconColor="text-info"
              valueColor="text-primary"
              subtitle={
                budgets?.monthly
                  ? `of $${budgets.monthly.limitUsd.toFixed(2)} budget`
                  : "no limit set"
              }
              delay={0.05}
            />
            <StatCard
              label="Requests Today"
              value={todayRequests}
              format="count"
              icon={Activity}
              iconColor="text-secondary"
              trend={requestTrend}
              delay={0.1}
            />
            <StatCard
              label="Money Saved"
              value={moneySaved}
              format="currency"
              icon={Zap}
              iconColor="text-success"
              valueColor="text-success"
              subtitle={
                routing?.enabled
                  ? `${routing.stats.reduce((s, r) => s + r.request_count, 0)} routed`
                  : "routing off"
              }
              delay={0.15}
            />
          </>
        )}
      </div>

      {/* Charts row */}
      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
          <div className="lg:col-span-3">
            <ChartSkeleton height={220} />
          </div>
          <div className="lg:col-span-2 bg-surface rounded-xl border border-border p-5">
            <Skeleton className="h-4 w-32 mb-6" />
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="mb-3">
                <div className="flex justify-between mb-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6">
          <div className="lg:col-span-3 bg-surface rounded-xl border border-border p-5">
            <CostChart hourlyData={hourly} dailyData={daily} />
          </div>
          <div className="lg:col-span-2 bg-surface rounded-xl border border-border p-5">
            <h3 className="font-head font-semibold text-primary mb-4">Model Breakdown</h3>
            <ModelBar data={byModel} />
          </div>
        </div>
      )}

      {/* Budget + Live feed row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface rounded-xl border border-border p-5">
          <h3 className="font-head font-semibold text-primary mb-6">Budget Status</h3>
          {loading ? (
            <div className="h-32 shimmer rounded-lg" />
          ) : !budgets?.daily && !budgets?.monthly ? (
            <p className="text-sm text-muted text-center py-8">
              No budgets configured.<br />
              <span className="text-xs">Set limits in the Budget page.</span>
            </p>
          ) : (
            <div className="flex items-start justify-around gap-6 flex-wrap">
              {budgets.daily && (
                <BudgetGauge budget={budgets.daily} label="Daily" />
              )}
              {budgets.monthly && (
                <BudgetGauge budget={budgets.monthly} label="Monthly" />
              )}
            </div>
          )}
        </div>

        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-head font-semibold text-primary">Live Feed</h3>
            <span className="text-xs text-success flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse2 inline-block" />
              Real-time
            </span>
          </div>
          <LiveFeed items={feedItems} />
        </div>
      </div>
    </Layout>
  );
}
