# @tospec/node

**The ToSpec production conformance SDK for Node.** Express/Fastify middleware that
redacts your API's request/response traffic **inside your process** and ships gzip-signed
batches to the ToSpec ingest edge on a background worker.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

It runs in your production process, so it is open source on purpose — read exactly what it
captures and what leaves your infrastructure. The redaction engine is a separate,
independently reviewable package, [`@tospec/redact`](https://github.com/ToSpec-Dev/redact-node);
the wire protocol and conformance fixtures are [`ToSpec-Dev/sdk-protocol`](https://github.com/ToSpec-Dev/sdk-protocol).
This SDK is the Node port of the .NET reference implementation
[`ToSpec-Dev/sdk-dotnet`](https://github.com/ToSpec-Dev/sdk-dotnet).

## The guarantees (they are the product)

1. **Never waits for ToSpec I/O.** The request path does only bounded in-memory copies, a
   bounded synchronous local redaction, and a non-blocking enqueue. All network I/O (ingest POST,
   config poll) runs on background workers — never awaited on the request.
2. **Redaction before transmission.** The compiled ruleset is applied to every body
   *inside your process*; only redacted bytes are ever put on the wire. Bodies without a
   structured redactor, bodies that fail to parse, and any traffic seen before a ruleset is
   fetched are **dropped, never sent raw**.
3. **Bounded memory.** A count-and-byte-bounded, drop-oldest queue caps memory under any load; the
   oldest event is evicted (and counted) rather than blocking your handler.
4. **Kill switch within one poll.** Flip it in the ToSpec portal and emission stops within
   one config-poll interval.
5. **Zero user-visible failures.** Every fault is swallowed to a counter and an `onFault`
   hook. Nothing the SDK does ever throws into your request pipeline.

## Install

```sh
npm install @tospec/node
```

`express` and `fastify` are optional peer dependencies — install whichever you use.

## Quick start

### Express

```ts
import express from "express";
import { useToSpecConformance } from "@tospec/node/express";

const app = express();

// Mount BEFORE your body parser so request bodies can be observed transparently.
const tospec = useToSpecConformance(app, {
  ingestBaseUrl: "https://ingest.tospec.net",
  ingestKey: process.env.TOSPEC_INGEST_KEY!,        // tsp_ing_…
  redactionKey: Buffer.from(process.env.TOSPEC_REDACTION_KEY_HEX!, "hex"),
  redactionKeyVersion: 1,
  resolvePartnerId: (req) => req.header("x-partner-id") ?? null,
  onFault: (f) => console.warn("[tospec]", f.kind, f.message),
});

app.use(express.json());
app.post("/v1/reservations", handler);

// On graceful shutdown:
process.on("SIGTERM", () => tospec.stop());
```

### Fastify

```ts
import Fastify from "fastify";
import { useToSpecConformance } from "@tospec/node/fastify";

const app = Fastify();
const tospec = useToSpecConformance(app, {
  ingestBaseUrl: "https://ingest.tospec.net",
  ingestKey: process.env.TOSPEC_INGEST_KEY!,
  redactionKey: Buffer.from(process.env.TOSPEC_REDACTION_KEY_HEX!, "hex"),
  resolvePartnerId: (req) => (req.headers["x-partner-id"] as string) ?? null,
});
```

## How it works

```
 request ─▶ middleware ─▶ [ redact locally ] ─▶ bounded queue ─┐   (never waits for ToSpec I/O)
                                                               │
        background sender ◀───────────────────────────────────┘
              │  gzip + HMAC-sign ─▶ POST /v1/ingest
        background poller  GET /v1/sdk/config  (ruleset · sampling · kill switch)
```

The middleware clones request/response metadata and (optionally) bodies, applies the
fetched compiled ruleset with your per-tenant redaction key, and hands a redacted envelope
to a bounded channel. A background worker batches, gzips, HMAC-signs, and POSTs. A second
worker polls the config endpoint (conditional-GET; near-free in steady state).

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `ingestBaseUrl` | — (required) | Base of the ingest edge. |
| `ingestKey` | — (required) | Per-tenant `tsp_ing_…` — credential and HMAC secret. |
| `redactionKey` | — (required) | Per-tenant redaction HMAC key (raw bytes). |
| `redactionKeyVersion` | `1` | Embedded in every `tsr_v{n}_…` token. |
| `resolvePartnerId` | — (required) | `(req) => partnerId \| null`; null skips capture. |
| `captureRequestBodies` | `true` | Capture redacted request bodies. |
| `captureResponseBodies` | `true` | Capture redacted response bodies. |
| `maxBodyBytes` | `65536` | Per-body capture cap. |
| `queueCapacity` | `10000` | Hard memory bound; drop-oldest above it. |
| `maxQueueBytes` | `67108864` | Independent estimated queued-byte bound (64 MiB). |
| `maxBatchEvents` | `200` | Max events per batch. |
| `maxBatchBytes` | `4194304` | Soft pre-gzip batch size cap. |
| `flushInterval` | `5000` | Max linger before flushing a partial batch (ms). |
| `configPollInterval` | `15000` | Config poll period (ms). |
| `ingestTimeout` | `10000` | Per-request timeout for background I/O (ms). |
| `onFault` | — | Hook for swallowed faults. |

`tospec.metrics()` exposes counters (`eventsCaptured`, `eventsDroppedQueueFull`,
`batchesSent`, `redactionFailures`, …) for your own dashboards.

## Conformance

`@tospec/node` passes the [`ToSpec-Dev/sdk-protocol`](https://github.com/ToSpec-Dev/sdk-protocol)
golden fixtures: the token vectors, the redaction vectors (via `@tospec/redact`), the header
vectors, and the signed-batch canonical bytes + signatures. Its redaction output is
byte-identical to the .NET SDK — same engine, same wire.

## Building from source

```sh
npm install    # restores @tospec/redact from the vendored tarball in vendor/
npm run build
npm test
```

Requires Node ≥ 20.

## License

[Apache-2.0](LICENSE).
