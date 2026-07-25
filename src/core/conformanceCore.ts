import { RedactionKeyring } from "@tospec/redact";
import { ConformanceFaultKind, type ConformanceFault } from "./fault.js";
import { ConformanceMetrics, type ConformanceMetricsSnapshot } from "./metrics.js";
import { ConformanceState, type ConformanceSnapshot } from "./state.js";
import { ConformanceChannel } from "./conformanceChannel.js";
import { ConfigPoller } from "./configPoll.js";
import { BatchSender } from "./batchSender.js";
import { redactExchange } from "./exchangeRedactor.js";
import { shouldEmit } from "./sampler.js";
import { FetchTransport, type Transport } from "./transport.js";
import type { CapturedExchange } from "./captured.js";
import type { CoreOptions } from "../options.js";

/**
 * The framework-agnostic engine: owns the config snapshot, metrics, the bounded
 * channel, and the two background loops (poller + sender). The Express and
 * Fastify adapters share this one core. `captureExchange` runs on the request
 * path, never blocks, and never throws into the host. Port of the wiring in
 * `ServiceCollectionExtensions.cs` + the middleware's `CaptureSafely`.
 */
export class ConformanceCore {
  readonly metrics = new ConformanceMetrics();
  readonly state = new ConformanceState();
  private readonly channel: ConformanceChannel;
  private readonly keyring: RedactionKeyring;
  private readonly poller: ConfigPoller;
  private readonly sender: BatchSender;
  private readonly abort = new AbortController();
  private readonly loops: Array<Promise<void>> = [];
  private started = false;
  private readonly fault: (f: ConformanceFault) => void;

  constructor(
    readonly options: CoreOptions,
    transport: Transport = new FetchTransport(),
  ) {
    this.channel = new ConformanceChannel(options.queueCapacity, options.maxQueueBytes, this.metrics);
    this.keyring = new RedactionKeyring(options.redactionKey, options.redactionKeyVersion);
    const fault = (f: ConformanceFault): void => {
      try {
        options.onFault?.(f);
      } catch {
        /* a throwing fault hook must never surface */
      }
    };
    this.poller = new ConfigPoller(options, this.state, this.metrics, transport, fault);
    this.sender = new BatchSender(options, this.metrics, this.channel, this.state, transport, fault);
    this.fault = fault;
  }

  /** Launches the background poller + sender. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.loops.push(this.poller.runLoop(this.abort.signal));
    this.loops.push(this.sender.runLoop(this.abort.signal));
  }

  /** Aborts the background loops and awaits their (best-effort) completion. */
  async stop(): Promise<void> {
    this.sender.requestShutdown();
    this.abort.abort();
    await Promise.allSettled(this.loops);
  }

  get snapshot(): ConformanceSnapshot {
    return this.state.current;
  }

  metricsSnapshot(): ConformanceMetricsSnapshot {
    return this.metrics.snapshot();
  }

  /** Report a swallowed capture-path fault (adapter plumbing). Never throws. */
  reportCaptureFault(message: string, error?: unknown): void {
    this.fault({ kind: ConformanceFaultKind.Capture, message, error });
  }

  /**
   * Request-path capture: sample → redact (before transmission) → non-blocking
   * enqueue. Never blocks, never throws — every fault becomes a counter + hook.
   */
  captureExchange(captured: CapturedExchange, rng?: () => number): void {
    try {
      const snapshot = this.state.current;
      if (snapshot.killSwitch) return;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(captured.partnerId)) {
        this.fault({ kind: ConformanceFaultKind.Capture, message: "resolvePartnerId returned an invalid UUID" });
        return;
      }
      if (!shouldEmit(snapshot.sampling, captured.status, rng)) {
        this.metrics.incSampledOut();
        return;
      }
      const envelope = redactExchange(captured, snapshot, this.keyring, this.metrics);
      this.channel.tryWrite(envelope);
      this.metrics.incCaptured();
    } catch (e) {
      this.metrics.incRedactionFailure();
      this.fault({ kind: ConformanceFaultKind.Redaction, message: "capture/redaction failed", error: e });
    }
  }
}
