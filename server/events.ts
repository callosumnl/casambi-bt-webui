import { randomUUID } from "crypto";
import { Response } from "express";
import type { Principal } from "./auth";

const HEARTBEAT_MS = 25_000;
/** Open streams per account or API key; opening one more closes that principal's oldest. */
export const MAX_STREAMS_PER_PRINCIPAL = 10;

/** Who receives an event: everyone, administrators only, or administrators plus the account that owns the subject. */
export type EventAudience = "all" | "admins" | { ownerUserId: number };
type Client = { response: Response; principal: Principal | null };

/** A same-origin Server-Sent Events hub for device, bridge, and schedule updates. */
export class EventHub {
  private readonly clients = new Map<string, Client>();
  private heartbeat: NodeJS.Timeout | null = null;

  /**
   * `buildId` identifies the web app build being served; every stream's `connected` event carries it, so a
   * page left open across an update sees the change when it reconnects and reloads itself.
   */
  public constructor(private readonly buildId: string | null = null) {}

  /** Attach an HTTP response to the event stream. */
  public add(response: Response, principal: Principal | null = null): () => void {
    const id = randomUUID();
    if (principal) {
      const own = Array.from(this.clients.entries()).filter(([, client]) => samePrincipal(client.principal, principal));
      for (const [oldest, client] of own.slice(0, Math.max(0, own.length - MAX_STREAMS_PER_PRINCIPAL + 1))) { this.clients.delete(oldest); client.response.end(); }
    }
    response.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write(`event: connected\ndata: ${JSON.stringify({ id, build: this.buildId, at: new Date().toISOString() })}\n\n`);
    this.clients.set(id, { response, principal });
    this.startHeartbeat();
    return () => { this.clients.delete(id); if (this.clients.size === 0) this.stopHeartbeat(); };
  }

  /** Broadcast a typed payload without retaining state or secrets. */
  public publish(type: string, payload: unknown, audience: EventAudience = "all"): void {
    const line = `event: ${type}\ndata: ${JSON.stringify({ type, payload, at: new Date().toISOString() })}\n\n`;
    for (const [id, client] of Array.from(this.clients.entries())) {
      if (!receives(client.principal, audience)) continue;
      try { client.response.write(line); } catch { this.clients.delete(id); }
    }
  }

  /** Ends every stream of an account or API key, e.g. after it was deleted or its password was reset. */
  public disconnect(principal: Pick<Principal, "kind" | "id">): void {
    for (const [id, client] of Array.from(this.clients.entries())) {
      if (samePrincipal(client.principal, principal)) { this.clients.delete(id); client.response.end(); }
    }
  }

  /**
   * An SSE comment every 25 s keeps idle connections open through proxies and lets a failed write reveal a
   * client that vanished without closing (e.g. a phone that went out of Wi-Fi range).
   */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [id, client] of Array.from(this.clients.entries())) {
        try { client.response.write(": heartbeat\n\n"); } catch { this.clients.delete(id); }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** The build ID sent with every `connected` event. */
  public get build(): string | null { return this.buildId; }

  /** Number of currently connected browser clients. */
  public get clientCount(): number { return this.clients.size; }
}

function samePrincipal(left: Pick<Principal, "kind" | "id"> | null, right: Pick<Principal, "kind" | "id">): boolean {
  return left !== null && left.kind === right.kind && left.id === right.id;
}

/** Streams opened without a principal (tests, internal use) receive everything. */
function receives(principal: Principal | null, audience: EventAudience): boolean {
  if (audience === "all" || !principal || principal.role === "admin") return true;
  return audience !== "admins" && principal.kind === "user" && principal.id === audience.ownerUserId;
}
