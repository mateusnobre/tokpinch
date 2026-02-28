import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, ChevronRight, Search, Users } from "lucide-react";
import { Layout } from "../components/layout/Layout";
import { TableRowSkeleton } from "../components/ui/Skeleton";
import { getCostsBySession, getRequests } from "../api";
import type { SessionCostRow, RequestRecord } from "../types";

function shortId(id: string) {
  return id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}

function costColor(cost: number, max: number): string {
  const ratio = cost / Math.max(max, 0.0001);
  if (ratio > 0.7) return "text-accent";
  if (ratio > 0.3) return "text-warning";
  return "text-primary";
}

function ExpandedRows({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<RequestRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRequests(100, 0)
      .then((res) => setRows(res.rows.filter((r) => r.session_id === sessionId)))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) {
    return (
      <tr>
        <td colSpan={6} className="px-6 py-4">
          <div className="h-8 shimmer rounded" />
        </td>
      </tr>
    );
  }

  return (
    <>
      {rows.map((r) => (
        <tr key={r.id} className="border-b border-border/30 bg-surface/50">
          <td className="pl-12 pr-4 py-2 text-xs font-mono text-muted">{shortId(r.id)}</td>
          <td className="px-4 py-2 text-xs font-mono text-secondary">{new Date(r.timestamp).toLocaleTimeString()}</td>
          <td className="px-4 py-2 text-xs font-mono text-secondary">{r.model.replace(/-\d{8}$/, "")}</td>
          <td className="px-4 py-2 text-xs font-mono text-muted">{(r.input_tokens + r.output_tokens).toLocaleString()}</td>
          <td className="px-4 py-2 text-xs font-mono text-accent">${r.cost_usd.toFixed(6)}</td>
          <td className="px-4 py-2">
            {r.blocked ? (
              <span className="text-xs text-accent">blocked</span>
            ) : (
              <span className="text-xs text-success">ok</span>
            )}
          </td>
        </tr>
      ))}
      {rows.length === 0 && (
        <tr>
          <td colSpan={6} className="pl-12 py-3 text-xs text-muted">No requests found</td>
        </tr>
      )}
    </>
  );
}

function shortModel(model: string): string {
  return model.replace(/-\d{8}$/, "").replace(/^claude-/, "").replace(/^gpt-/, "gpt-");
}

function buildTopModelMap(rows: RequestRecord[]): Map<string, string> {
  const perSession = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.session_id) continue;
    if (!perSession.has(r.session_id)) perSession.set(r.session_id, new Map());
    const counts = perSession.get(r.session_id)!;
    counts.set(r.model, (counts.get(r.model) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const [sid, counts] of perSession) {
    let top = ""; let max = 0;
    for (const [model, n] of counts) { if (n > max) { max = n; top = model; } }
    if (top) result.set(sid, top);
  }
  return result;
}

export default function SessionsPage() {
  const [sessions,  setSessions]  = useState<SessionCostRow[]>([]);
  const [filtered,  setFiltered]  = useState<SessionCostRow[]>([]);
  const [topModels, setTopModels] = useState<Map<string, string>>(new Map());
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState("");
  const [expanded,  setExpanded]  = useState<string | null>(null);
  const [page,      setPage]      = useState(0);
  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    try {
      const [sessionData, requestData] = await Promise.all([
        getCostsBySession(),
        getRequests(2000, 0),
      ]);
      setTopModels(buildTopModelMap(requestData.rows));
      setSessions(sessionData);
      setFiltered(sessionData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(sessions.filter((s) => s.session_id.toLowerCase().includes(q)));
    setPage(0);
  }, [search, sessions]);

  const maxCost = Math.max(...filtered.map((s) => s.cost), 0);
  const paged   = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pages   = Math.ceil(filtered.length / PAGE_SIZE);

  return (
    <Layout title="Sessions">
      {/* Search */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search session ID…"
            className="w-full pl-9 pr-3 py-2 bg-surface border border-border rounded-lg text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/60 transition-colors"
          />
        </div>
        <span className="text-xs text-muted">{filtered.length} sessions</span>
      </div>

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              {["Session ID", "Cost", "Requests", "Tokens", "Top Model", ""].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted uppercase tracking-wider">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => <TableRowSkeleton key={i} cols={6} />)
              : paged.map((s, i) => (
                  <>
                    <motion.tr
                      key={s.session_id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.03 }}
                      onClick={() => setExpanded(expanded === s.session_id ? null : s.session_id)}
                      className="border-b border-border/50 hover:bg-surface-el/50 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {expanded === s.session_id
                            ? <ChevronDown size={14} className="text-muted" />
                            : <ChevronRight size={14} className="text-muted" />}
                          <span className="font-mono text-xs text-secondary">{shortId(s.session_id)}</span>
                        </div>
                      </td>
                      <td className={`px-4 py-3 font-mono text-xs font-medium ${costColor(s.cost, maxCost)}`}>
                        ${s.cost.toFixed(6)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-secondary">{s.request_count}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted">
                        {(s.input_tokens + s.output_tokens).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-secondary">
                        {topModels.get(s.session_id)
                          ? shortModel(topModels.get(s.session_id)!)
                          : <span className="text-muted">—</span>}
                      </td>
                      <td className="px-4 py-3" />
                    </motion.tr>
                    <AnimatePresence>
                      {expanded === s.session_id && (
                        <ExpandedRows key={`exp-${s.session_id}`} sessionId={s.session_id} />
                      )}
                    </AnimatePresence>
                  </>
                ))}
          </tbody>
        </table>

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center py-16 text-muted">
            <Users size={32} className="mb-2 opacity-30" />
            <p className="text-sm">No sessions found</p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-3 py-1.5 text-xs border border-border rounded-lg text-secondary disabled:opacity-40 hover:border-border/80"
          >
            Previous
          </button>
          <span className="text-xs text-muted px-2">
            Page {page + 1} of {pages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="px-3 py-1.5 text-xs border border-border rounded-lg text-secondary disabled:opacity-40 hover:border-border/80"
          >
            Next
          </button>
        </div>
      )}
    </Layout>
  );
}
