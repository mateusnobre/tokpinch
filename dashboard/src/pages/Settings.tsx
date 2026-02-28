import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  Server, Database, Cpu, Globe, Shield, Zap,
  RefreshCw, CheckCircle, XCircle,
} from "lucide-react";
import { Layout } from "../components/layout/Layout";
import { Skeleton } from "../components/ui/Skeleton";
import { getStatus, getSettings, getRoutingStats } from "../api";
import type { StatusResponse, SettingsResponse, RoutingStatsResponse } from "../types";

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function InfoCard({ icon: Icon, label, value, mono = false }: {
  icon: typeof Server; label: string; value: string | number; mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3 bg-surface-el rounded-lg">
      <Icon size={15} className="text-muted flex-shrink-0" />
      <span className="text-xs text-muted">{label}</span>
      <span className={`ml-auto text-xs ${mono ? "font-mono" : ""} text-primary`}>{value}</span>
    </div>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className={`inline-flex w-2 h-2 rounded-full ${active ? "bg-success" : "bg-border"}`} />
  );
}

export default function SettingsPage() {
  const [status,  setStatus]  = useState<StatusResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [routing, setRouting] = useState<RoutingStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [s, cfg, r] = await Promise.all([getStatus(), getSettings(), getRoutingStats()]);
      setStatus(s);
      setSettings(cfg);
      setRouting(r);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalSaved = (routing?.stats ?? []).reduce((s, r) => s + r.total_saved, 0);
  const totalRouted = (routing?.stats ?? []).reduce((s, r) => s + r.request_count, 0);

  return (
    <Layout title="Settings">
      <div className="max-w-3xl space-y-6">
        {/* System info */}
        <section>
          <h2 className="font-head font-semibold text-primary mb-3">System Info</h2>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-surface rounded-xl border border-border p-4 space-y-2"
          >
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)
            ) : (
              <>
                <InfoCard icon={Server}   label="Version"       value={`v${status?.version ?? "—"}`} />
                <InfoCard icon={Cpu}      label="Uptime"        value={status ? formatUptime(status.uptimeMs) : "—"} mono />
                <InfoCard icon={Database} label="Database size" value={status ? formatBytes(status.dbSizeBytes) : "—"} mono />
                <InfoCard icon={Globe}    label="Platform"      value={status?.platform ?? "—"} />
                <InfoCard icon={Server}   label="Node.js"       value={status?.nodeVersion ?? "—"} mono />
                <InfoCard icon={Globe}    label="Environment"   value={settings?.nodeEnv ?? "—"} />
                <InfoCard icon={Shield}   label="Log level"     value={settings?.logLevel ?? "—"} />
                <InfoCard icon={Database} label="DB path"       value={settings?.dbPath ?? "—"} mono />
              </>
            )}
          </motion.div>
        </section>

        {/* Provider connections */}
        <section>
          <h2 className="font-head font-semibold text-primary mb-3">Provider Connections</h2>
          <div className="bg-surface rounded-xl border border-border p-4 space-y-2">
            {loading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <>
                {[
                  { name: "Anthropic", configured: !!settings?.anthropicApiKey },
                  { name: "OpenAI",    configured: !!settings?.openaiApiKey    },
                ].map(({ name, configured }) => (
                  <div key={name} className="flex items-center gap-3 p-3 bg-surface-el rounded-lg">
                    <StatusDot active={configured} />
                    <span className="text-sm text-primary">{name}</span>
                    <span className={`ml-auto text-xs ${configured ? "text-success" : "text-muted"}`}>
                      {configured ? "API key configured" : "No API key"}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>

        {/* Smart routing */}
        <section>
          <h2 className="font-head font-semibold text-primary mb-3">Smart Routing</h2>
          <div className="bg-surface rounded-xl border border-border p-4 space-y-3">
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Zap size={16} className={routing?.enabled ? "text-success" : "text-muted"} />
                  <div>
                    <div className="text-sm font-medium text-primary">Smart Routing</div>
                    <div className="text-xs text-muted">Automatically route expensive models to cheaper ones</div>
                  </div>
                  <span className={`ml-auto text-xs font-medium ${routing?.enabled ? "text-success" : "text-muted"}`}>
                    {routing?.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                {routing?.enabled && (
                  <div className="grid grid-cols-2 gap-2 pt-2 border-t border-border">
                    <div className="p-3 bg-surface-el rounded-lg">
                      <div className="text-xs text-muted mb-1">Requests rerouted</div>
                      <div className="font-mono text-lg text-primary">{totalRouted.toLocaleString()}</div>
                    </div>
                    <div className="p-3 bg-surface-el rounded-lg">
                      <div className="text-xs text-muted mb-1">Cost saved</div>
                      <div className="font-mono text-lg text-success">${totalSaved.toFixed(4)}</div>
                    </div>
                  </div>
                )}
                {(routing?.rules?.length ?? 0) > 0 && (
                  <div className="pt-2 border-t border-border">
                    <div className="text-xs text-muted mb-2">Routing rules ({routing?.rules.length})</div>
                    <div className="space-y-1">
                      {(routing?.rules as Array<{ from: string; to: string; enabled: boolean }> ?? []).map((rule, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs p-2 bg-surface-el rounded">
                          <StatusDot active={rule.enabled} />
                          <span className="font-mono text-secondary">{rule.from}</span>
                          <span className="text-muted">→</span>
                          <span className="font-mono text-secondary">{rule.to}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* Loop detection */}
        <section>
          <h2 className="font-head font-semibold text-primary mb-3">Loop Detection</h2>
          <div className="bg-surface rounded-xl border border-border p-4 space-y-2">
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                <div className="flex items-center gap-3 p-3 bg-surface-el rounded-lg">
                  <RefreshCw size={15} className={settings?.loopDetectionEnabled ? "text-success" : "text-muted"} />
                  <span className="text-sm text-primary">Loop Detection</span>
                  <span className={`ml-auto text-xs font-medium ${settings?.loopDetectionEnabled ? "text-success" : "text-muted"}`}>
                    {settings?.loopDetectionEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <InfoCard icon={Shield}    label="Max RPM"         value={settings?.loopMaxRpm ?? "default (20)"} mono />
                <InfoCard icon={RefreshCw} label="Cooldown (sec)"  value={settings?.loopCooldownSeconds ?? "default (300)"} mono />
              </>
            )}
          </div>
        </section>

        {/* Alert channels */}
        <section>
          <h2 className="font-head font-semibold text-primary mb-3">Alert Channels</h2>
          <div className="bg-surface rounded-xl border border-border p-4 space-y-2">
            {loading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <>
                <div className="flex items-center gap-3 p-3 bg-surface-el rounded-lg">
                  {settings?.alertTelegramConfigured
                    ? <CheckCircle size={15} className="text-success" />
                    : <XCircle size={15} className="text-muted" />}
                  <span className="text-sm text-primary">Telegram</span>
                  <span className={`ml-auto text-xs ${settings?.alertTelegramConfigured ? "text-success" : "text-muted"}`}>
                    {settings?.alertTelegramConfigured ? "Configured" : "Not configured"}
                  </span>
                </div>
                <div className="flex items-center gap-3 p-3 bg-surface-el rounded-lg">
                  {settings?.alertEmailConfigured
                    ? <CheckCircle size={15} className="text-success" />
                    : <XCircle size={15} className="text-muted" />}
                  <span className="text-sm text-primary">Email</span>
                  <span className={`ml-auto text-xs ${settings?.alertEmailConfigured ? "text-success" : "text-muted"}`}>
                    {settings?.alertEmailConfigured ? "Configured" : "Not configured"}
                  </span>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </Layout>
  );
}
