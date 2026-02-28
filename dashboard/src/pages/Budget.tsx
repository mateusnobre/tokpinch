import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Edit2, Check, X, Play, PiggyBank, DollarSign } from "lucide-react";
import { Layout } from "../components/layout/Layout";
import { BudgetGauge } from "../components/ui/BudgetGauge";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { Skeleton } from "../components/ui/Skeleton";
import { useToast } from "../context/ToastContext";
import { getBudgets, updateBudgets, overrideBudget, getCostsSummary } from "../api";
import type { BudgetsResponse, SummaryResponse } from "../types";

function InlineEdit({
  value, onSave,
}: {
  value: number;
  onSave: (v: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(String(value));
  const [saving,  setSaving]  = useState(false);

  const save = async () => {
    const n = parseFloat(draft);
    if (!Number.isFinite(n) || n <= 0) return;
    setSaving(true);
    try {
      await onSave(n);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(String(value)); setEditing(true); }}
        className="group flex items-center gap-1.5 font-mono text-3xl font-semibold text-primary hover:text-accent transition-colors"
      >
        ${value.toFixed(2)}
        <Edit2 size={14} className="opacity-0 group-hover:opacity-60 transition-opacity mt-1" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-3xl text-accent">$</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
        autoFocus
        className="w-28 bg-surface-el border border-accent/40 rounded-lg px-2 py-1 font-mono text-2xl text-primary focus:outline-none"
      />
      <button onClick={save} disabled={saving} className="text-success hover:text-success/80">
        <Check size={16} />
      </button>
      <button onClick={() => setEditing(false)} className="text-muted hover:text-secondary">
        <X size={16} />
      </button>
    </div>
  );
}

function BudgetCard({
  type, budget, onUpdate, onOverride,
}: {
  type:       "daily" | "monthly";
  budget:     ReturnType<typeof getBudgets> extends Promise<infer R> ? (R extends { daily: infer D } ? NonNullable<D> : never) : never;
  onUpdate:   (v: number) => Promise<void>;
  onOverride: () => void;
}) {
  const pct   = Math.min(budget.currentSpend / budget.limitUsd, 1) * 100;
  const label = type === "daily" ? "Daily Budget" : "Monthly Budget";
  const resetText = type === "daily" ? "Resets at midnight UTC" : "Resets 1st of month";

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-surface rounded-xl border border-border p-6"
    >
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="font-head font-semibold text-primary mb-1">{label}</h3>
          <p className="text-xs text-muted">{resetText}</p>
        </div>
        <Badge status={budget.status} />
      </div>

      <div className="flex gap-8 items-center mb-6">
        <BudgetGauge budget={budget} label="" />
        <div className="flex-1 space-y-4">
          <div>
            <div className="text-xs text-muted mb-1">Limit</div>
            <InlineEdit value={budget.limitUsd} onSave={onUpdate} />
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Spent</div>
            <div className="font-mono text-xl text-accent">${budget.currentSpend.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs text-muted mb-1">Remaining</div>
            <div className="font-mono text-xl text-success">
              ${Math.max(0, budget.limitUsd - budget.currentSpend).toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-surface-el rounded-full overflow-hidden mb-4">
        <motion.div
          className={`h-full rounded-full ${pct >= 100 ? "bg-accent" : pct >= 80 ? "bg-warning" : "bg-success"}`}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(pct, 100)}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
      </div>

      {budget.status === "paused" && (
        <button
          onClick={onOverride}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-success/10 hover:bg-success/20 text-success border border-success/20 rounded-lg text-sm font-medium transition-colors"
        >
          <Play size={14} />
          Resume Requests
        </button>
      )}
    </motion.div>
  );
}

function NoBudgetForm({ onSaved }: { onSaved: () => void }) {
  const [daily,   setDaily]   = useState("");
  const [monthly, setMonthly] = useState("");
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState("");
  const { addToast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const d = parseFloat(daily);
    const m = parseFloat(monthly);

    if (!daily && !monthly) {
      setError("Enter at least one budget amount.");
      return;
    }
    if ((daily   && (!Number.isFinite(d) || d <= 0)) ||
        (monthly && (!Number.isFinite(m) || m <= 0))) {
      setError("Amounts must be positive numbers.");
      return;
    }

    setError("");
    setSaving(true);
    try {
      await updateBudgets({
        ...(daily   ? { daily:   d } : {}),
        ...(monthly ? { monthly: m } : {}),
      });
      addToast("Budgets created successfully", "success");
      onSaved();
    } catch {
      addToast("Failed to create budgets", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center pt-16 pb-8"
    >
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-8">
          <PiggyBank size={40} className="text-muted mb-4 opacity-50" />
          <h2 className="font-head font-semibold text-xl text-primary mb-2">Set Your Budgets</h2>
          <p className="text-sm text-muted text-center">
            Define spending limits to get alerts and automatic pausing when costs exceed them.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-surface border border-border rounded-2xl p-6 space-y-4"
        >
          {/* Daily */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">
              Daily Limit <span className="text-muted font-normal">(optional)</span>
            </label>
            <div className="relative">
              <DollarSign size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="e.g. 10.00"
                value={daily}
                onChange={(e) => { setDaily(e.target.value); setError(""); }}
                className="w-full pl-8 pr-3 py-2.5 bg-surface-el border border-border rounded-lg font-mono text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/60 transition-colors"
              />
            </div>
          </div>

          {/* Monthly */}
          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">
              Monthly Limit <span className="text-muted font-normal">(optional)</span>
            </label>
            <div className="relative">
              <DollarSign size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="number"
                min="0.01"
                step="0.01"
                placeholder="e.g. 100.00"
                value={monthly}
                onChange={(e) => { setMonthly(e.target.value); setError(""); }}
                className="w-full pl-8 pr-3 py-2.5 bg-surface-el border border-border rounded-lg font-mono text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/60 transition-colors"
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-accent">{error}</p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full py-2.5 bg-accent hover:bg-accent/90 disabled:bg-accent/40 text-white text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed"
          >
            {saving ? "Creating budgets…" : "Create Budgets"}
          </button>
        </form>
      </div>
    </motion.div>
  );
}

export default function BudgetPage() {
  const [budgets,  setBudgets]  = useState<BudgetsResponse | null>(null);
  const [summary,  setSummary]  = useState<SummaryResponse | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [modal,    setModal]    = useState<"daily-override" | "monthly-override" | null>(null);
  const [overrideLoading, setOverrideLoading] = useState(false);
  const { addToast } = useToast();

  const load = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([getBudgets(), getCostsSummary()]);
      setBudgets(b);
      setSummary(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUpdate = async (type: "daily" | "monthly", limitUsd: number) => {
    try {
      const updated = await updateBudgets({ [type]: limitUsd });
      setBudgets(updated);
      addToast(`${type} budget updated to $${limitUsd.toFixed(2)}`, "success");
    } catch {
      addToast("Failed to update budget", "error");
      throw new Error("update failed");
    }
  };

  const handleOverride = async (type: "daily" | "monthly") => {
    setOverrideLoading(true);
    try {
      const updated = await overrideBudget(type);
      setBudgets(updated);
      addToast(`${type} budget resumed`, "success");
      setModal(null);
    } catch {
      addToast("Failed to resume budget", "error");
    } finally {
      setOverrideLoading(false);
    }
  };

  return (
    <Layout title="Budget">
      {/* Cost summary strip */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-surface rounded-xl border border-border p-4">
              <Skeleton className="h-3 w-16 mb-2" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))
        ) : (
          <>
            <div className="bg-surface rounded-xl border border-border p-4">
              <p className="text-xs text-muted mb-1">Today</p>
              <p className="font-mono font-semibold text-primary">${(summary?.today ?? 0).toFixed(4)}</p>
            </div>
            <div className="bg-surface rounded-xl border border-border p-4">
              <p className="text-xs text-muted mb-1">This week</p>
              <p className="font-mono font-semibold text-primary">${(summary?.this_week ?? 0).toFixed(4)}</p>
            </div>
            <div className="bg-surface rounded-xl border border-border p-4">
              <p className="text-xs text-muted mb-1">This month</p>
              <p className="font-mono font-semibold text-accent">${(summary?.this_month ?? 0).toFixed(4)}</p>
            </div>
          </>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="bg-surface rounded-xl border border-border p-6">
              <Skeleton className="h-5 w-32 mb-4" />
              <Skeleton className="h-40 w-full mb-4" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      ) : !budgets?.daily && !budgets?.monthly ? (
        <NoBudgetForm onSaved={load} />

      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {budgets.daily && (
            <BudgetCard
              type="daily"
              budget={budgets.daily}
              onUpdate={(v) => handleUpdate("daily", v)}
              onOverride={() => setModal("daily-override")}
            />
          )}
          {budgets.monthly && (
            <BudgetCard
              type="monthly"
              budget={budgets.monthly}
              onUpdate={(v) => handleUpdate("monthly", v)}
              onOverride={() => setModal("monthly-override")}
            />
          )}
        </div>
      )}

      <Modal
        open={modal === "daily-override"}
        title="Resume Daily Budget"
        onClose={() => setModal(null)}
        onConfirm={() => handleOverride("daily")}
        confirmLabel="Resume"
        loading={overrideLoading}
      >
        <p>
          This will resume requests for the rest of today even though the daily budget limit has been
          exceeded. Use this to unblock yourself while you investigate.
        </p>
      </Modal>

      <Modal
        open={modal === "monthly-override"}
        title="Resume Monthly Budget"
        onClose={() => setModal(null)}
        onConfirm={() => handleOverride("monthly")}
        confirmLabel="Resume"
        loading={overrideLoading}
      >
        <p>
          This will resume requests for the rest of the month even though the monthly budget limit
          has been exceeded.
        </p>
      </Modal>
    </Layout>
  );
}
