import { randomUUID } from "crypto";
import { Response } from "express";

/** A same-origin Server-Sent Events hub for device, bridge, and schedule updates. */
export class EventHub {
  private readonly clients = new Map<string, Response>();

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
    return () => this.clients.delete(id);
  }

  /** Broadcast a typed payload without retaining state or secrets. */
  public publish(type: string, payload: unknown): void {
    const line = `event: ${type}\ndata: ${JSON.stringify({ type, payload, at: new Date().toISOString() })}\n\n`;
    for (const [id, response] of Array.from(this.clients.entries())) {
      try { response.write(line); } catch { this.clients.delete(id); }
    }
  }

  /** Number of currently connected browser clients. */
  public get clientCount(): number { return this.clients.size; }
}
