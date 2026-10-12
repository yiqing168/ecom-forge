export function adminSecurityHeaders(
  nonce: string,
  development: boolean,
): Readonly<Record<string, string>> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error('ADMIN_CSP_NONCE_INVALID');
  }
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(development ? ["'unsafe-eval'"] : []),
  ];
  const connectSources = [
    "'self'",
    ...(development ? ['ws://127.0.0.1:*', 'ws://localhost:*'] : []),
  ];
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "manifest-src 'self'",
    ...(development ? [] : ['upgrade-insecure-requests']),
  ];
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': directives.join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}
