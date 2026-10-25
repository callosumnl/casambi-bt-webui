import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveSession, getSession, LocalApi, saveSession, SESSION_EXPIRED_EVENT, tokenExpiresAt } from "./localApi";

/** A JWT-shaped token; only the payload matters because the client never verifies signatures. */
function token(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}
const session = (expiresInSeconds: number) => ({ token: token({ sub: "1", exp: Math.floor(Date.now() / 1000) + expiresInSeconds }), user: { id: 1, username: "admin", role: "admin" as const } });

describe("session handling", () => {
  let expired: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const target = new EventTarget();
    expired = vi.fn();
    target.addEventListener(SESSION_EXPIRED_EVENT, expired);
    vi.stubGlobal("window", target);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads the expiry from a JWT and returns null for unreadable tokens", () => {
    expect(tokenExpiresAt(token({ exp: 1_790_000_000 }))).toBe(1_790_000_000_000);
    expect(tokenExpiresAt(token({ sub: "1" }))).toBeNull();
    expect(tokenExpiresAt("not-a-jwt")).toBeNull();
  });

  it("drops an already-expired stored session on load", () => {
    saveSession(session(-60));
    expect(getActiveSession()).toBeNull();
    expect(getSession()).toBeNull();
    saveSession(session(3_600));
    expect(getActiveSession()?.user.username).toBe("admin");
  });

  it("ends the session and notifies the app when a signed-in request gets a 401", async () => {
    saveSession(session(3_600));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Authentication required." } }), { status: 401 })));
    await expect(new LocalApi().request("/network")).rejects.toThrow("Your session has expired. Please sign in again.");
    expect(getSession()).toBeNull();
    expect(expired).toHaveBeenCalledOnce();
  });

  it("keeps the session for a 403 and for an anonymous 401 such as a wrong password", async () => {
    saveSession(session(3_600));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Administrator role required." } }), { status: 403 })));
    await expect(new LocalApi().request("/admin/config")).rejects.toThrow("Administrator role required.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid username or password." } }), { status: 401 })));
    await expect(new LocalApi(null).request("/auth/login", { method: "POST" })).rejects.toThrow("Invalid username or password.");
    expect(getSession()).not.toBeNull();
    expect(expired).not.toHaveBeenCalled();
  });

  it("names the fields a validation error is about", async () => {
    saveSession(session(3_600));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "Request validation failed.", fields: { formErrors: [], fieldErrors: { password: ["Too small: expected string to have >=12 characters"], username: ["Invalid string"] } } } }), { status: 422 })));
    await expect(new LocalApi().request("/admin/users", { method: "POST" })).rejects.toThrow("Request validation failed. password: Too small: expected string to have >=12 characters; username: Invalid string");
  });
});

