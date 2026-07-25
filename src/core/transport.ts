/**
 * The HTTP seam. The default `FetchTransport` uses Node's global `fetch`
 * (`undici`) — no dependency. Tests inject a recording transport to intercept
 * the exact outbound wire bytes without a real socket.
 */
export interface TransportResponse {
  status: number;
  etag: string | null;
  text(): Promise<string>;
}

export interface Transport {
  post(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TransportResponse>;

  get(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TransportResponse>;
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export class FetchTransport implements Transport {
  async post(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TransportResponse> {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: withTimeout(signal, timeoutMs),
    });
    return { status: res.status, etag: res.headers.get("etag"), text: () => res.text() };
  }

  async get(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TransportResponse> {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: withTimeout(signal, timeoutMs),
    });
    return { status: res.status, etag: res.headers.get("etag"), text: () => res.text() };
  }
}
