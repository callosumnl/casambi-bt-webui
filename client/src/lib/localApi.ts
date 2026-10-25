export type Role = "admin" | "user";
export type Session = { token: string; user: { id: number; username: string; role: Role } };
export type Capability = { type: string; min?: number | null; max?: number | null; readOnly: boolean };
export type Device = { id: number; name: string; address: string; model?: string | null; capabilities: Capability[]; roomId?: number; roomName?: string; state: { dimmer?: number | null; temperature?: number | null; sensors: { label: string; value: number | null; unit: string | null }[]; on: boolean; online: boolean } };
/** Mirrors the server's `ConnectionStatus`: what the Pi is doing about its Casambi connection. */
export type ConnectionStatus = { phase: "idle" } | { phase: "connecting"; attempt: number } | { phase: "connected" } | { phase: "retrying"; attempt: number; nextRetryAt: string; lastError: string } | { phase: "failed"; lastError: string };
export type NetworkSnapshot = { connected: boolean; network: { id: string; name: string } | null; units: Device[]; groups: { id: number; name: string; unitIds: number[] }[]; scenes: { id: number; name: string }[]; rooms: { id: number; name: string; sortOrder: number; defaultBrightnessPercent: number }[]; updatedAt: string };
/** A scene saved on the Pi: the captured setting of a group, room, or all lamps (levels 0-255, 0 = off). */
export type SceneScope = { type: "group" | "room" | "network"; id: number | null };
export type LocalScene = { id: number; name: string; scope: SceneScope; lamps: Array<{ unitId: number; level: number; temperature: number | null }> };
export type SolarSchedule = { event: "sunrise" | "sunset"; offsetMinutes: number };
export type AwayDateSet = { id: number; name: string; dates: string[]; createdAt?: string; updatedAt?: string };
export type Schedule = { id: number; name: string; cronExpression: string; timezone: string; command: { targetType: string; targetId?: number | string | null; operation: string; value?: unknown; fadeDurationMs?: number }; solar?: SolarSchedule | null; holidayDates: string[]; awayDateSetId: number | null; awayDateSet: AwayDateSet | null; enabled: boolean; lastRunAt: string | null; nextRunAt?: string | null };

/** An API key as listed by the server; the secret token is only returned once, at creation. */
export type Room = NetworkSnapshot["rooms"][number];
export type LocalUser = { id: number; username: string; role: Role; createdAt: string };
export type AuditEntry = { id: number; actor: string; action: string; detail: Record<string, unknown>; createdAt: string };
export type ApiKey = { id: number; label: string; prefix: string; role: Role; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
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
    const data = await response.json().catch(() => ({})) as T & { error?: { message: string; fields?: ValidationFields } };
    if (!response.ok) throw new Error(describeError(data.error, response.status));
    return data;
  }

  public eventUrl(): string { return `/api/v1/events?access_token=${encodeURIComponent(this.token || "")}`; }
}

type ValidationFields = { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };

/** The server's message plus, for validation errors, which field failed and why. */
export function describeError(error: { message: string; fields?: ValidationFields } | undefined, status: number): string {
  if (!error) return `Request failed with HTTP ${status}.`;
  const details = [
    ...(error.fields?.formErrors ?? []),
    ...Object.entries(error.fields?.fieldErrors ?? {}).flatMap(([field, messages]) => messages?.length ? [`${field}: ${messages[0]}`] : []),
  ];
  return details.length ? `${error.message} ${details.join("; ")}` : error.message;
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
