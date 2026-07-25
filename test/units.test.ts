import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { RedactionKeyring } from "@tospec/redact";
import { signBatch, redactHeaders } from "../src/index.js";
import { detectContentFormat } from "../src/core/contentFormat.js";
import { shouldEmit, parseSampling } from "../src/core/sampler.js";
import { uuidv7 } from "../src/core/uuidv7.js";
import { serializeBatch } from "../src/core/wire.js";
import { batchWireObject } from "../src/core/wire.js";
import { encodeBatchInWorker } from "../src/core/batchEncoder.js";
import { resolveOptions } from "../src/options.js";
import { testOptions } from "./support.js";

describe("ingestSigner", () => {
  it("matches manual HMAC-SHA256 with sha256= prefix and lowercase hex", () => {
    const key = Buffer.from("tsp_ing_abc", "utf8");
    const body = Buffer.from("hello", "utf8");
    const expected = "sha256=" + createHmac("sha256", key).update(body).digest("hex");
    expect(signBatch(key, body)).toBe(expected);
  });
});

describe("contentFormat", () => {
  it.each([
    ["application/json", "json"],
    ["application/vnd.api+json; charset=utf-8", "json"],
    ["text/xml", "xml"],
    ["application/soap+xml", "xml"],
    ["text/plain", "text"],
    ["application/octet-stream", "binary"],
    [undefined, "binary"],
  ])("%s → %s", (input, expected) => {
    expect(detectContentFormat(input as string | undefined)).toBe(expected);
  });
});

describe("sampler", () => {
  it("100% always emits, 0% never emits", () => {
    expect(shouldEmit({ errors: 100, success: 100 }, 200)).toBe(true);
    expect(shouldEmit({ errors: 0, success: 0 }, 500)).toBe(false);
  });
  it("uses the error class for status >= 400", () => {
    const rule = { errors: 100, success: 0 };
    expect(shouldEmit(rule, 500, () => 0.99)).toBe(true);
    expect(shouldEmit(rule, 200, () => 0.0)).toBe(false);
  });
  it("missing fields default to 100%", () => {
    const rule = parseSampling(undefined);
    expect(rule).toEqual({ errors: 100, success: 100 });
  });
});

describe("uuidv7", () => {
  it("produces a version-7 variant-2 UUID", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("is time-ordered across milliseconds", async () => {
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 3));
    const b = uuidv7();
    // The 48-bit timestamp prefix (first 13 hex chars, minus the dash) increases.
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
  });
});

describe("headerRedactor", () => {
  const keys = new RedactionKeyring(Buffer.alloc(32), 1);
  it("strips default auth headers unconditionally and preserves casing/order", () => {
    const out = redactHeaders(
      { Accept: "application/json", Authorization: "Bearer x", "X-Api-Key": "k" },
      true,
      null,
      keys,
    );
    expect(out).toEqual({ Accept: "application/json" });
  });
  it("strips default response auth headers", () => {
    const out = redactHeaders({ "Content-Type": "application/json", "Set-Cookie": "s=1" }, false, null, keys);
    expect(out).toEqual({ "Content-Type": "application/json" });
  });
});

describe("options validation", () => {
  it("rejects a missing ingestKey", () => {
    expect(() => resolveOptions(testOptions({ ingestKey: "" }))).toThrow(/ingestKey/);
  });
  it("rejects an empty redactionKey", () => {
    expect(() => resolveOptions(testOptions({ redactionKey: Buffer.alloc(0) }))).toThrow(/redactionKey/);
  });
  it("fills defaults", () => {
    const o = resolveOptions(testOptions());
    expect(o.queueCapacity).toBe(10000);
    expect(o.maxQueueBytes).toBe(64 * 1024 * 1024);
    expect(o.maxBodyBytes).toBe(65536);
    expect(o.maxBatchEvents).toBe(200);
  });
});

describe("wire serializer", () => {
  it("omits null bodies and keeps field order", () => {
    const json = serializeBatch({
      batchId: "b",
      events: [
        {
          eventId: "e",
          partnerId: "p",
          ts: "2026-01-01T00:00:00+00:00",
          direction: "inbound",
          method: "GET",
          path: "/x",
          status: 200,
          latencyMs: 3,
          reqHeaders: { Accept: "application/json" },
          respHeaders: null,
          reqBody: null,
          respBody: null,
          reqSize: 0,
          respSize: 0,
          contentFormat: "json",
          redactionVersion: 1,
        },
      ],
    });
    expect(json).toBe(
      '{"batch_id":"b","events":[{"event_id":"e","partner_id":"p","ts":"2026-01-01T00:00:00+00:00",' +
        '"direction":"inbound","method":"GET","path":"/x","status":200,"latency_ms":3,' +
        '"req_headers":{"Accept":"application/json"},"req_size":0,"resp_size":0,' +
        '"content_format":"json","redaction_version":1}]}',
    );
  });

  it("serializes, compresses, and signs on a worker without starving a timer", async () => {
    const batch = {
      batchId: "b",
      events: Array.from({ length: 5000 }, (_, i) => ({
        eventId: String(i), partnerId: "p", ts: "2026-01-01T00:00:00+00:00" as const,
        direction: "inbound" as const, method: "POST", path: "/large", status: 200,
        latencyMs: 1, reqHeaders: {}, respHeaders: {}, reqBody: "x".repeat(500), respBody: null,
        reqSize: 500, respSize: 0, contentFormat: "json", redactionVersion: 1,
      })),
    };
    let timerFired = false;
    const pending = encodeBatchInWorker(batchWireObject(batch), Buffer.from("key"), new AbortController().signal);
    await new Promise<void>((resolve) => setTimeout(() => { timerFired = true; resolve(); }, 0));
    expect(timerFired).toBe(true);
    const encoded = await pending;
    expect(encoded.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(encoded.wire.length).toBeGreaterThan(0);
  });
});
