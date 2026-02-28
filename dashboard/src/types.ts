// ---------------------------------------------------------------------------
// API response types — mirror the backend schemas exactly
// ---------------------------------------------------------------------------

export interface DailyCostRow {
  date:                 string;
  total_cost:           number;
  total_input_tokens:   number;
  total_output_tokens:  number;
  request_count:        number;
  blocked_count:        number;
}

export interface ModelCostRow {
  model:          string;
  provider:       string;
  cost:           number;
  input_tokens:   number;
  output_tokens:  number;
  request_count:  number;
}

export interface SessionCostRow {
  session_id:     string;
  cost:           number;
  input_tokens:   number;
  output_tokens:  number;
  request_count:  number;
}

export interface HourlyCostRow {
  hour:           number; // 0-23
  cost:           number;
  input_tokens:   number;
  output_tokens:  number;
  request_count:  number;
}

export interface RequestRecord {
  id:                  string;
  timestamp:           number;
  provider:            string;
  model:               string;
  original_model?:     string | null;
  input_tokens:        number;
  output_tokens:       number;
  cache_read_tokens:   number;
  cache_write_tokens:  number;
  cost_usd:            number;
  session_id?:         string | null;
  request_type:        string;
  duration_ms:         number;
  blocked:             number;
  block_reason?:       string | null;
}

export type AlertType = "budget_warning" | "budget_exceeded" | "loop_detected" | "daily_digest";

export interface AlertRecord {
  id:         string;
  type:       AlertType;
  message:    string;
  channel:    string | null;
  delivered:  number;
  created_at: string;
}

export type BudgetStatus = "active" | "warning" | "paused" | "override";

export interface BudgetState {
  id:           string;
  type:         "daily" | "monthly";
  limitUsd:     number;
  currentSpend: number;
  status:       BudgetStatus;
  periodStart:  string;
  periodEnd:    string;
}

export interface BudgetsResponse {
  daily:   BudgetState | null;
  monthly: BudgetState | null;
}

export interface RoutingStatsRow {
  original_model: string;
  final_model:    string;
  request_count:  number;
  total_saved:    number;
}

export interface AlertPreferences {
  telegramEnabled: boolean;
  emailEnabled:    boolean;
  digestTimeUtc:   string;
}

export interface SummaryResponse {
  today:            number;
  this_week:        number;
  this_month:       number;
  all_time:         number;
  avg_daily:        number;
  today_detail:     DailyCostRow | null;
  month_detail:     DailyCostRow | null;
  all_time_detail:  DailyCostRow | null;
}

export interface StatusResponse {
  status:          string;
  version:         string;
  uptimeMs:        number;
  platform:        string;
  nodeVersion:     string;
  dbSizeBytes:     number;
  smartRouting:    boolean;
  loopDetection:   boolean;
  budgetDaily:     number | null;
  budgetMonthly:   number | null;
}

export interface SettingsResponse {
  port:                    number;
  nodeEnv:                 string;
  logLevel:                string;
  anthropicApiKey?:        string;
  openaiApiKey?:           string;
  dashboardPassword:       string;
  jwtSecret:               string;
  budgetDaily:             number | null;
  budgetMonthly:           number | null;
  alertTelegramConfigured: boolean;
  alertEmailConfigured:    boolean;
  smartRoutingEnabled:     boolean;
  loopDetectionEnabled:    boolean;
  loopMaxRpm:              number | null;
  loopCooldownSeconds:     number | null;
  dbPath:                  string;
}

export interface RoutingStatsResponse {
  enabled: boolean;
  rules:   unknown[];
  stats:   RoutingStatsRow[];
}

// WebSocket event types
export interface WsRequestEvent {
  type: "request";
  data: {
    requestId:    string;
    provider:     string;
    model:        string;
    originalModel?: string;
    inputTokens:  number;
    outputTokens: number;
    costUsd:      number;
    durationMs:   number;
    blocked:      boolean;
    sessionId?:   string | null;
  };
}

export interface WsBudgetEvent {
  type: "budget";
  data: BudgetsResponse;
}

export interface WsPingEvent {
  type: "ping" | "connected";
  data?: unknown;
}

export type WsEvent = WsRequestEvent | WsBudgetEvent | WsPingEvent;
