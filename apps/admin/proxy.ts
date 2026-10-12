import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { adminSecurityHeaders } from '@/lib/admin-security-headers';

const BLOCKED_PREFIXES = ['/users', '/operations', '/finance', '/skills', '/admins', '/audit'];

export function proxy(request: NextRequest): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const headers = adminSecurityHeaders(nonce, process.env.NODE_ENV !== 'production');
  if (BLOCKED_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return new Response('Not Found', {
      status: 404,
      headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy']!);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
