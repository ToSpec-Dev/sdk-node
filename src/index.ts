/**
 * `@tospec/node` — the ToSpec production conformance SDK for Node. Express and
 * Fastify middleware that redacts request/response traffic locally (via
 * `@tospec/redact`) and ships gzip-signed batches to the ToSpec ingest edge on a
 * background worker. The hard guarantees are the product: never wait for ToSpec I/O on the request
 * loop, bounded memory, swallow every fault. Node port of `ToSpec-Dev/sdk-dotnet`.
 *
 * Framework adapters are exported from subpaths to keep `express`/`fastify`
 * optional:
 *   import { useToSpecConformance } from "@tospec/node/express";
 *   import { useToSpecConformance } from "@tospec/node/fastify";
 */

export { ConformanceCore } from "./core/conformanceCore.js";
export {
  type ToSpecConformanceOptions,
  type ResolvedOptions,
  resolveOptions,
} from "./options.js";
export { ConformanceFaultKind, type ConformanceFault, type OnFault } from "./core/fault.js";
export { type ConformanceMetricsSnapshot } from "./core/metrics.js";
export { type ConformanceSnapshot } from "./core/state.js";
export { type CapturedExchange } from "./core/captured.js";
export {
  type Transport,
  type TransportResponse,
  FetchTransport,
} from "./core/transport.js";
export type { ToSpecHandle } from "./express.js";

// Wire-layer helpers, exported for conformance testing against sdk-protocol.
export {
  serializeBatch,
  type IngestBatch,
  type IngestEventEnvelope,
} from "./core/wire.js";
export { signBatch } from "./core/ingestSigner.js";
export { redactHeaders } from "./core/headerRedactor.js";
