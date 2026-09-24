/**
 * Coalesces rapid slider input so a drag sends one command per pause and one on
 * release, instead of one per pixel. Each send becomes a serialized Bluetooth
 * command, so unthrottled input queues up and the lamp lags behind the thumb.
 */
export class SliderCommitter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: number | null = null;
  private lastSent: number | null = null;
  private holding = false;
  private inFlight: Promise<void> = Promise.resolve();

  /** `onSettled` runs once the interaction is over and its last send has finished. */
  public constructor(private readonly send: (value: number) => unknown, private readonly onSettled: () => void, private readonly delayMs = 300) {}

  /** Records a new value and sends it once input pauses for `delayMs`. */
  public input(value: number): void {
    this.pending = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.holding ? this.flush() : this.release()), this.delayMs);
  }

  /** Marks the start of a pointer drag. */
  public press(): void { this.holding = true; }

  /** Ends the interaction: sends any unsent value immediately. */
  public release(): void {
    this.holding = false;
    this.flush();
    const settled = this.inFlight;
    void settled.then(() => {
      if (this.holding || this.pending !== null || this.inFlight !== settled) return;
      this.lastSent = null;
      this.onSettled();
    });
  }

  public dispose(): void { clearTimeout(this.timer); }

  private flush(): void {
    clearTimeout(this.timer);
    const value = this.pending;
    this.pending = null;
    if (value === null || value === this.lastSent) return;
    this.lastSent = value;
    this.inFlight = Promise.resolve(this.send(value)).then(() => undefined, () => undefined);
  }
}
