/**
 * content-type → `content_format` (json | xml | text | binary). Only json/xml
 * have a structured redactor; everything else is dropped rather than transmitted
 * raw. Port of `ContentFormat.cs`.
 */
export type ContentFormat = "json" | "xml" | "text" | "binary";

export function detectContentFormat(contentType: string | undefined | null): ContentFormat {
  if (contentType == null || contentType.length === 0) return "binary";
  const ct = contentType.toLowerCase();
  const base = ct.split(";", 1)[0]!.trim();

  if (base === "application/json" || base.endsWith("+json") || base === "text/json") {
    return "json";
  }
  if (base === "application/xml" || base === "text/xml" || base.endsWith("+xml")) {
    return "xml";
  }
  if (base.startsWith("text/")) {
    return "text";
  }
  return "binary";
}
