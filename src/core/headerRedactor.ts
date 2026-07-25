import { tokenize, type CompiledRuleset } from "@tospec/redact";
import type { RedactionKeyring } from "@tospec/redact";

/**
 * Header redaction (ToSpec-Dev/sdk-protocol §4). Auth-shaped headers are stripped
 * **unconditionally** (even with no ruleset); the ruleset's `headers.strip`/
 * `headers.hash` lists **add to** that default set. Hashed headers use the same
 * `tsr_v{n}_…` tokenizer as the body engine. Port of `HeaderRedactor.cs`.
 */

const DEFAULT_REQUEST_STRIP = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "proxy-authorization",
  "x-tospec-key",
]);

const DEFAULT_RESPONSE_STRIP = new Set(["set-cookie", "www-authenticate", "proxy-authenticate"]);

export type RawHeaders = Record<string, string | string[] | number | undefined>;

function coerce(value: string | string[] | number | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function redactHeaders(
  headers: RawHeaders,
  isRequest: boolean,
  ruleset: CompiledRuleset | null,
  keys: RedactionKeyring,
): Record<string, string> {
  const defaults = isRequest ? DEFAULT_REQUEST_STRIP : DEFAULT_RESPONSE_STRIP;
  const strip = ruleset?.headers.strip;
  const hash = ruleset?.headers.hash;

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (defaults.has(lower) || strip?.has(lower)) {
      continue; // stripped unconditionally / by ruleset
    }
    if (hash?.has(lower)) {
      out[name] = tokenize(Buffer.from(coerce(value), "utf8"), keys);
      continue;
    }
    out[name] = coerce(value);
  }
  return out;
}
