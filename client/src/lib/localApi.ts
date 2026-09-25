export type Role = "admin" | "user";
export type Session = { token: string; user: { id: number; username: string; role: Role } };
export type Capability = { type: string; min?: number | null; max?: number | null; readOnly: boolean };
export type Device = { id: number; name: string; address: string; model?: string | null; capabilities: Capability[]; roomId?: number; roomName?: string; state: { dimmer?: number | null; temperature?: number | null; sensors: { label: string; value: number | null; unit: string | null }[]; on: boolean; online: boolean } };
/** Mirrors the server's `ConnectionStatus`: what the Pi is doing about its Casambi connection. */
export type ConnectionStatus = { phase: "idle" } | { phase: "connecting"; attempt: number } | { phase: "connected" } | { phase: "retrying"; attempt: number; nextRetryAt: string; lastError: string } | { phase: "failed"; lastError: string };
export type NetworkSnapshot = { connected: boolean; network: { id: string; name: string } | null; units: Device[]; groups: { id: number; name: string; unitIds: number[] }[]; scenes: { id: number; name: string }[]; rooms: { id: number; name: string; sortOrder: number; defaultBrightnessPercent: number }[]; updatedAt: string };
export type SolarSchedule = { event: "sunrise" | "sunset"; offsetMinutes: number };
export type AwayDateSet = { id: number; name: string; dates: string[]; createdAt?: string; updatedAt?: string };
export type Schedule = { id: number; name: string; cronExpression: string; timezone: string; command: { targetType: string; targetId?: number | string | null; operation: string; value?: unknown; fadeDurationMs?: number }; solar?: SolarSchedule | null; holidayDates: string[]; awayDateSetId: number | null; awayDateSet: AwayDateSet | null; enabled: boolean; lastRunAt: string | null; nextRunAt?: string | null };

export type SwitchTrigger = "tap" | "hold" | "release_after_hold";
/** A reported button message; `trigger` is null for raw activity that never drives a rule. */
export type SwitchPress = { unitId: number | null; button: number | null; trigger: SwitchTrigger | null; raw: Record<string, unknown>; at: string };
export type SwitchRule = { id: number; name: string; unitId: number; button: number; trigger: SwitchTrigger; command: { targetType: string; targetId?: number | string | null; operation: string; value?: unknown }; enabled: boolean; lastTriggeredAt: string | null };

const SESSION_KEY = "casambi-bt-webui.session";
/** Fired on `window` when a signed-in request is rejected with 401, so the app can return to the login screen. */
export const SESSION_EXPIRED_EVENT = "casambi-bt-webui:session-expired";

/** A typed same-origin API client. No secrets are placed in a URL except SSE’s short-lived browser token. */
export class LocalApi {
  public constructor(private readonly token: string | null = getSession()?.token ?? null) {}

  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(init.headers || {}) },
    });
    // A rejected token (expired, or signed with a rotated secret) ends the session. Anonymous
    // requests such as the login form get their own 401 message instead.
    if (response.status === 401 && this.token) {
      clearSession();
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (response.status === 204) return undefined as T;
    // Some failures (e.g. the rate limiter's 429) have a non-JSON body; keep the HTTP status message instead of a parse error.
    const data = await response.json().catch(() => ({})) as T & { error?: { message: string } };
    if (!response.ok) throw new Error(data.error?.message || `Request failed with HTTP ${response.status}.`);
    return data;
  }

  public eventUrl(): string { return `/api/v1/events?access_token=${encodeURIComponent(this.token || "")}`; }
}

export function getSession(): Session | null { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null") as Session | null; } catch { return null; } }
export function saveSession(session: Session): void { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
export function clearSession(): void { localStorage.removeItem(SESSION_KEY); }

/** The JWT's `exp` claim in milliseconds, read without verification (the server still verifies); null if unreadable. */
export function tokenExpiresAt(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch { return null; }
}

/** A stored session whose token has not yet expired. */
export function getActiveSession(now = Date.now()): Session | null {
  const session = getSession();
  if (!session) return null;
  const expiresAt = tokenExpiresAt(session.token);
  if (expiresAt !== null && expiresAt <= now) { clearSession(); return null; }
  return session;
}
