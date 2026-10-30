import type { LocalStore } from "../store";
import { LightingSnapshot, LightWrite, planWrites } from "./model";
import type { LightingSource } from "./registry";

export type WriteBatcherOptions = {
  /** Actor for the commands and prefix of the audit action ("homekit" → homekit.control_failed). */
  actor: string;
  /** How long writes are collected before they are sent, so On + Brightness and a whole room become one batch. */
  flushMs: number;
  /** How long a write may take before the platform is told it succeeded anyway; the command keeps running. */
  writeTimeoutMs: number;
  /** The error a write rejects with when it cannot be sent; each platform has its own "no response". */
  failure: () => Error;
  /** The lamps a light controls, or null when the light is gone. */
  unitIds: (key: string, snapshot: LightingSnapshot) => number[] | null;
  /** A light's current hue and saturation, for a write that changes only one of them. */
  currentColour: (key: string) => { hue: number; saturation: number };
};

/**
 * Collects writes from a smart home platform for a moment and sends them as planned Casambi commands, one batch at a
 * time, so a slow batch cannot interleave with the next. A colour temperature and a colour exclude each other: the
 * newest choice wins. Failures are audited and reject every write of the batch.
 */
export class WriteBatcher {
  private pending = new Map<string, LightWrite>();
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private sending: Promise<void> = Promise.resolve();

  public constructor(private readonly store: LocalStore, private readonly source: LightingSource, private readonly options: WriteBatcherOptions) {}

  /** Queues a write; it resolves when its batch was sent, or after the write timeout while Bluetooth is still busy. */
  public write(key: string, write: LightWrite): Promise<void> {
    if (!this.source.cachedSnapshot().connected) throw this.options.failure();
    const merged: LightWrite = { ...this.pending.get(key), ...write };
    if (write.mired !== undefined) { delete merged.hue; delete merged.saturation; }
    if (write.hue !== undefined || write.saturation !== undefined) delete merged.mired;
    this.pending.set(key, merged);
    const done = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.options.flushMs);
      this.flushTimer.unref();
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.writeTimeoutMs); timer.unref(); });
    return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
  }

  public close(): void { if (this.flushTimer) clearTimeout(this.flushTimer); }

  private flush(): void {
    const writes = this.pending;
    const waiters = this.waiters;
    this.pending = new Map();
    this.waiters = [];
    this.sending = this.sending.then(async () => {
      const snapshot = this.source.cachedSnapshot();
      try {
        if (!snapshot.connected) throw this.options.failure();
        const commands = planWrites(Array.from(writes, ([key, write]) => {
          const unitIds = this.options.unitIds(key, snapshot);
          if (!unitIds) return { unitIds: [], write };
          // Hue and Saturation usually arrive together; one alone keeps the light's current other value.
          const colour = write.hue !== undefined || write.saturation !== undefined ? (() => { const current = this.options.currentColour(key); return { hue: write.hue ?? current.hue, saturation: write.saturation ?? current.saturation }; })() : {};
          return { unitIds, write: { ...write, ...colour } };
        }), snapshot);
        for (const command of commands) await this.source.control(command, this.options.actor);
        waiters.forEach(waiter => waiter.resolve());
      } catch (error) {
        this.store.audit(this.options.actor, `${this.options.actor}.control_failed`, { message: error instanceof Error ? error.message : "Unknown error." });
        waiters.forEach(waiter => waiter.reject(this.options.failure()));
      }
    });
  }
}
