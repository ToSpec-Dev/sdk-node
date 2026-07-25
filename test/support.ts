import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serializeCompiledRuleset, compileRuleset } from "@tospec/redact";
import type { Transport, TransportResponse } from "../src/core/transport.js";
import type { ToSpecConformanceOptions } from "../src/options.js";

/** Fixtures root: prefer the sibling sdk-protocol repo, else the vendored copy. */
const here = dirname(fileURLToPath(import.meta.url));
export function fixturesRoot(): string {
  const sibling = join(here, "..", "..", "sdk-protocol", "fixtures");
  if (existsSync(join(sibling, "manifest.json"))) return sibling;
  return join(here, "protocol-fixtures");
}
export function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot(), rel), "utf8"));
}

/** A recording transport that intercepts the exact outbound wire bytes. */
export class RecordingTransport implements Transport {
  readonly posts: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
  readonly gets: Array<{ url: string; headers: Record<string, string> }> = [];

  postResponder: (body: Buffer, signal: AbortSignal) => Promise<TransportResponse> = async () => ({
    status: 200,
    etag: null,
    text: async () => JSON.stringify({ batch_id: "x", ingested: 0, replayed: false }),
  });
  getResponder: (headers: Record<string, string>) => Promise<TransportResponse> = async () => ({
    status: 304,
    etag: null,
    text: async () => "",
  });

  async post(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    _timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TransportResponse> {
    this.posts.push({ url, headers, body });
    return this.postResponder(body, signal);
  }

  async get(
    url: string,
    headers: Record<string, string>,
    _timeoutMs: number,
    _signal: AbortSignal,
  ): Promise<TransportResponse> {
    this.gets.push({ url, headers });
    return this.getResponder(headers);
  }
}

/** A transport whose ingest POST hangs until the signal aborts (for latency isolation tests). */
export function hangingPost(): (body: Buffer, signal: AbortSignal) => Promise<TransportResponse> {
  return (_body: Buffer, signal: AbortSignal) =>
    new Promise<TransportResponse>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
}

/** A mutable fake config the poller serves; `bump()` changes the ETag to force a 200. */
export class FakeConfig {
  rulesetVersion = 1;
  compiled: unknown;
  sampling: Record<string, number> = { errors: 100, success: 100 };
  killSwitch = false;
  private version = 1;

  constructor(rulesetYaml = 'body:\n  - { path: "$.card", action: hash }\n') {
    const compiled = compileRuleset(rulesetYaml);
    if (!compiled.success) throw new Error(JSON.stringify(compiled.errors));
    this.compiled = JSON.parse(serializeCompiledRuleset(compiled.ruleset!));
  }

  /** Force the next poll to see a change (new ETag). */
  bump(): void {
    this.version++;
  }

  private etag(): string {
    return `"v${this.version}-k${this.killSwitch ? 1 : 0}"`;
  }

  responder(): (headers: Record<string, string>) => Promise<TransportResponse> {
    return async (headers) => {
      const etag = this.etag();
      if (headers["If-None-Match"] === etag) {
        return { status: 304, etag, text: async () => "" };
      }
      const body = JSON.stringify({
        ruleset_version: this.rulesetVersion,
        compiled: this.compiled,
        sampling_rules: this.sampling,
        kill_switch: this.killSwitch,
      });
      return { status: 200, etag, text: async () => body };
    };
  }
}

/** Baseline options for tests (fast intervals, zero redaction key). */
export function testOptions<Req>(
  overrides: Partial<ToSpecConformanceOptions<Req>> = {},
): ToSpecConformanceOptions<Req> {
  return {
    ingestBaseUrl: "https://ingest.test",
    ingestKey: "tsp_ing_test_key",
    redactionKey: Buffer.alloc(32),
    redactionKeyVersion: 1,
    resolvePartnerId: () => "11111111-0000-0000-0000-000000000001",
    configPollInterval: 50,
    flushInterval: 30,
    ...overrides,
  };
}

/**
 * Everything scannable in a posted wire batch: the gunzipped JSON PLUS every
 * base64-decoded req_body/resp_body — so a body-borne secret cannot hide behind
 * gzip or base64. Mirrors `WireInspector.ScannableText` in sdk-dotnet.
 */
export function scannableText(wire: Buffer): string {
  const json = gunzipSync(wire).toString("utf8");
  let text = json;
  const batch = JSON.parse(json) as { events?: Array<Record<string, string>> };
  for (const e of batch.events ?? []) {
    for (const field of ["req_body", "resp_body"]) {
      const b64 = e[field];
      if (b64) text += "\n" + Buffer.from(b64, "base64").toString("utf8");
    }
  }
  return text;
}

/**
 * Start an app listening on an ephemeral port, race-free: the server is bound to a
 * const before the 'listening' callback fires, and we resolve with the instance and
 * its port (no reliance on an outer variable being assigned first).
 */
export function listen(app: {
  listen(port: number, cb: () => void): Server;
}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
    server.on("error", reject);
  });
}

/** Gunzip a posted wire batch and return its first event object. */
export function firstEvent(wire: Buffer): Record<string, unknown> {
  const batch = JSON.parse(gunzipSync(wire).toString("utf8")) as {
    events: Array<Record<string, unknown>>;
  };
  return batch.events[0]!;
}

/** Poll a predicate until true or timeout. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
