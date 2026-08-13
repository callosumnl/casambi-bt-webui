export type Role = "admin" | "user";
export type Session = { token: string; user: { id: number; username: string; role: Role } };
export type Capability = { type: string; min?: number | null; max?: number | null; readOnly: boolean };
export type Device = { id: number; name: string; address: string; model?: string | null; capabilities: Capability[]; roomId?: number; roomName?: string; state: { dimmer?: number | null; temperature?: number | null; sensors: { label: string; value: number | null; unit: string | null }[]; on: boolean; online: boolean } };
export type NetworkSnapshot = { connected: boolean; network: { id: string; name: string } | null; units: Device[]; groups: { id: number; name: string; unitIds: number[] }[]; scenes: { id: number; name: string }[]; rooms: { id: number; name: string; sortOrder: number; defaultBrightnessPercent: number }[]; updatedAt: string };
export type SolarSchedule = { event: "sunrise" | "sunset"; offsetMinutes: number };
export type Schedule = { id: number; name: string; cronExpression: string; timezone: string; command: { targetType: string; targetId?: number | string | null; operation: string; value?: unknown; fadeDurationMs?: number }; solar?: SolarSchedule | null; enabled: boolean; lastRunAt: string | null; nextRunAt?: string | null };

const SESSION_KEY = "casambi-bt-webui.session";

/** A typed same-origin API client. No secrets are placed in a URL except SSE’s short-lived browser token. */
export class LocalApi {
  public constructor(private readonly token: string | null = getSession()?.token ?? null) {}

  public async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(init.headers || {}) },
    });
    if (response.status === 204) return undefined as T;
    const data = await response.json() as T & { error?: { message: string } };
    if (!response.ok) throw new Error(data.error?.message || `Request failed with HTTP ${response.status}.`);
    return data;
  }

  public eventUrl(): string { return `/api/v1/events?access_token=${encodeURIComponent(this.token || "")}`; }
}

export function getSession(): Session | null { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null") as Session | null; } catch { return null; } }
export function saveSession(session: Session): void { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
export function clearSession(): void { localStorage.removeItem(SESSION_KEY); }
