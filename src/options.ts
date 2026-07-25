import type { OnFault } from "./core/fault.js";

/**
 * Configuration for `useToSpecConformance`. Required: `ingestBaseUrl`,
 * `ingestKey`, `redactionKey`, `resolvePartnerId`. Everything else has a default.
 * Port of `ToSpecConformanceOptions.cs`.
 */
export interface ToSpecConformanceOptions<Req = unknown> {
  /** Base of the ingest edge, e.g. `https://ingest.tospec.net`. */
  ingestBaseUrl: string;
  /** Per-tenant `tsp_ing_…` key — bearer credential AND HMAC secret. */
  ingestKey: string;
  /** Per-tenant redaction HMAC key (raw bytes) — the same key the gateway uses. */
  redactionKey: Buffer | Uint8Array;
  /** Embedded in every `tsr_v{n}_…` token. Default 1. */
  redactionKeyVersion?: number;
  /** Maps a request to its partner id; null/undefined ⇒ skip capture. */
  resolvePartnerId: (req: Req) => string | null | undefined;
  /** Capture (redacted) request bodies. Default true. */
  captureRequestBodies?: boolean;
  /** Capture (redacted) response bodies. Default true. */
  captureResponseBodies?: boolean;
  /** Per-body capture cap (bounds request-path work). Default 65536 (64 KiB). */
  maxBodyBytes?: number;
  /** Hard memory bound; drop-oldest above it. Default 10000. */
  queueCapacity?: number;
  /** Maximum estimated bytes retained by queued redacted events. Default 67108864 (64 MiB). */
  maxQueueBytes?: number;
  /** Max events per POSTed batch. Default 200. */
  maxBatchEvents?: number;
  /** Soft pre-gzip batch size cap. Default 4194304 (4 MiB). */
  maxBatchBytes?: number;
  /** Max linger before flushing a partial batch (ms). Default 5000. */
  flushInterval?: number;
  /** Config poll period (ms); the kill switch lands within one. Default 15000. */
  configPollInterval?: number;
  /** Per-request timeout for ingest POSTs and config GETs (ms). Default 10000. */
  ingestTimeout?: number;
  /** Logging hook for swallowed faults. */
  onFault?: OnFault;
}

/** The Req-independent configuration the core needs (everything but partner resolution). */
export interface CoreOptions {
  ingestBaseUrl: string;
  ingestKey: string;
  redactionKey: Buffer;
  redactionKeyVersion: number;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  maxBodyBytes: number;
  queueCapacity: number;
  maxQueueBytes: number;
  maxBatchEvents: number;
  maxBatchBytes: number;
  flushInterval: number;
  configPollInterval: number;
  ingestTimeout: number;
  onFault: OnFault | undefined;
}

export interface ResolvedOptions<Req = unknown> extends CoreOptions {
  resolvePartnerId: (req: Req) => string | null | undefined;
}

export function resolveOptions<Req>(o: ToSpecConformanceOptions<Req>): ResolvedOptions<Req> {
  requireField(o.ingestBaseUrl, "ingestBaseUrl");
  try {
    // eslint-disable-next-line no-new
    new URL(o.ingestBaseUrl);
  } catch {
    throw new Error("ToSpec: ingestBaseUrl must be a valid absolute URL.");
  }
  requireField(o.ingestKey, "ingestKey");
  if (o.redactionKey == null || o.redactionKey.length === 0) {
    throw new Error("ToSpec: redactionKey is required and must be non-empty.");
  }
  if (typeof o.resolvePartnerId !== "function") {
    throw new Error("ToSpec: resolvePartnerId is required.");
  }
  const version = o.redactionKeyVersion ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("ToSpec: redactionKeyVersion must be an integer >= 1.");
  }

  return {
    ingestBaseUrl: o.ingestBaseUrl.replace(/\/+$/, ""),
    ingestKey: o.ingestKey,
    redactionKey: Buffer.isBuffer(o.redactionKey) ? o.redactionKey : Buffer.from(o.redactionKey),
    redactionKeyVersion: version,
    resolvePartnerId: o.resolvePartnerId,
    captureRequestBodies: o.captureRequestBodies ?? true,
    captureResponseBodies: o.captureResponseBodies ?? true,
    maxBodyBytes: positive(o.maxBodyBytes, 65536, "maxBodyBytes"),
    queueCapacity: positive(o.queueCapacity, 10000, "queueCapacity"),
    maxQueueBytes: positive(o.maxQueueBytes, 64 * 1024 * 1024, "maxQueueBytes"),
    maxBatchEvents: positive(o.maxBatchEvents, 200, "maxBatchEvents"),
    maxBatchBytes: positive(o.maxBatchBytes, 4194304, "maxBatchBytes"),
    flushInterval: positive(o.flushInterval, 5000, "flushInterval"),
    configPollInterval: positive(o.configPollInterval, 15000, "configPollInterval"),
    ingestTimeout: positive(o.ingestTimeout, 10000, "ingestTimeout"),
    onFault: o.onFault,
  };
}

function requireField(value: string | undefined, name: string): void {
  if (value == null || value.length === 0) {
    throw new Error(`ToSpec: ${name} is required.`);
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`ToSpec: ${name} must be > 0.`);
  }
  return value;
}
