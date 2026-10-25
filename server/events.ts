import { randomUUID } from "crypto";
import { Response } from "express";

const HEARTBEAT_MS = 25_000;

/** A same-origin Server-Sent Events hub for device, bridge, and schedule updates. */
export class EventHub {
  private readonly clients = new Map<string, Response>();
  private heartbeat: NodeJS.Timeout | null = null;

  /** Attach an HTTP response to the event stream. */
  public add(response: Response): () => void {
    const id = randomUUID();
    response.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write(`event: connected\ndata: ${JSON.stringify({ id, at: new Date().toISOString() })}\n\n`);
    this.clients.set(id, response);
    this.startHeartbeat();
    return () => { this.clients.delete(id); if (this.clients.size === 0) this.stopHeartbeat(); };
  }

  /** Broadcast a typed payload without retaining state or secrets. */
  public publish(type: string, payload: unknown): void {
    const line = `event: ${type}\ndata: ${JSON.stringify({ type, payload, at: new Date().toISOString() })}\n\n`;
    for (const [id, response] of Array.from(this.clients.entries())) {
      try { response.write(line); } catch { this.clients.delete(id); }
    }
  }

  /**
   * An SSE comment every 25 s keeps idle connections open through proxies and lets a failed write reveal a
   * client that vanished without closing (e.g. a phone that went out of Wi-Fi range).
   */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [id, response] of Array.from(this.clients.entries())) {
        try { response.write(": heartbeat\n\n"); } catch { this.clients.delete(id); }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Number of currently connected browser clients. */
  public get clientCount(): number { return this.clients.size; }
}
