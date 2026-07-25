import { INGEST_PATH, INGEST_KEY_HEADER, SIGNATURE_HEADER } from "../constants.js";
import { ConformanceFaultKind, type OnFault } from "./fault.js";
import { batchWireObject, estimateEventBytes, type IngestBatch, type IngestEventEnvelope } from "./wire.js";
import { encodeBatchInWorker } from "./batchEncoder.js";
import { uuidv7 } from "./uuidv7.js";
import type { CoreOptions } from "../options.js";
import type { ConformanceMetrics } from "./metrics.js";
import type { ConformanceChannel } from "./conformanceChannel.js";
import type { ConformanceState } from "./state.js";
import type { Transport } from "./transport.js";
import { isAbortError } from "./util.js";

/**
 * Background batcher (S5.3 §9). Reads events from the bounded channel,
 * accumulates until a size/count/linger cap, then gzips, signs, and POSTs one
 * batch. Failed batches are dropped, never retried (retry would defeat the memory
 * bound). Runs entirely off the request path. Port of `BatchSenderService.cs`.
 */
export class BatchSender {
  private readonly ingestKeyUtf8: Buffer;
  private killController = new AbortController();
  private readonly shutdownController = new AbortController();
  private shuttingDown = false;
  private shutdownSignal: AbortSignal | null = null;

  constructor(
    private readonly options: CoreOptions,
    private readonly metrics: ConformanceMetrics,
    private readonly channel: ConformanceChannel,
    private readonly state: ConformanceState,
    private readonly transport: Transport,
    private readonly fault: OnFault,
  ) {
    this.ingestKeyUtf8 = Buffer.from(options.ingestKey, "utf8");
    this.state.subscribe((snapshot) => {
      if (snapshot.killSwitch) {
        this.channel.clear();
        this.killController.abort();
      } else if (this.killController.signal.aborted) {
        this.killController = new AbortController();
      }
    });
  }

  async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.channel.waitForItem(signal);
      if (signal.aborted) break;
      if (this.state.current.killSwitch) {
        this.channel.clear();
        continue;
      }
      const first = this.channel.tryRead();
      if (first === undefined) continue;
      const events = await this.accumulate(first, signal);
      if (!this.state.current.killSwitch) {
        const handled = await this.send(events);
        if (!handled && this.shuttingDown && this.shutdownSignal !== null) {
          await this.send(events, this.shutdownSignal);
        }
      }
    }
    await this.finalDrain();
  }

  requestShutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownSignal = AbortSignal.timeout(2000);
    this.shutdownController.abort();
  }

  private async accumulate(first: IngestEventEnvelope, signal: AbortSignal): Promise<IngestEventEnvelope[]> {
    const batch = [first];
    let bytes = estimateEventBytes(first);
    const deadline = Date.now() + this.options.flushInterval;

    while (batch.length < this.options.maxBatchEvents && bytes < this.options.maxBatchBytes) {
      const next = this.channel.tryRead();
      if (next !== undefined) {
        batch.push(next);
        bytes += estimateEventBytes(next);
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) break;
      const composite = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      await this.channel.waitForItem(composite);
      if (signal.aborted) break;
    }
    return batch;
  }

  private async send(events: IngestEventEnvelope[], overrideSignal?: AbortSignal): Promise<boolean> {
    if (events.length === 0 || this.state.current.killSwitch) return true;
    const batch: IngestBatch = { batchId: uuidv7(), events };
    const signal = overrideSignal ?? AbortSignal.any([this.killController.signal, this.shutdownController.signal]);
    try {
      const { wire, signature } = await encodeBatchInWorker(batchWireObject(batch), this.ingestKeyUtf8, signal);
      const headers: Record<string, string> = {
        "Content-Encoding": "gzip",
        "Content-Type": "application/json",
        [INGEST_KEY_HEADER]: this.options.ingestKey,
        [SIGNATURE_HEADER]: signature,
      };
      let res = await this.transport.post(
        this.options.ingestBaseUrl + INGEST_PATH, headers, wire, this.options.ingestTimeout, signal);
      for (const backoff of [100, 250]) {
        if (res.status !== 409 || signal.aborted || this.state.current.killSwitch) break;
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
        res = await this.transport.post(
          this.options.ingestBaseUrl + INGEST_PATH, headers, wire, this.options.ingestTimeout, signal);
      }
      if (res.status >= 200 && res.status < 300) {
        this.metrics.incBatchSent(events.length);
      } else {
        this.metrics.incBatchFailed();
        this.fault({ kind: ConformanceFaultKind.BatchSend, message: `ingest returned ${res.status}` });
      }
      return true;
    } catch (e) {
      if (isAbortError(e)
          && (overrideSignal?.aborted === true || this.killController.signal.aborted || this.shutdownController.signal.aborted)) {
        return false;
      }
      this.metrics.incBatchFailed();
      this.fault({ kind: ConformanceFaultKind.BatchSend, message: "ingest post failed", error: e });
      return true;
    }
    // Rejected/failed batches are dropped, never retried.
  }

  /** Best-effort final flush on shutdown, bounded to ~2s with a fresh signal. */
  private async finalDrain(): Promise<void> {
    if (this.channel.size === 0) return;
    const signal = this.shutdownSignal ?? AbortSignal.timeout(2000);
    try {
      let next = this.channel.tryRead();
      while (next !== undefined && !signal.aborted) {
        const batch = [next];
        while (batch.length < this.options.maxBatchEvents) {
          const more = this.channel.tryRead();
          if (more === undefined) break;
          batch.push(more);
        }
        if (!this.state.current.killSwitch) await this.send(batch, signal);
        next = this.channel.tryRead();
      }
    } finally { /* the AbortSignal timeout owns its timer */ }
  }
}
