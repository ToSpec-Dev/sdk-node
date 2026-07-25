# CLAUDE.md — repo conventions for @tospec/node

`@tospec/node` is the **ToSpec production conformance SDK for Node** — Express/Fastify
middleware that redacts request/response traffic locally and ships gzip-signed batches to
the ToSpec ingest edge. It is the Node port of the .NET reference implementation
[`ToSpec-Dev/sdk-dotnet`](https://github.com/ToSpec-Dev/sdk-dotnet); both are held to the same wire
contract by the golden fixtures in
[`ToSpec-Dev/sdk-protocol`](https://github.com/ToSpec-Dev/sdk-protocol). Other language ports follow
this SDK and the protocol repo.

## The guarantees are the product (SPEC-cert-gateway-architecture §9)

Every change is measured against these; each has a guarding test:

| Guarantee | Guarding test |
|---|---|
| Never blocks the event loop | `test/guarantees.test.ts` (hung-ingest p99) |
| Bounded memory (drop-oldest) | `test/guarantees.test.ts` (channel + flood) |
| Kill switch within one poll | `test/guarantees.test.ts` |
| Redaction before transmission | `test/redactionBeforeTransmission.test.ts`, `test/fastify.test.ts` |
| Zero user-visible failures | every fault → counter + `onFault`; nothing throws into the host |
| Wire conformance | `test/protocolFixtures.test.ts` (canonical bytes + signatures) |

If a change weakens a guarantee, it is wrong even if tests pass — add the test that catches
it. The request path must never `await` network I/O; all of that lives on the background
poller/sender, decoupled by the bounded channel.

## Stack rules (non-negotiable)

- **TypeScript, strict.** `tsc` with `strict`, `noUnusedLocals/Parameters`,
  `noImplicitReturns`, `verbatimModuleSyntax` — warnings are errors. ES modules, `NodeNext`.
- **One runtime dependency: `@tospec/redact`.** Everything else — crypto, gzip, fetch — is
  a Node built-in. Do NOT add HTTP clients, uuid libraries, or JSON tooling; they exist in
  the platform.
- **`express` and `fastify` are optional peer dependencies**, never direct dependencies —
  the host brings its framework (the analogue of ASP.NET being a framework reference, not a
  NuGet package). The two adapters are thin; all logic lives in the shared `core/`.
- **`@tospec/redact` is consumed, never reimplemented.** Redaction, tokenization, and the
  compiled-ruleset deserializer all come from it. Until it is published to npm it is
  **vendored** as `vendor/tospec-redact-*.tgz` and referenced via a `file:` dependency, so
  the repo builds standalone with no registry access. Re-pack it from `redact-node`
  (`npm pack --pack-destination ../sdk-node/vendor`) when its engine changes.
  **Publishability:** a `file:` dependency alone would ship a broken package (consumers
  cannot resolve the vendored tarball), so `@tospec/redact` is listed in
  **`bundleDependencies`** — `npm publish` then bundles the installed engine into the
  published tarball and consumers get it self-contained. When `@tospec/redact` is published
  to npm for real, switch the `file:` spec to a registry semver range and drop
  `bundleDependencies`.

## Wire-contract stability

The batch envelope, the signature recipe, and the token format are locked by the
`sdk-protocol` golden fixtures. A change to any of them is a breaking change and must
update the fixtures in that repo first. `test/protocolFixtures.test.ts` loads the goldens
(preferring the sibling `sdk-protocol` checkout, falling back to the synced copy under
`test/protocol-fixtures/`) and asserts the serializer bytes equal `canonical_json` and the
HMAC equals `signature`. Field order and omit-null in `core/wire.ts` are load-bearing —
they make the bytes (and therefore the signature) reproducible; do not reorder.

## Repo layout

```
src/
  options.ts            public options + validation/defaults
  express.ts            Express adapter (also exports ToSpecHandle)
  fastify.ts            Fastify adapter (same core)
  core/                 the framework-agnostic engine
    conformanceCore.ts    owns state, metrics, channel, poller, sender
    conformanceChannel.ts bounded ring buffer, drop-oldest + counter
    batchSender.ts        accumulate → gzip → sign → POST (no retry)
    configPoll.ts         GET config, ETag/304, last-good on error
    exchangeRedactor.ts   redaction-before-transmission
    wire.ts               ordered, omit-null, snake_case serializer
    transport.ts          the HTTP seam (FetchTransport; tests inject a fake)
    ...
test/                   vitest — guarantees, protocol fixtures, unit tests
vendor/                 the pinned @tospec/redact tarball
```

## Testing

- Framework **vitest**. In-process only: Express tests use an ephemeral `app.listen(0)`;
  Fastify tests use `app.inject`. The HTTP seam (`Transport`) is stubbed with a
  `RecordingTransport` so tests intercept the exact outbound wire bytes — no real sockets,
  no network. Naming `MethodOrBehavior_Condition_ExpectedOutcome`.
- Every guarantee in the table above stays covered. The redaction-before-transmission test
  gunzips and base64-decodes the intercepted batch so a body-borne secret cannot hide.

## Build / run

```sh
npm install
npm run build      # tsc, strict
npm test           # vitest
```
