import { createHmac } from "node:crypto";

/**
 * Batch signature (ToSpec-Dev/sdk-protocol §2): `sha256=` + lowercase-hex of
 * `HMAC-SHA-256(key = utf8(ingestKey), message = wireBytes)`. Sign the exact
 * bytes transmitted (gzipped, if gzipped) — the server verifies before it
 * decompresses. The ingest key doubles as the HMAC secret. Port of `IngestSigner.cs`.
 */
export function signBatch(ingestKeyUtf8: Buffer, wire: Buffer): string {
  return "sha256=" + createHmac("sha256", ingestKeyUtf8).update(wire).digest("hex");
}
