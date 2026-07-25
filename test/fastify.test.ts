import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { useToSpecConformance } from "../src/fastify.js";
import type { ToSpecHandle } from "../src/express.js";
import { RecordingTransport, FakeConfig, testOptions, waitFor, scannableText, firstEvent } from "./support.js";

/**
 * The Fastify adapter shares the same core as Express. Same redaction-before-
 * transmission guarantee, exercised through Fastify's lifecycle hooks (uses
 * `app.inject`, no socket).
 */

const PAN = "4111111111111111";
const SECRET = "tsk-secret-sentinel-9d1f7c2ab4";

let app: FastifyInstance | null = null;
let handle: ToSpecHandle | null = null;

afterEach(async () => {
  if (handle) await handle.stop();
  if (app) await app.close();
  app = null;
  handle = null;
});

describe("fastify adapter", () => {
  it("redacts locally before transmission over the Fastify lifecycle", async () => {
    const config = new FakeConfig(
      [
        "body:",
        '  - { path: "$..password", action: drop }',
        "freetext:",
        "  scan_unknown: true",
        "  detectors: [pan_luhn, email]",
        "defaults:",
        "  unknown_pii_policy: detect_and_hash",
        "",
      ].join("\n"),
    );
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();

    app = Fastify();
    handle = useToSpecConformance(app, testOptions(), transport);
    app.post("/pay", async (req) => ({ echoedCard: (req.body as { card?: string }).card }));
    await app.ready();
    await waitFor(() => handle!.core.snapshot.ruleset !== null);

    const res = await app.inject({
      method: "POST",
      url: "/pay",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      payload: JSON.stringify({ card: PAN, password: "hunter2" }),
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => transport.posts.length > 0);
    const text = scannableText(transport.posts[0]!.body);
    expect(text).not.toContain(PAN);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Bearer ");
    expect(text).toContain("tsr_v1_");
  });

  it("caps a large string response at maxBodyBytes (does not transmit the full body)", async () => {
    // Empty ruleset → bodies pass through unredacted, so an uncapped capture would
    // put the entire response (with the sentinel) on the wire. Capping truncates it.
    const config = new FakeConfig("body: []\n");
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();

    const SENTINEL = "SENTINEL_PAST_THE_CAP";
    app = Fastify();
    handle = useToSpecConformance(app, testOptions({ maxBodyBytes: 30 }), transport);
    app.get("/big", async () => ({ filler: "x".repeat(200), marker: SENTINEL }));
    await app.ready();
    await waitFor(() => handle!.core.snapshot.ruleset !== null);

    const res = await app.inject({ method: "GET", url: "/big" });
    expect(res.statusCode).toBe(200);

    await waitFor(() => transport.posts.length > 0);
    const wire = scannableText(transport.posts[0]!.body);
    expect(wire).not.toContain(SENTINEL); // truncated at 30 bytes → not transmitted in full
    // Full length is still reported for resp_size even though the body was capped.
    expect(firstEvent(transport.posts[0]!.body)["resp_size"]).toBeGreaterThan(30);
  });

  it("captures a streaming response with the same bounded behavior as Express", async () => {
    const config = new FakeConfig("body: []\n");
    const transport = new RecordingTransport();
    transport.getResponder = config.responder();
    app = Fastify();
    handle = useToSpecConformance(app, testOptions(), transport);
    app.get("/stream", (_request, reply) => {
      reply.header("content-type", "application/json");
      return reply.send(Readable.from(['{"ok":', "true}"]));
    });
    await app.ready();
    await waitFor(() => handle!.core.snapshot.ruleset !== null);
    const res = await app.inject({ method: "GET", url: "/stream" });
    expect(res.body).toBe('{"ok":true}');
    await waitFor(() => transport.posts.length > 0);
    expect(scannableText(transport.posts[0]!.body)).toContain('{"ok":true}');
  });
});
