import { Worker } from "node:worker_threads";

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const { createHmac } = require("node:crypto");
const { gzipSync } = require("node:zlib");
parentPort.once("message", ({ batch, key }) => {
  try {
    const json = Buffer.from(JSON.stringify(batch), "utf8");
    const wire = gzipSync(json);
    const signature = "sha256=" + createHmac("sha256", key).update(wire).digest("hex");
    parentPort.postMessage({ wire, signature });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
`;

export interface EncodedBatch {
  wire: Buffer;
  signature: string;
}

/** Serialize, gzip, and sign away from Node's application event loop. */
export function encodeBatchInWorker(
  batch: Record<string, unknown>, ingestKeyUtf8: Buffer, signal: AbortSignal,
): Promise<EncodedBatch> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<EncodedBatch>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      action();
    };
    const abort = (): void => finish(() => reject(new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", abort, { once: true });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0 && !settled) finish(() => reject(new Error(`batch encoder worker exited ${code}`)));
    });
    worker.once("message", (message: { wire?: Uint8Array; signature?: string; error?: string }) => {
      if (message.error || !message.wire || !message.signature) {
        finish(() => reject(new Error(message.error ?? "batch encoder returned an invalid result")));
      } else {
        finish(() => resolve({ wire: Buffer.from(message.wire!), signature: message.signature! }));
      }
    });
    worker.postMessage({ batch, key: ingestKeyUtf8 });
  });
}
