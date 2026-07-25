import {
  resolveBodyRedactor,
  RedactionStatus,
  type RedactionKeyring,
} from "@tospec/redact";
import { redactHeaders } from "./headerRedactor.js";
import { detectContentFormat, type ContentFormat } from "./contentFormat.js";
import { uuidv7 } from "./uuidv7.js";
import type { CapturedExchange } from "./captured.js";
import type { ConformanceSnapshot } from "./state.js";
import type { ConformanceMetrics } from "./metrics.js";
import type { IngestEventEnvelope } from "./wire.js";

/**
 * Redaction-before-transmission (ToSpec-Dev/sdk-protocol §"The one hard rule"). Runs
 * synchronously on the request path, producing the wire envelope that is then
 * enqueued — raw bytes never enter the queue. Every failure mode drops the body
 * rather than transmit it raw: no ruleset yet, unstructured format, or malformed
 * body. Port of `ExchangeRedactor.cs`.
 */
export function redactExchange(
  captured: CapturedExchange,
  snapshot: ConformanceSnapshot,
  keys: RedactionKeyring,
  metrics: ConformanceMetrics,
): IngestEventEnvelope {
  const ruleset = snapshot.ruleset;

  const reqHeaders = redactHeaders(captured.reqHeaders, true, ruleset, keys);
  const respHeaders = redactHeaders(captured.respHeaders, false, ruleset, keys);

  const reqFormat = detectContentFormat(captured.reqContentType);
  const respFormat = detectContentFormat(captured.respContentType);

  const reqBody = redactBody(captured.reqBody, reqFormat, snapshot, keys, metrics);
  const respBody = redactBody(captured.respBody, respFormat, snapshot, keys, metrics);

  // Protocol v1 retains one legacy format. Mixed structured formats cannot be
  // represented safely, so keep the request body and drop the response rather
  // than label either body incorrectly.
  const mixedFormats = reqBody !== null && respBody !== null && reqFormat !== respFormat;
  const safeRespBody = mixedFormats ? null : respBody;
  const contentFormat: ContentFormat = reqBody !== null ? reqFormat : safeRespBody !== null ? respFormat : "json";

  return {
    eventId: uuidv7(),
    partnerId: captured.partnerId,
    ts: captured.ts,
    direction: "inbound",
    method: captured.method,
    path: captured.path,
    status: captured.status,
    latencyMs: Math.round(captured.latencyMs),
    reqHeaders,
    respHeaders,
    reqBody,
    respBody: safeRespBody,
    reqSize: captured.reqSize,
    respSize: captured.respSize,
    contentFormat,
    redactionVersion: snapshot.rulesetVersion,
  };
}

function redactBody(
  body: Buffer | null,
  format: ContentFormat,
  snapshot: ConformanceSnapshot,
  keys: RedactionKeyring,
  metrics: ConformanceMetrics,
): string | null {
  if (body === null || body.length === 0) {
    return null;
  }
  // Never transmit a body before a ruleset has been fetched.
  if (snapshot.ruleset === null) {
    return null;
  }
  const redactor = resolveBodyRedactor(format);
  if (redactor === null) {
    return null; // text/binary: no structured redactor → drop
  }
  const result = redactor.redact(body, snapshot.ruleset, keys);
  if (result.status !== RedactionStatus.Rewritten || result.output === null) {
    metrics.incRedactionFailure();
    return null; // malformed → drop
  }
  return result.output.toString("base64");
}
