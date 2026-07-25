import type { IngestEventEnvelope } from "./wire.js";
import { estimateEventBytes } from "./wire.js";
import type { ConformanceMetrics } from "./metrics.js";

/**
 * The bounded, drop-oldest, single-reader queue that decouples the request path
 * from the background sender (the "bounded memory" guarantee, S5.3 §9). A push
 * that would exceed capacity evicts the oldest event and increments a counter —
 * it never blocks or backpressures the host. Node is single-threaded, so a plain
 * array ring is the analogue of the .NET bounded `Channel` with
 * `FullMode = DropOldest`. Port of `ConformanceChannel.cs`.
 */
export class ConformanceChannel {
  private readonly buffer: Array<IngestEventEnvelope | undefined>;
  private readonly sizes: number[];
  private head = 0;
  private count = 0;
  private bytes = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly maxBytes: number,
    private readonly metrics: ConformanceMetrics,
  ) {
    this.buffer = new Array(capacity);
    this.sizes = new Array<number>(capacity).fill(0);
  }

  /** Always succeeds: evicts the oldest event when full (drop-oldest). */
  tryWrite(item: IngestEventEnvelope): void {
    const itemBytes = estimateEventBytes(item);
    while (this.count > 0 && (this.count >= this.capacity || this.bytes + itemBytes > this.maxBytes)) {
      this.dropOldest();
    }
    if (itemBytes > this.maxBytes) {
      this.metrics.incDroppedQueueFull();
      return;
    }
    const tail = (this.head + this.count) % this.capacity;
    this.buffer[tail] = item;
    this.sizes[tail] = itemBytes;
    this.bytes += itemBytes;
    this.count++;
    this.wake();
  }

  tryRead(): IngestEventEnvelope | undefined {
    if (this.count === 0) return undefined;
    const item = this.buffer[this.head];
    this.bytes -= this.sizes[this.head] ?? 0;
    this.buffer[this.head] = undefined;
    this.sizes[this.head] = 0;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return item;
  }

  clear(): number {
    const removed = this.count;
    this.buffer.fill(undefined);
    this.sizes.fill(0);
    this.head = 0;
    this.count = 0;
    this.bytes = 0;
    return removed;
  }

  get size(): number {
    return this.count;
  }

  /** Resolves when an item is available or the signal aborts. */
  async waitForItem(signal: AbortSignal): Promise<void> {
    if (this.count > 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        remove();
        resolve();
      };
      const wake = (): void => {
        remove();
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const remove = (): void => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      this.waiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private wake(): void {
    if (this.waiters.length === 0) return;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w();
  }

  private dropOldest(): void {
    this.bytes -= this.sizes[this.head] ?? 0;
    this.buffer[this.head] = undefined;
    this.sizes[this.head] = 0;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    this.metrics.incDroppedQueueFull();
  }
}
