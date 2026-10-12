import { rateLimitIpBucket, TrustedProxyResolver } from '../../shared/http/client-ip.js';

export interface ApiRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

export function requestIpBucket(
  request: ApiRequest,
  trustedProxyCidrs: readonly string[] | undefined,
): string {
  const resolver = new TrustedProxyResolver(trustedProxyCidrs ?? ['127.0.0.1/32', '::1/128']);
  return rateLimitIpBucket(
    resolver.resolve(request.socket.remoteAddress ?? '127.0.0.1', request.headers),
  );
}

export interface ApiResponse {
  append(name: string, value: string): void;
  status(code: number): void;
}

export function headerValue(request: ApiRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function requestHeaders(request: ApiRequest): Headers {
  const HeadersConstructor = globalThis.Headers as unknown as { new (): Headers };
  const headers = new HeadersConstructor();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  return headers;
}

export function copyAuthCookies(source: Headers, response: ApiResponse): void {
  const headers = source as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) response.append('set-cookie', cookie);
  if (cookies.length === 0) {
    const cookie = source.get('set-cookie');
    if (cookie) response.append('set-cookie', cookie);
  }
}
