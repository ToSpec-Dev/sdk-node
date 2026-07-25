import { describe, it, expect } from "vitest";
import {
  RedactionKeyring,
  tokenize,
  deserializeCompiledRuleset,
  resolveBodyRedactor,
  RedactionStatus,
  compileRuleset,
} from "@tospec/redact";
import { serializeBatch, signBatch, redactHeaders, type IngestEventEnvelope } from "../src/index.js";
import { redactExchange } from "../src/core/exchangeRedactor.js";
import { ConformanceMetrics } from "../src/core/metrics.js";
import { loadFixture } from "./support.js";

/**
 * Conformance against the shared `ToSpec-Dev/sdk-protocol` goldens — the four checks
 * from the README's certification checklist. Passing these proves `@tospec/node`
 * speaks the wire protocol identically to `sdk-dotnet`. Port of
 * `ProtocolFixturesTests.cs`.
 */

const manifest = loadFixture("manifest.json") as {
  redaction: string[]; batches: string[]; malformed: string; edge_cases: string;
};

describe("token vectors", () => {
  const tokens = loadFixture("tokens.json") as Array<{
    name: string;
    key_hex: string;
    key_version: number;
    value: string;
    token: string;
  }>;
  for (const v of tokens) {
    it(`reproduces ${v.name}`, () => {
      const keys = new RedactionKeyring(Buffer.from(v.key_hex, "hex"), v.key_version);
      expect(tokenize(Buffer.from(v.value, "utf8"), keys)).toBe(v.token);
    });
  }
});

describe("binary malformed vectors", () => {
  const fixture = loadFixture(manifest.malformed) as {
    vectors: Array<{ name: string; content_format: string; body_base64: string }>;
  };
  const compiled = compileRuleset("body: []\n");
  if (!compiled.success) throw new Error("empty ruleset failed to compile");
  const keys = new RedactionKeyring(Buffer.alloc(32), 1);
  for (const v of fixture.vectors) {
    it(`rejects ${v.name}`, () => {
      const result = resolveBodyRedactor(v.content_format)!.redact(
        Buffer.from(v.body_base64, "base64"), compiled.ruleset!, keys);
      expect(result.status).toBe(RedactionStatus.MalformedInput);
      expect(result.output).toBeNull();
    });
  }
});

describe("redaction vectors", () => {
  for (const rel of manifest.redaction) {
    const v = loadFixture(rel) as any;
    it(`reproduces ${v.name}`, () => {
      const ruleset = deserializeCompiledRuleset(JSON.stringify(v.compiled_ruleset));
      const keys = new RedactionKeyring(Buffer.from(v.hmac_key_hex, "hex"), v.hmac_key_version);

      if (v.kind === "headers") {
        const out = redactHeaders(v.headers_in, v.is_request === true, ruleset, keys);
        expect(out).toEqual(v.headers_out);
        return;
      }

      const redactor = resolveBodyRedactor(v.content_format)!;
      const result = redactor.redact(Buffer.from(v.body_in, "utf8"), ruleset, keys);
      if (v.malformed) {
        expect(result.status).toBe(RedactionStatus.MalformedInput);
      } else {
        expect(result.output!.toString("utf8")).toBe(v.body_out);
      }
    });
  }
});

/** Maps a canonical-JSON event object back to an IngestEventEnvelope. */
function toEnvelope(e: Record<string, unknown>): IngestEventEnvelope {
  return {
    eventId: e["event_id"] as string,
    partnerId: e["partner_id"] as string,
    ts: e["ts"] as string,
    direction: e["direction"] as "inbound" | "outbound",
    method: e["method"] as string,
    path: e["path"] as string,
    status: (e["status"] as number) ?? null,
    latencyMs: (e["latency_ms"] as number) ?? null,
    reqHeaders: (e["req_headers"] as Record<string, string>) ?? null,
    respHeaders: (e["resp_headers"] as Record<string, string>) ?? null,
    reqBody: (e["req_body"] as string) ?? null,
    respBody: (e["resp_body"] as string) ?? null,
    reqSize: (e["req_size"] as number) ?? null,
    respSize: (e["resp_size"] as number) ?? null,
    contentFormat: e["content_format"] as string,
    redactionVersion: e["redaction_version"] as number,
  };
}

describe("batch fixtures", () => {
  for (const rel of manifest.batches) {
    const v = loadFixture(rel) as { name: string; ingest_key: string; canonical_json: string; signature: string };

    it(`signs ${v.name} to the golden signature`, () => {
      const sig = signBatch(Buffer.from(v.ingest_key, "utf8"), Buffer.from(v.canonical_json, "utf8"));
      expect(sig).toBe(v.signature);
    });

    it(`serializes ${v.name} byte-for-byte to canonical_json`, () => {
      const parsed = JSON.parse(v.canonical_json) as { batch_id: string; events: Record<string, unknown>[] };
      const rebuilt = serializeBatch({
        batchId: parsed.batch_id,
        events: parsed.events.map(toEnvelope),
      });
      expect(rebuilt).toBe(v.canonical_json);
    });
  }
});

describe("protocol v1 mixed-format policy", () => {
  it("retains the request and drops the response as declared by the edge-case fixture", () => {
    const edge = loadFixture(manifest.edge_cases) as {
      mixed_formats: { request: string; response: string; policy: string };
    };
    expect(edge.mixed_formats.policy).toBe("retain_request_drop_response");
    const compiled = compileRuleset('body:\n  - { path: "$.secret", action: drop }\n');
    if (!compiled.success) throw new Error("ruleset failed");
    const result = redactExchange({
      partnerId: "11111111-0000-0000-0000-000000000001", ts: "2026-01-01T00:00:00+00:00",
      method: "POST", path: "/mixed", status: 200, latencyMs: 1,
      reqHeaders: {}, respHeaders: {}, reqBody: Buffer.from('{"ok":true}'),
      respBody: Buffer.from("<ok>true</ok>"), reqContentType: "application/json",
      respContentType: "application/xml", reqSize: 11, respSize: 13,
    }, {
      ruleset: compiled.ruleset!, rulesetVersion: 1,
      sampling: { errors: 100, success: 100 }, killSwitch: false, etag: null,
    }, new RedactionKeyring(Buffer.alloc(32), 1), new ConformanceMetrics());
    expect(result.reqBody).not.toBeNull();
    expect(result.respBody).toBeNull();
    expect(result.contentFormat).toBe(edge.mixed_formats.request);
  });
});
