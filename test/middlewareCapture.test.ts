import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { useToSpecConformance, type ToSpecHandle } from "../src/express.js";
import { RecordingTransport, FakeConfig, testOptions, waitFor, firstEvent, listen } from "./support.js";

/**
 * Request-path capture correctness (parity with sdk-dotnet's MiddlewareCaptureTests):
 * a thrown endpoint is recorded as a failure, and metadata-only mode still reports a
 * response size from Content-Length.
 */

let server: Server | null = null;
let handle: ToSpecHandle | null = null;

afterEach(async () => {
  if (handle) await handle.stop();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  handle = null;
});

async function start(
  config: FakeConfig,
  overrides: Parameters<typeof testOptions>[0],
  routes: (app: express.Express) => void,
): Promise<{ port: number; transport: RecordingTransport }> {
  const transport = new RecordingTransport();
  transport.getResponder = config.responder();
  const app = express();
  handle = useToSpecConformance(app, testOptions(overrides), transport);
  routes(app);
  const started = await listen(app);
  server = started.server;
  await waitFor(() => handle!.core.snapshot.ruleset !== null);
  return { port: started.port, transport };
}

describe("request-path capture", () => {
  it("a thrown endpoint is emitted as a 500 even under errors-only sampling", async () => {
    const config = new FakeConfig();
    config.sampling = { errors: 100, success: 0 }; // successes dropped; failures kept

    const { port, transport } = await start(config, {}, (app) => {
      app.get("/boom", () => {
        throw new Error("boom");
      });
    });

    const res = await fetch(`http://127.0.0.1:${port}/boom`);
    expect(res.status).toBe(500);

    // If the failure were misrecorded as a 200 it would be sampled out (success:0) and
    // never posted — so a post arriving at all, with status 500, proves both.
    await waitFor(() => transport.posts.length > 0);
    expect(firstEvent(transport.posts[0]!.body)["status"]).toBe(500);
  });

  it("reports resp_size from Content-Length when response-body capture is disabled", async () => {
    const config = new FakeConfig();
    const payload = '{"ok":true}'; // 11 bytes

    const { port, transport } = await start(config, { captureResponseBodies: false }, (app) => {
      app.get("/x", (_req, res) => {
        res.type("application/json").send(payload);
      });
    });

    const res = await fetch(`http://127.0.0.1:${port}/x`);
    expect(res.status).toBe(200);

    await waitFor(() => transport.posts.length > 0);
    const ev = firstEvent(transport.posts[0]!.body);
    expect(ev["resp_size"]).toBe(payload.length);
    expect(ev["resp_body"]).toBeUndefined(); // capture disabled → no body on the wire
  });
});
