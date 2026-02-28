// ---------------------------------------------------------------------------
// Table definitions — CREATE TABLE IF NOT EXISTS so they're idempotent.
// All schema changes go through the migrations system in migrations.ts.
// ---------------------------------------------------------------------------

export const CREATE_SCHEMA_VERSION = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    DEFAULT (datetime('now'))
  )
`;

export const CREATE_REQUESTS = `
  CREATE TABLE IF NOT EXISTS requests (
    id                TEXT    PRIMARY KEY,
    timestamp         INTEGER NOT NULL,
    provider          TEXT    NOT NULL CHECK(provider IN ('anthropic', 'openai', 'google')),
    model             TEXT    NOT NULL,
    original_model    TEXT,
    input_tokens      INTEGER NOT NULL,
    output_tokens     INTEGER NOT NULL,
    cache_read_tokens  INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    cost_usd          REAL    NOT NULL,
    session_id        TEXT,
    skill_name        TEXT,
    request_type      TEXT    DEFAULT 'unknown'
                              CHECK(request_type IN ('chat', 'heartbeat', 'tool_call', 'unknown')),
    duration_ms       INTEGER,
    blocked           INTEGER DEFAULT 0,
    block_reason      TEXT    CHECK(block_reason IN ('budget_exceeded', 'loop_detected') OR block_reason IS NULL),
    created_at        TEXT    DEFAULT (datetime('now'))
  )
`;

export const CREATE_DAILY_COSTS = `
  CREATE TABLE IF NOT EXISTS daily_costs (
    date               TEXT    PRIMARY KEY,
    total_cost         REAL    DEFAULT 0,
    total_input_tokens  INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    request_count      INTEGER DEFAULT 0,
    blocked_count      INTEGER DEFAULT 0,
    updated_at         TEXT    DEFAULT (datetime('now'))
  )
`;

export const CREATE_BUDGETS = `
  CREATE TABLE IF NOT EXISTS budgets (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL CHECK(type IN ('daily', 'weekly', 'monthly')),
    limit_usd     REAL NOT NULL,
    current_spend REAL DEFAULT 0,
    status        TEXT DEFAULT 'active' CHECK(status IN ('active', 'warning', 'paused')),
    period_start  TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  )
`;

export const CREATE_ALERTS = `
  CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL CHECK(type IN ('budget_warning', 'budget_exceeded', 'loop_detected', 'daily_digest')),
    message    TEXT NOT NULL,
    delivered  INTEGER DEFAULT 0,
    channel    TEXT CHECK(channel IN ('telegram', 'email') OR channel IS NULL),
    created_at TEXT DEFAULT (datetime('now'))
  )
`;

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

export const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_requests_timestamp  ON requests (timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_provider   ON requests (provider)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_model      ON requests (model)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_session    ON requests (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_costs_date    ON daily_costs (date)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_created_at  ON alerts (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alerts_type        ON alerts (type)`,
] as const;
