import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { useToSpecConformance, type ToSpecHandle } from "../src/express.js";
import { RecordingTransport, FakeConfig, testOptions, waitFor, scannableText, listen } from "./support.js";

/**
 * The redaction-before-transmission structural guarantee (S5.3 DoD): plant a
 * Luhn PAN in the request body, echo it in the response body, and send an
 * `Authorization: Bearer …` header. Then intercept the ACTUAL outbound wire
 * bytes and assert the PAN, the secret, and "Bearer " are absent while a token
 * and the redaction version are present. Port of `RedactionBeforeTransmissionTests.cs`.
 */

const PAN = "4111111111111111";
const SECRET = "tsk-secret-sentinel-9d1f7c2ab4";

let server: Server | null = null;
let handle: ToSpecHandle | null = null;

afterEach(async () => {
  if (handle) await handle.stop();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  handle = null;
});

async function start(config: FakeConfig): Promise<{ port: number; transport: RecordingTransport }> {
  const transport = new RecordingTransport();
  transport.getResponder = config.responder();

  const app = express();
  handle = useToSpecConformance(
    app,
    testOptions({ resolvePartnerId: () => "11111111-0000-0000-0000-000000000001" }),
    transport,
  );
  app.use(express.json());
  app.post("/pay", (req, res) => {
    // The provider's API echoes the card back in its response — a real leak risk.
    res.json({ ok: true, echoedCard: (req.body as { card?: string }).card });
  });

  const started = await listen(app);
  server = started.server;
  await waitFor(() => handle!.core.snapshot.ruleset !== null); // ruleset fetched
  return { port: started.port, transport };
}

describe("redaction before transmission", () => {
  it("PAN, auth secret, and Bearer are absent from the wire; token + version present", async () => {
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
    config.rulesetVersion = 3;
    const { port, transport } = await start(config);

    const res = await fetch(`http://127.0.0.1:${port}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ card: PAN, password: "hunter2" }),
    });
    expect(res.status).toBe(200);

    await waitFor(() => transport.posts.length > 0);
    const wire = transport.posts[0]!.body;
    const text = scannableText(wire);

    expect(text).not.toContain(PAN);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Bearer ");
    expect(text).toContain("tsr_v1_");
    expect(text).toContain('"redaction_version":3');
  });

  it("before a ruleset loads, bodies are dropped (never sent raw)", async () => {
    // A core with a config endpoint that never returns a ruleset.
    const transport = new RecordingTransport(); // default getResponder = 304, so ruleset stays null
    const app = express();
    handle = useToSpecConformance(app, testOptions(), transport);
    app.post("/pay", express.json(), (_req, res) => res.json({ card: PAN }));
    const started = await listen(app);
    server = started.server;
    const port = started.port;

    await fetch(`http://127.0.0.1:${port}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: PAN }),
    });

    await waitFor(() => transport.posts.length > 0);
    const text = scannableText(transport.posts[0]!.body);
    expect(text).not.toContain(PAN);
    expect(text).not.toContain('"req_body"');
    expect(text).not.toContain('"resp_body"');
  });
});
