import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { ConformanceCore } from "./core/conformanceCore.js";
import { resolveOptions, type ToSpecConformanceOptions } from "./options.js";
import type { Transport } from "./core/transport.js";
import type { RawHeaders } from "./core/headerRedactor.js";
import { toIsoOffset, headerValue, contentLength, pathOf } from "./core/http.js";

/**
 * The handle returned by `useToSpecConformance` — exposes the running core for
 * metrics and lifecycle control (call `stop()` on graceful shutdown).
 */
export interface ToSpecHandle {
  readonly core: ConformanceCore;
  stop(): Promise<void>;
  metrics(): ReturnType<ConformanceCore["metricsSnapshot"]>;
}

/**
 * Express adapter. Mounts capture middleware and starts the background poller +
 * sender. Redaction happens before transmission; the request path only does
 * bounded in-memory copies and a non-blocking enqueue — it never awaits I/O.
 *
 * Mount this **before** your body parser so the request body can be observed
 * transparently (the SDK taps the stream via an emit shim and never consumes it).
 */
export function useToSpecConformance(
  app: { use(handler: RequestHandler): unknown },
  options: ToSpecConformanceOptions<Request>,
  transport?: Transport,
): ToSpecHandle {
  const resolved = resolveOptions<Request>(options);
  const core = new ConformanceCore(resolved, transport);
  core.start();
  app.use(middleware(core, resolved));
  return {
    core,
    stop: () => core.stop(),
    metrics: () => core.metricsSnapshot(),
  };
}

function middleware(
  core: ConformanceCore,
  o: ReturnType<typeof resolveOptions<Request>>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const snapshot = core.snapshot;
    if (snapshot.killSwitch) {
      next(); // cheapest branch: no capture work at all
      return;
    }

    let partnerId: string | null | undefined;
    try {
      partnerId = o.resolvePartnerId(req);
    } catch (e) {
      core.reportCaptureFault("resolvePartnerId threw", e);
      next();
      return;
    }
    if (partnerId == null) {
      next();
      return;
    }

    const startTs = new Date();
    const startTime = process.hrtime.bigint();

    // --- request body: passive stream tap via an emit shim (never consumes) ---
    const reqChunks: Buffer[] = [];
    let reqCap = 0;
    let reqSeen = 0;
    if (o.captureRequestBodies) {
      const origEmit = req.emit.bind(req);
      (req as unknown as { emit: typeof req.emit }).emit = ((event: string, ...args: unknown[]) => {
        if (event === "data") {
          const c = args[0];
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c as string);
          reqSeen += buf.length;
          if (reqCap < o.maxBodyBytes) {
            const take = buf.subarray(0, o.maxBodyBytes - reqCap);
            reqChunks.push(take);
            reqCap += take.length;
          }
        }
        return origEmit(event as never, ...(args as never[]));
      }) as typeof req.emit;
    }

    // --- response body: tee res.write / res.end ---
    const resChunks: Buffer[] = [];
    let resCap = 0;
    let resSeen = 0;
    if (o.captureResponseBodies) {
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      const tee = (chunk: unknown, encoding?: unknown): void => {
        if (chunk == null || typeof chunk === "function") return;
        const enc = typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8";
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, enc);
        resSeen += buf.length;
        if (resCap < o.maxBodyBytes) {
          const take = buf.subarray(0, o.maxBodyBytes - resCap);
          resChunks.push(take);
          resCap += take.length;
        }
      };
      res.write = function patchedWrite(chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
        tee(chunk, encoding);
        return (origWrite as (...a: unknown[]) => boolean)(chunk, encoding, cb);
      } as typeof res.write;
      res.end = function patchedEnd(chunk?: unknown, encoding?: unknown, cb?: unknown): Response {
        tee(chunk, encoding);
        return (origEnd as (...a: unknown[]) => Response)(chunk, encoding, cb);
      } as typeof res.end;
    }

    res.on("finish", () => {
      try {
        const latencyMs = Number(process.hrtime.bigint() - startTime) / 1e6;
        const reqHeaders = req.headers as RawHeaders;
        core.captureExchange({
          partnerId: partnerId!,
          ts: toIsoOffset(startTs),
          method: req.method ?? "GET",
          path: pathOf(req.originalUrl ?? req.url ?? "/"),
          status: res.statusCode,
          latencyMs,
          reqHeaders,
          respHeaders: res.getHeaders() as RawHeaders,
          reqBody: reqChunks.length ? Buffer.concat(reqChunks) : null,
          respBody: resChunks.length ? Buffer.concat(resChunks) : null,
          reqContentType: headerValue((req.headers as IncomingHttpHeaders)["content-type"]),
          respContentType: headerValue(res.getHeader("content-type") as string | string[] | undefined),
          reqSize: contentLength((req.headers as IncomingHttpHeaders)["content-length"]) ?? reqSeen,
          // When response-body capture is off, fall back to the Content-Length header so
          // metadata-only mode still reports a known response size.
          respSize: o.captureResponseBodies ? resSeen : (contentLength(res.getHeader("content-length")) ?? 0),
        });
      } catch (e) {
        core.reportCaptureFault("response-finish capture failed", e);
      }
    });

    next();
  };
}
