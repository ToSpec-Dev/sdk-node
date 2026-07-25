import { randomFillSync } from "node:crypto";

/**
 * UUIDv7 (time-ordered) for `event_id` / `batch_id`, mirroring .NET's
 * `Guid.CreateVersion7()`. 48-bit Unix-ms timestamp + version/variant bits +
 * random. Lowercase hex, no external dependency.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  const ts = Date.now();
  // 48-bit big-endian millisecond timestamp in bytes[0..5].
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant

  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
