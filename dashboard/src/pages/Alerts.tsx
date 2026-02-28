import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle, Shield, RefreshCw, BarChart2, Bell,
  CheckCircle, Clock, Mail, MessageCircle, Save,
} from "lucide-react";
import { Layout } from "../components/layout/Layout";
import { Skeleton } from "../components/ui/Skeleton";
import { useToast } from "../context/ToastContext";
import { getAlerts, getAlertPreferences, updateAlertPreferences } from "../api";
import type { AlertRecord, AlertPreferences, AlertType } from "../types";

type FilterTab = "all" | "budget" | "loop" | "digest";

const alertConfig: Record<AlertType, { icon: typeof Bell; color: string; label: string }> = {
  budget_warning:  { icon: AlertTriangle, color: "text-warning", label: "Budget Warning" },
  budget_exceeded: { icon: Shield,        color: "text-accent",  label: "Budget Exceeded" },
  loop_detected:   { icon: RefreshCw,     color: "text-accent",  label: "Loop Detected" },
  daily_digest:    { icon: BarChart2,     color: "text-info",    label: "Daily Digest" },
};

function AlertRow({ alert, index }: { alert: AlertRecord; index: number }) {
  const cfg = alertConfig[alert.type] ?? { icon: Bell, color: "text-secondary", label: alert.type };
  const Icon = cfg.icon;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.03 }}
      className="flex gap-4 p-4 border-b border-border/50 last:border-0 hover:bg-surface-el/30 transition-colors"
    >
      <div className={`mt-0.5 flex-shrink-0 ${cfg.color}`}>
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
          <span className="text-xs text-muted">{new Date(alert.created_at).toLocaleString()}</span>
          {alert.delivered ? (
            <span className="ml-auto flex items-center gap-1 text-xs text-success">
              <CheckCircle size={10} /> Delivered
            </span>
          ) : (
            <span className="ml-auto flex items-center gap-1 text-xs text-muted">
              <Clock size={10} /> Pending
            </span>
          )}
        </div>
        <p className="text-xs text-secondary leading-relaxed">{alert.message}</p>
      </div>
    </motion.div>
  );
}

function PreferencesPanel({ initialPrefs }: { initialPrefs: AlertPreferences | null }) {
  const [prefs,  setPrefs]  = useState<AlertPreferences | null>(initialPrefs);
  const [draft,  setDraft]  = useState<AlertPreferences | null>(initialPrefs);
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  // Sync if parent re-provides prefs (e.g. after a page reload)
  useEffect(() => {
    setPrefs(initialPrefs);
    setDraft(initialPrefs);
  }, [initialPrefs]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await updateAlertPreferences(draft);
      setPrefs(updated);
      setDraft(updated);
      addToast("Alert preferences saved", "success");
    } catch {
      addToast("Failed to save preferences", "error");
    } finally {
      setSaving(false);
    }
  };

  if (!draft) {
    return <Skeleton className="h-48 w-full" />;
  }

  return (
    <div className="space-y-4">
      {/* Telegram */}
      <div className="flex items-center justify-between p-4 bg-surface-el rounded-xl">
        <div className="flex items-center gap-3">
          <MessageCircle size={18} className="text-info" />
          <div>
            <div className="text-sm font-medium text-primary">Telegram Alerts</div>
            <div className="text-xs text-muted">Receive alerts via Telegram bot</div>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.telegramEnabled}
          onClick={() => setDraft({ ...draft, telegramEnabled: !draft.telegramEnabled })}
          className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${draft.telegramEnabled ? "bg-accent" : "bg-zinc-700"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${draft.telegramEnabled ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>

      {/* Email */}
      <div className="flex items-center justify-between p-4 bg-surface-el rounded-xl">
        <div className="flex items-center gap-3">
          <Mail size={18} className="text-info" />
          <div>
            <div className="text-sm font-medium text-primary">Email Alerts</div>
            <div className="text-xs text-muted">Receive alerts via SMTP email</div>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={draft.emailEnabled}
          onClick={() => setDraft({ ...draft, emailEnabled: !draft.emailEnabled })}
          className={`relative inline-flex w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${draft.emailEnabled ? "bg-accent" : "bg-zinc-700"}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${draft.emailEnabled ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>

      {/* Digest time */}
      <div className="flex items-center justify-between p-4 bg-surface-el rounded-xl">
        <div className="flex items-center gap-3">
          <Clock size={18} className="text-warning" />
          <div>
            <div className="text-sm font-medium text-primary">Daily Digest Time</div>
            <div className="text-xs text-muted">UTC time to receive the daily report</div>
          </div>
        </div>
        <input
          type="time"
          value={draft.digestTimeUtc}
          onChange={(e) => setDraft({ ...draft, digestTimeUtc: e.target.value })}
          className="bg-surface border border-border rounded-lg px-2 py-1 text-sm text-primary font-mono focus:outline-none focus:border-accent/60"
        />
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
      >
        <Save size={14} />
        {saving ? "Saving…" : "Save Preferences"}
      </button>
    </div>
  );
}

const tabs: { key: FilterTab; label: string }[] = [
  { key: "all",    label: "All"    },
  { key: "budget", label: "Budget" },
  { key: "loop",   label: "Loop"   },
  { key: "digest", label: "Digest" },
];

function matchesTab(alert: AlertRecord, tab: FilterTab): boolean {
  if (tab === "all") return true;
  if (tab === "budget") return alert.type.startsWith("budget");
  if (tab === "loop")   return alert.type === "loop_detected";
  if (tab === "digest") return alert.type === "daily_digest";
  return true;
}

export default function AlertsPage() {
  const [alerts,  setAlerts]  = useState<AlertRecord[]>([]);
  const [prefs,   setPrefs]   = useState<AlertPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab,     setTab]     = useState<FilterTab>("all");

  const load = useCallback(async () => {
    try {
      const [alertData, prefsData] = await Promise.all([
        getAlerts(100),
        getAlertPreferences(),
      ]);
      setAlerts(alertData);
      setPrefs(prefsData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = alerts.filter((a) => matchesTab(a, tab));

  return (
    <Layout title="Alerts">
      <div className="space-y-6">
        {/* Alert list */}
        <div>
          <div className="flex items-center gap-1 mb-4">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                  tab === t.key
                    ? "bg-accent text-white"
                    : "text-muted hover:text-secondary hover:bg-surface-el"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="p-4 border-b border-border/50">
                    <Skeleton className="h-3 w-48 mb-2" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                ))
              : filtered.length === 0
              ? (
                <div className="flex flex-col items-center py-16 text-muted">
                  <Bell size={32} className="mb-2 opacity-30" />
                  <p className="text-sm">No {tab === "all" ? "" : tab + " "}alerts yet</p>
                </div>
              )
              : filtered.map((a, i) => <AlertRow key={a.id} alert={a} index={i} />)}
          </div>
        </div>

        {/* Alert preferences */}
        <div>
          <h2 className="font-head font-semibold text-primary mb-4">Alert Preferences</h2>
          <PreferencesPanel initialPrefs={prefs} />
        </div>
      </div>
    </Layout>
  );
}
