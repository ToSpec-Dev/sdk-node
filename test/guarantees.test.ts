import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { useToSpecConformance, type ToSpecHandle } from "../src/express.js";
import { ConformanceChannel } from "../src/core/conformanceChannel.js";
import { ConformanceMetrics } from "../src/core/metrics.js";
import type { IngestEventEnvelope } from "../src/index.js";
import { RecordingTransport, FakeConfig, testOptions, waitFor, hangingPost, listen } from "./support.js";

let server: Server | null = null;
let handle: ToSpecHandle | null = null;

afterEach(async () => {
  if (handle) await handle.stop();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  handle = null;
});

function dummyEvent(): IngestEventEnvelope {
  return {
    eventId: "e",
    partnerId: "p",
    ts: "2026-01-01T00:00:00+00:00",
    direction: "inbound",
    method: "GET",
    path: "/",
    status: 200,
    latencyMs: 1,
    reqHeaders: {},
    respHeaders: {},
    reqBody: null,
    respBody: null,
    reqSize: 0,
    respSize: 0,
    contentFormat: "json",
    redactionVersion: 1,
  };
}

describe("bounded memory (channel primitive)", () => {
  it("drop-oldest keeps exactly capacity and counts the drops", () => {
    const metrics = new ConformanceMetrics();
    const channel = new ConformanceChannel(100, 64 * 1024 * 1024, metrics);
    for (let i = 0; i < 1000; i++) channel.tryWrite(dummyEvent()); // always succeeds
    expect(metrics.snapshot().eventsDroppedQueueFull).toBe(900);
    let drained = 0;
    while (channel.tryRead() !== undefined) drained++;
    expect(drained).toBe(100);
  });

  it("preserves FIFO order without linear Array.shift work", () => {
    const metrics = new ConformanceMetrics();
    const channel = new ConformanceChannel(3, 64 * 1024 * 1024, metrics);
    for (const id of ["1", "2", "3", "4"]) channel.tryWrite({ ...dummyEvent(), eventId: id });
    expect([channel.tryRead()!.eventId, channel.tryRead()!.eventId, channel.tryRead()!.eventId]).toEqual(["2", "3", "4"]);
  });

  it("also evicts by estimated bytes before the count limit", () => {
    const metrics = new ConformanceMetrics();
    const channel = new ConformanceChannel(100, 900, metrics);
    channel.tryWrite({ ...dummyEvent(), eventId: "1", reqBody: "x".repeat(400) });
    channel.tryWrite({ ...dummyEvent(), eventId: "2", reqBody: "x".repeat(400) });
    expect(channel.size).toBe(1);
    expect(channel.tryRead()!.eventId).toBe("2");
    expect(metrics.snapshot().eventsDroppedQueueFull).toBe(1);
  });
});

describe("never blocks the event loop (hung ingest)", () => {
  it("host request latency is unaffected while ingest hangs, and a POST was attempted", async () => {
    const config = new FakeConfig();
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();
    transport.postResponder = hangingPost(); // ingest never responds

    const app = express();
    handle = useToSpecConformance(app, testOptions({ queueCapacity: 20000 }), transport);
    app.get("/x", (_req, res) => res.json({ ok: true }));
    const started = await listen(app);
    server = started.server;
    const url = `http://127.0.0.1:${started.port}/x`;
    await waitFor(() => handle!.core.snapshot.ruleset !== null);

    for (let i = 0; i < 10; i++) await fetch(url); // warm up

    const timings: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = process.hrtime.bigint();
      await fetch(url);
      timings.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    timings.sort((a, b) => a - b);
    const p99 = timings[Math.floor(timings.length * 0.99)]!;

    expect(p99).toBeLessThan(200); // « the (never-resolving) ingest timeout
    await waitFor(() => transport.posts.length > 0); // the sender really tried
  });
});

describe("bounded memory under flood (end to end)", () => {
  it("all requests succeed and events are dropped, not accumulated, when the sender stalls", async () => {
    const config = new FakeConfig();
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();
    transport.postResponder = hangingPost();

    const app = express();
    handle = useToSpecConformance(app, testOptions({ queueCapacity: 50 }), transport);
    app.get("/x", (_req, res) => res.json({ ok: true }));
    const started = await listen(app);
    server = started.server;
    await waitFor(() => handle!.core.snapshot.ruleset !== null);

    for (let i = 0; i < 500; i++) {
      const res = await fetch(`http://127.0.0.1:${started.port}/x`);
      expect(res.status).toBe(200);
    }

    await waitFor(() => handle!.metrics().eventsCaptured >= 500);
    const m = handle!.metrics();
    expect(m.eventsDroppedQueueFull).toBeGreaterThan(0); // bounded — old events evicted
  });
});

describe("kill switch within one poll", () => {
  it("stops all emission after the flag flips", async () => {
    const config = new FakeConfig();
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();

    const app = express();
    handle = useToSpecConformance(app, testOptions(), transport);
    app.get("/x", (_req, res) => res.json({ ok: true }));
    const started = await listen(app);
    server = started.server;
    const url = `http://127.0.0.1:${started.port}/x`;
    await waitFor(() => handle!.core.snapshot.ruleset !== null);

    await fetch(url);
    await waitFor(() => transport.posts.length > 0); // emission confirmed working

    // Flip the kill switch; within one poll interval the snapshot reflects it.
    config.killSwitch = true;
    config.bump();
    await waitFor(() => handle!.core.snapshot.killSwitch === true);

    const postsBefore = transport.posts.length;
    const capturedBefore = handle!.metrics().eventsCaptured;
    for (let i = 0; i < 10; i++) await fetch(url);
    await new Promise((r) => setTimeout(r, 100)); // > a flush interval

    expect(handle!.metrics().eventsCaptured).toBe(capturedBefore); // no new captures
    expect(transport.posts.length).toBe(postsBefore); // no new posts
    expect(handle!.metrics().killSwitchActive).toBe(true);
  });

  it("drops a queued pre-switch event before it can be sent", async () => {
    const config = new FakeConfig();
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();
    const app = express();
    handle = useToSpecConformance(app, testOptions({ flushInterval: 500 }), transport);
    app.get("/x", (_req, res) => res.json({ ok: true }));
    const started = await listen(app);
    server = started.server;
    await waitFor(() => handle!.core.snapshot.ruleset !== null);
    await fetch(`http://127.0.0.1:${started.port}/x`);
    config.killSwitch = true;
    config.bump();
    await waitFor(() => handle!.core.snapshot.killSwitch);
    await new Promise((r) => setTimeout(r, 550));
    expect(transport.posts).toHaveLength(0);
  });
});

describe("sender reliability", () => {
  it("retries 409 with identical batch bytes", async () => {
    const config = new FakeConfig();
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();
    let attempts = 0;
    transport.postResponder = async () => ({
      status: ++attempts < 3 ? 409 : 200,
      etag: null,
      text: async () => "",
    });
    const app = express();
    handle = useToSpecConformance(app, testOptions(), transport);
    app.get("/retry", (_req, res) => res.json({ ok: true }));
    const started = await listen(app);
    server = started.server;
    await waitFor(() => handle!.core.snapshot.ruleset !== null);
    await fetch(`http://127.0.0.1:${started.port}/retry`);
    await waitFor(() => transport.posts.length === 3);
    expect(transport.posts[1]!.body).toEqual(transport.posts[0]!.body);
    expect(transport.posts[2]!.body).toEqual(transport.posts[0]!.body);
  });

  it("flushes an accumulated batch during stop", async () => {
    const config = new FakeConfig();
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();
    const app = express();
    handle = useToSpecConformance(app, testOptions({ flushInterval: 30_000 }), transport);
    app.get("/shutdown", (_req, res) => res.json({ ok: true }));
    const started = await listen(app);
    server = started.server;
    await waitFor(() => handle!.core.snapshot.ruleset !== null);
    await fetch(`http://127.0.0.1:${started.port}/shutdown`);
    await handle.stop();
    handle = null;
    expect(transport.posts).toHaveLength(1);
  });

  it("rejects an invalid partner id before enqueue", async () => {
    const config = new FakeConfig();
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();
    const faults: string[] = [];
    const app = express();
    handle = useToSpecConformance(app, testOptions({
      resolvePartnerId: () => "not-a-uuid",
      onFault: (fault) => faults.push(fault.message),
    }), transport);
    app.get("/invalid", (_req, res) => res.json({ ok: true }));
    const started = await listen(app);
    server = started.server;
    await waitFor(() => handle!.core.snapshot.ruleset !== null);
    await fetch(`http://127.0.0.1:${started.port}/invalid`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transport.posts).toHaveLength(0);
    expect(faults).toContain("resolvePartnerId returned an invalid UUID");
  });
});
