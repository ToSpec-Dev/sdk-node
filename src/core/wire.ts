/**
 * The ingest batch envelope (ToSpec-Dev/sdk-protocol §4). snake_case keys, **omit
 * null**, and a **fixed field order** so the serialized bytes reproduce the
 * `canonical_json` goldens (and therefore the signature). `tenant_id`/`api_id`
 * are never sent — the server derives them from the ingest key. Port of
 * `Wire/IngestEnvelope.cs` + `Wire/SdkJsonContext.cs`.
 */

export interface IngestEventEnvelope {
  eventId: string;
  partnerId: string;
  ts: string; // ISO-8601 with offset, e.g. 2026-01-01T00:00:00+00:00
  direction: "inbound" | "outbound";
  method: string;
  path: string;
  status: number | null;
  latencyMs: number | null;
  reqHeaders: Record<string, string> | null;
  respHeaders: Record<string, string> | null;
  reqBody: string | null; // base64 of already-redacted bytes; omitted when null
  respBody: string | null;
  reqSize: number | null;
  respSize: number | null;
  contentFormat: string;
  redactionVersion: number;
}

export interface IngestBatch {
  batchId: string;
  events: IngestEventEnvelope[];
}

/** Builds the ordered, omit-null wire object for one event. */
function eventObject(e: IngestEventEnvelope): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  o["event_id"] = e.eventId;
  o["partner_id"] = e.partnerId;
  o["ts"] = e.ts;
  o["direction"] = e.direction;
  o["method"] = e.method;
  o["path"] = e.path;
  if (e.status != null) o["status"] = e.status;
  if (e.latencyMs != null) o["latency_ms"] = e.latencyMs;
  if (e.reqHeaders != null) o["req_headers"] = e.reqHeaders;
  if (e.respHeaders != null) o["resp_headers"] = e.respHeaders;
  if (e.reqBody != null) o["req_body"] = e.reqBody;
  if (e.respBody != null) o["resp_body"] = e.respBody;
  if (e.reqSize != null) o["req_size"] = e.reqSize;
  if (e.respSize != null) o["resp_size"] = e.respSize;
  o["content_format"] = e.contentFormat;
  o["redaction_version"] = e.redactionVersion;
  return o;
}

/** Builds the ordered structured-cloneable object whose JSON bytes are signed. */
export function batchWireObject(batch: IngestBatch): Record<string, unknown> {
  return {
    batch_id: batch.batchId,
    events: batch.events.map(eventObject),
  };
}

/** Serializes a batch to the canonical wire JSON (no insignificant whitespace). */
export function serializeBatch(batch: IngestBatch): string {
  return JSON.stringify(batchWireObject(batch));
}

/** Rough pre-gzip size estimate for batching caps (mirrors the .NET estimate). */
export function estimateEventBytes(e: IngestEventEnvelope): number {
  return 256 + (e.reqBody?.length ?? 0) + (e.respBody?.length ?? 0);
}
