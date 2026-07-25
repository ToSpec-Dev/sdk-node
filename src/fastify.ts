import { Readable, Transform } from "node:stream";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ConformanceCore } from "./core/conformanceCore.js";
import { resolveOptions, type ToSpecConformanceOptions } from "./options.js";
import type { Transport } from "./core/transport.js";
import type { RawHeaders } from "./core/headerRedactor.js";
import type { ToSpecHandle } from "./express.js";
import { toIsoOffset, headerValue, contentLength, pathOf } from "./core/http.js";

interface ReqState {
  partnerId: string;
  startTs: Date;
  startTime: bigint;
  reqChunks: Buffer[];
  reqCap: number;
  reqSeen: number;
  respBody: Buffer | null;
  respSeen: number;
}

/**
 * Fastify adapter over the same `ConformanceCore` as the Express adapter. Uses
 * the request lifecycle hooks: `onRequest` (kill switch + partner resolution),
 * `preParsing` (transparent request-body tee), `onSend` (response-body capture),
 * `onResponse` (redact-before-transmission + non-blocking enqueue).
 */
export function useToSpecConformance(
  fastify: FastifyInstance,
  options: ToSpecConformanceOptions<FastifyRequest>,
  transport?: Transport,
): ToSpecHandle {
  const o = resolveOptions<FastifyRequest>(options);
  const core = new ConformanceCore(o, transport);
  core.start();

  const states = new WeakMap<FastifyRequest, ReqState>();

  fastify.addHook("onRequest", (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    if (core.snapshot.killSwitch) {
      done();
      return;
    }
    let partnerId: string | null | undefined;
    try {
      partnerId = o.resolvePartnerId(request);
    } catch (e) {
      core.reportCaptureFault("resolvePartnerId threw", e);
      done();
      return;
    }
    if (partnerId == null) {
      done();
      return;
    }
    states.set(request, {
      partnerId,
      startTs: new Date(),
      startTime: process.hrtime.bigint(),
      reqChunks: [],
      reqCap: 0,
      reqSeen: 0,
      respBody: null,
      respSeen: 0,
    });
    done();
  });

  if (o.captureRequestBodies) {
    fastify.addHook(
      "preParsing",
      (
        request: FastifyRequest,
        _reply: FastifyReply,
        payload: Readable,
        done: (err: Error | null, stream?: Readable) => void,
      ) => {
        const st = states.get(request);
        if (!st) {
          done(null, payload);
          return;
        }
        const tee = new Transform({
          transform(chunk: Buffer, _enc, cb): void {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            st.reqSeen += buf.length;
            if (st.reqCap < o.maxBodyBytes) {
              const take = buf.subarray(0, o.maxBodyBytes - st.reqCap);
              st.reqChunks.push(take);
              st.reqCap += take.length;
            }
            cb(null, chunk);
          },
        });
        payload.pipe(tee);
        done(null, tee);
      },
    );
  }

  if (o.captureResponseBodies) {
    fastify.addHook(
      "onSend",
      (
        request: FastifyRequest,
        _reply: FastifyReply,
        payload: unknown,
        done: (err: Error | null, payload?: unknown) => void,
      ) => {
        const st = states.get(request);
        if (st && payload != null) {
          try {
            if (typeof payload === "string" || Buffer.isBuffer(payload)) {
              const buf = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
              st.respSeen = buf.length; // full size for resp_size
              st.respBody = buf.subarray(0, o.maxBodyBytes); // cap retained/transmitted bytes
            } else if (payload instanceof Readable) {
              const tee = new Transform({
                transform(chunk: Buffer | string, encoding, callback): void {
                  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
                  st.respSeen += buf.length;
                  if (st.respBody === null) st.respBody = Buffer.alloc(0);
                  if (st.respBody.length < o.maxBodyBytes) {
                    const take = buf.subarray(0, o.maxBodyBytes - st.respBody.length);
                    st.respBody = Buffer.concat([st.respBody, take]);
                  }
                  callback(null, chunk);
                },
              });
              done(null, payload.pipe(tee));
              return;
            }
          } catch {
            /* capture is best-effort; never disturb the response */
          }
        }
        done(null, payload);
      },
    );
  }

  fastify.addHook("onResponse", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const st = states.get(request);
    if (st) {
      try {
        const latencyMs = Number(process.hrtime.bigint() - st.startTime) / 1e6;
        core.captureExchange({
          partnerId: st.partnerId,
          ts: toIsoOffset(st.startTs),
          method: request.method,
          path: pathOf(request.url),
          status: reply.statusCode,
          latencyMs,
          reqHeaders: request.headers as RawHeaders,
          respHeaders: reply.getHeaders() as RawHeaders,
          reqBody: st.reqChunks.length ? Buffer.concat(st.reqChunks) : null,
          respBody: st.respBody,
          reqContentType: headerValue(request.headers["content-type"]),
          respContentType: headerValue(reply.getHeader("content-type") as string | string[] | undefined),
          reqSize: contentLength(request.headers["content-length"]) ?? st.reqSeen,
          // Fall back to the Content-Length header when response-body capture is off.
          respSize: o.captureResponseBodies
            ? st.respSeen
            : (contentLength(reply.getHeader("content-length") as string | number | undefined) ?? 0),
        });
      } catch (e) {
        core.reportCaptureFault("onResponse capture failed", e);
      }
    }
    done();
  });

  return {
    core,
    stop: () => core.stop(),
    metrics: () => core.metricsSnapshot(),
  };
}
