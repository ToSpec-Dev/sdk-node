import type { RawHeaders } from "./headerRedactor.js";

/**
 * A captured request/response exchange, produced on the request path with only
 * bounded in-memory copies — no redaction, no I/O yet. Handed to the
 * `exchangeRedactor`, which redacts it before it is enqueued. Port of
 * `ExchangeRedactor.cs`'s `CapturedExchange`.
 */
export interface CapturedExchange {
  partnerId: string;
  ts: string; // ISO-8601 with offset
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  reqHeaders: RawHeaders;
  respHeaders: RawHeaders;
  reqBody: Buffer | null;
  respBody: Buffer | null;
  reqContentType: string | undefined;
  respContentType: string | undefined;
  reqSize: number;
  respSize: number;
}
