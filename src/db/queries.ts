import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface RequestRecord {
  id: string;
  timestamp: number;
  provider: "anthropic" | "openai" | "google";
  model: string;
  original_model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd: number;
  session_id?: string | null;
  skill_name?: string | null;
  request_type?: "chat" | "heartbeat" | "tool_call" | "unknown";
  duration_ms?: number | null;
  blocked?: number; // 0 | 1
  block_reason?: "budget_exceeded" | "loop_detected" | null;
}

export interface DailyCostRow {
  date: string;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  request_count: number;
  blocked_count: number;
}

export interface AlertRecord {
  type: "budget_warning" | "budget_exceeded" | "loop_detected" | "daily_digest";
  message: string;
  channel?: "telegram" | "email" | null;
}

export interface ModelCostRow {
  model: string;
  provider: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface SessionCostRow {
  session_id: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface BudgetRow {
  id: string;
  type: "daily" | "monthly";
  limit_usd: number;
  current_spend: number;
  status: string;
  period_start: string;
  period_end: string;
  created_at: string;
}

export interface HourlyCostRow {
  hour: number; // 0–23
  cost: number;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface RoutingStatsRow {
  original_model: string;
  final_model:    string;
  request_count:  number;
  total_saved:    number; // sum of (cost at original_model - cost at final_model)
}

// ---------------------------------------------------------------------------
// Prepared statement factory
// Call once after the DB connection is open and migrations have run.
// ---------------------------------------------------------------------------

export function createQueries(db: Database.Database) {
  // --- Requests -----------------------------------------------------------

  const _insertRequest = db.prepare<RequestRecord>(`
    INSERT INTO requests (
      id, timestamp, provider, model, original_model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      cost_usd, session_id, skill_name, request_type,
      duration_ms, blocked, block_reason
    ) VALUES (
      @id, @timestamp, @provider, @model, @original_model,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
      @cost_usd, @session_id, @skill_name, @request_type,
      @duration_ms, @blocked, @block_reason
    )
  `);

  const _getRequestsByTimeRange = db.prepare<[number, number]>(`
    SELECT * FROM requests
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp DESC
  `);

  const _getRecentRequests = db.prepare<[number]>(`
    SELECT * FROM requests
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const _getPaginatedRequests = db.prepare<[number, number]>(`
    SELECT * FROM requests
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `);

  const _getCostByModel = db.prepare<[number, number]>(`
    SELECT
      model,
      provider,
      SUM(cost_usd)       AS cost,
      SUM(input_tokens)   AS input_tokens,
      SUM(output_tokens)  AS output_tokens,
      COUNT(*)            AS request_count
    FROM requests
    WHERE timestamp >= ? AND timestamp <= ?
    GROUP BY model, provider
    ORDER BY cost DESC
  `);

  const _getCostBySession = db.prepare<[number, number]>(`
    SELECT
      session_id,
      SUM(cost_usd)       AS cost,
      SUM(input_tokens)   AS input_tokens,
      SUM(output_tokens)  AS output_tokens,
      COUNT(*)            AS request_count
    FROM requests
    WHERE timestamp >= ? AND timestamp <= ?
      AND session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY cost DESC
  `);

  const _getHourlyCosts = db.prepare<[string]>(`
    SELECT
      CAST(strftime('%H', created_at) AS INTEGER) AS hour,
      SUM(cost_usd)       AS cost,
      SUM(input_tokens)   AS input_tokens,
      SUM(output_tokens)  AS output_tokens,
      COUNT(*)            AS request_count
    FROM requests
    WHERE date(created_at) = ?
    GROUP BY hour
    ORDER BY hour
  `);

  // --- Daily costs (aggregate table) -------------------------------------

  const _getDailyCost = db.prepare<[string]>(`
    SELECT * FROM daily_costs WHERE date = ?
  `);

  const _getMonthlyCost = db.prepare<[string]>(`
    SELECT
      SUM(total_cost)          AS total_cost,
      SUM(total_input_tokens)  AS total_input_tokens,
      SUM(total_output_tokens) AS total_output_tokens,
      SUM(request_count)       AS request_count,
      SUM(blocked_count)       AS blocked_count
    FROM daily_costs
    WHERE strftime('%Y-%m', date) = ?
  `);

  const _getAllTimeCost = db.prepare(`
    SELECT
      SUM(total_cost)          AS total_cost,
      SUM(total_input_tokens)  AS total_input_tokens,
      SUM(total_output_tokens) AS total_output_tokens,
      SUM(request_count)       AS request_count,
      SUM(blocked_count)       AS blocked_count
    FROM daily_costs
  `);

  const _countActiveDays = db.prepare(`
    SELECT COUNT(*) AS count FROM daily_costs WHERE request_count > 0
  `);

  // Atomic upsert — safe to call from within an insertRequest transaction
  const _upsertDailyCost = db.prepare<{
    date: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    blocked: number;
  }>(`
    INSERT INTO daily_costs (date, total_cost, total_input_tokens, total_output_tokens, request_count, blocked_count, updated_at)
    VALUES (@date, @cost_usd, @input_tokens, @output_tokens, 1, @blocked, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      total_cost          = total_cost          + @cost_usd,
      total_input_tokens  = total_input_tokens  + @input_tokens,
      total_output_tokens = total_output_tokens + @output_tokens,
      request_count       = request_count       + 1,
      blocked_count       = blocked_count       + @blocked,
      updated_at          = datetime('now')
  `);

  // --- Alerts -------------------------------------------------------------

  const _insertAlert = db.prepare<{
    id: string;
    type: string;
    message: string;
    channel: string | null;
  }>(`
    INSERT INTO alerts (id, type, message, channel)
    VALUES (@id, @type, @message, @channel)
  `);

  const _getAlerts = db.prepare<[number]>(`
    SELECT * FROM alerts
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const _markAlertDelivered = db.prepare<[string]>(`
    UPDATE alerts SET delivered = 1 WHERE id = ?
  `);

  // --- Budgets ------------------------------------------------------------

  const _getBudgetForPeriod = db.prepare<[string]>(`
    SELECT * FROM budgets
    WHERE type = ? AND period_start <= date('now') AND period_end >= date('now')
    ORDER BY created_at DESC
    LIMIT 1
  `);

  // --- Routing stats ---------------------------------------------------------

  const _getRoutingStats = db.prepare<[number, number]>(`
    SELECT
      original_model,
      model            AS final_model,
      COUNT(*)         AS request_count,
      SUM(cost_usd)    AS total_saved
    FROM requests
    WHERE original_model IS NOT NULL
      AND original_model != model
      AND timestamp >= ? AND timestamp <= ?
    GROUP BY original_model, model
    ORDER BY total_saved DESC
  `);

  const _upsertBudget = db.prepare<{
    id: string;
    type: string;
    limit_usd: number;
    current_spend: number;
    status: string;
    period_start: string;
    period_end: string;
  }>(`
    INSERT OR REPLACE INTO budgets
      (id, type, limit_usd, current_spend, status, period_start, period_end)
    VALUES
      (@id, @type, @limit_usd, @current_spend, @status, @period_start, @period_end)
  `);

  const _updateBudget = db.prepare<{
    id: string;
    current_spend: number;
    status: string;
  }>(`
    UPDATE budgets SET current_spend = @current_spend, status = @status WHERE id = @id
  `);

  // --- Composed transaction: log request + update daily aggregate --------

  const _logRequestTx = db.transaction(
    (record: RequestRecord, date: string) => {
      _insertRequest.run(record);
      _upsertDailyCost.run({
        date,
        cost_usd: record.cost_usd,
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        blocked: record.blocked ?? 0,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Public query API — thin wrappers around prepared statements
  // ---------------------------------------------------------------------------

  return {
    /**
     * Log a proxied request and atomically update the daily cost aggregate.
     * Generates an ID and derives the date from the record's timestamp.
     */
    insertRequest(data: Omit<RequestRecord, "id">): string {
      const id = nanoid();
      const date = new Date(data.timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
      // better-sqlite3 requires ALL named params to be present in the object,
      // even optional ones — explicitly default them to null/0 here.
      const normalized: RequestRecord = {
        original_model:    null,
        cache_read_tokens:  0,
        cache_write_tokens: 0,
        session_id:         null,
        skill_name:         null,
        request_type:       "unknown",
        duration_ms:        null,
        blocked:            0,
        block_reason:       null,
        ...data,
        id,
      };
      _logRequestTx(normalized, date);
      return id;
    },

    getRequestsByTimeRange(start: number, end: number): RequestRecord[] {
      return _getRequestsByTimeRange.all(start, end) as RequestRecord[];
    },

    getRecentRequests(limit = 50): RequestRecord[] {
      return _getRecentRequests.all(limit) as RequestRecord[];
    },

    getPaginatedRequests(limit: number, offset: number): RequestRecord[] {
      return _getPaginatedRequests.all(limit, offset) as RequestRecord[];
    },

    getCostByModel(start: number, end: number): ModelCostRow[] {
      return _getCostByModel.all(start, end) as ModelCostRow[];
    },

    getCostBySession(start: number, end: number): SessionCostRow[] {
      return _getCostBySession.all(start, end) as SessionCostRow[];
    },

    /** Returns up to 24 rows — one per hour that had activity. */
    getHourlyCosts(date: string): HourlyCostRow[] {
      return _getHourlyCosts.all(date) as HourlyCostRow[];
    },

    getDailyCost(date: string): DailyCostRow | undefined {
      return _getDailyCost.get(date) as DailyCostRow | undefined;
    },

    /**
     * @param yearMonth e.g. "2026-02"
     */
    getMonthlyCost(yearMonth: string): DailyCostRow | undefined {
      return _getMonthlyCost.get(yearMonth) as DailyCostRow | undefined;
    },

    getAllTimeCost(): DailyCostRow | undefined {
      return _getAllTimeCost.get() as DailyCostRow | undefined;
    },

    /** Count days that had at least one request (for avg_daily calculation). */
    countActiveDays(): number {
      const row = _countActiveDays.get() as { count: number };
      return row.count;
    },

    insertAlert(data: AlertRecord): string {
      const id = nanoid();
      _insertAlert.run({
        id,
        type: data.type,
        message: data.message,
        channel: data.channel ?? null,
      });
      return id;
    },

    getAlerts(limit = 20): Array<AlertRecord & { id: string; delivered: number; created_at: string }> {
      return _getAlerts.all(limit) as Array<AlertRecord & { id: string; delivered: number; created_at: string }>;
    },

    markAlertDelivered(id: string): void {
      _markAlertDelivered.run(id);
    },

    // --- Budget helpers ---------------------------------------------------

    /** Load the active budget record for a given type within the current period. */
    getBudgetForPeriod(type: "daily" | "monthly"): BudgetRow | undefined {
      return _getBudgetForPeriod.get(type) as BudgetRow | undefined;
    },

    /** Create or fully replace a budget record. */
    upsertBudget(data: {
      id: string;
      type: "daily" | "monthly";
      limitUsd: number;
      currentSpend: number;
      status: string;
      periodStart: string;
      periodEnd: string;
    }): void {
      _upsertBudget.run({
        id:            data.id,
        type:          data.type,
        limit_usd:     data.limitUsd,
        current_spend: data.currentSpend,
        status:        data.status,
        period_start:  data.periodStart,
        period_end:    data.periodEnd,
      });
    },

    /** Update just the spend and status of a budget. */
    updateBudget(id: string, currentSpend: number, status: string): void {
      _updateBudget.run({ id, current_spend: currentSpend, status });
    },

    /**
     * Returns per-(original_model, final_model) routing stats for a time range.
     * Only includes rows where smart routing changed the model.
     * `total_saved` is approximate (sum of actual cost_usd logged for routed requests;
     * the real saving is original price − routed price, but we store the routed cost).
     */
    getRoutingStats(start: number, end: number): RoutingStatsRow[] {
      return _getRoutingStats.all(start, end) as RoutingStatsRow[];
    },
  };
}

export type Queries = ReturnType<typeof createQueries>;
