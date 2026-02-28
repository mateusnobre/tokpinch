import type {
  DailyCostRow,
  ModelCostRow,
  SessionCostRow,
  HourlyCostRow,
  RequestRecord,
  AlertRecord,
  AlertPreferences,
  BudgetsResponse,
  BudgetState,
  SummaryResponse,
  StatusResponse,
  SettingsResponse,
  RoutingStatsResponse,
} from "./types";

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

const TOKEN_KEY = "tokpinch_token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Fetch wrapper
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/dashboard/";
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(
  password: string,
): Promise<{ token: string; expiresAt: number }> {
  return apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

// ---------------------------------------------------------------------------
// Costs
// ---------------------------------------------------------------------------

export async function getCostsToday(): Promise<DailyCostRow> {
  return apiFetch("/api/costs/today");
}

export async function getCostsDaily(days = 30): Promise<DailyCostRow[]> {
  return apiFetch(`/api/costs/daily?days=${days}`);
}

export async function getCostsHourly(
  date?: string,
): Promise<{ date: string; hours: HourlyCostRow[] }> {
  return apiFetch(`/api/costs/hourly${date ? `?date=${date}` : ""}`);
}

export async function getCostsByModel(
  start?: number,
  end?: number,
): Promise<ModelCostRow[]> {
  const params = new URLSearchParams();
  if (start) params.set("start", String(start));
  if (end) params.set("end", String(end));
  return apiFetch(`/api/costs/by-model?${params}`);
}

export async function getCostsBySession(
  start?: number,
  end?: number,
): Promise<SessionCostRow[]> {
  const params = new URLSearchParams();
  if (start) params.set("start", String(start));
  if (end) params.set("end", String(end));
  return apiFetch(`/api/costs/by-session?${params}`);
}

export async function getCostsSummary(): Promise<SummaryResponse> {
  return apiFetch("/api/costs/summary");
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export async function getBudgets(): Promise<BudgetsResponse> {
  return apiFetch("/api/budgets");
}

export async function updateBudgets(data: {
  daily?: number;
  monthly?: number;
}): Promise<BudgetsResponse> {
  return apiFetch("/api/budgets", {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export async function overrideBudget(
  type: "daily" | "monthly",
): Promise<BudgetsResponse> {
  return apiFetch(`/api/budgets/${type}/override`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export async function getRequests(
  limit = 50,
  offset = 0,
): Promise<{ limit: number; offset: number; rows: RequestRecord[] }> {
  return apiFetch(`/api/requests?limit=${limit}&offset=${offset}`);
}

export async function getLiveRequests(): Promise<RequestRecord[]> {
  return apiFetch("/api/requests/live");
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export async function getAlerts(limit = 50): Promise<AlertRecord[]> {
  return apiFetch(`/api/alerts?limit=${limit}`);
}

// ---------------------------------------------------------------------------
// Status & Settings
// ---------------------------------------------------------------------------

export async function getStatus(): Promise<StatusResponse> {
  return apiFetch("/api/status");
}

export async function getSettings(): Promise<SettingsResponse> {
  return apiFetch("/api/settings");
}

export async function getRoutingStats(
  start?: number,
  end?: number,
): Promise<RoutingStatsResponse> {
  const params = new URLSearchParams();
  if (start) params.set("start", String(start));
  if (end) params.set("end", String(end));
  return apiFetch(`/api/routing-stats?${params}`);
}

export async function getAlertPreferences(): Promise<AlertPreferences> {
  return apiFetch("/api/settings/alerts");
}

export async function updateAlertPreferences(
  data: Partial<AlertPreferences>,
): Promise<AlertPreferences> {
  return apiFetch("/api/settings/alerts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// Re-export BudgetState for consumers
export type { BudgetState };
