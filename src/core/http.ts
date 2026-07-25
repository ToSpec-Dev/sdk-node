/** Small HTTP-shaping helpers shared by the framework adapters. */

/** ISO-8601 with an explicit `+00:00` offset (the wire format; not a `Z` suffix). */
export function toIsoOffset(d: Date): string {
  return d.toISOString().replace("Z", "+00:00");
}

/** First value of a possibly-multi header, as a string. */
export function headerValue(v: string | string[] | number | undefined): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : String(v);
}

/** Parse a Content-Length header to a number, or null. */
export function contentLength(v: string | string[] | number | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = Array.isArray(v) ? v[0] : v;
  const n = Number.parseInt(s ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/** The path portion of a URL (drops the query string). */
export function pathOf(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}
