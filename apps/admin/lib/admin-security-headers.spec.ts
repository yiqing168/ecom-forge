import { describe, expect, it } from 'vitest';

import { adminSecurityHeaders } from './admin-security-headers';

describe('adminSecurityHeaders', () => {
  it('emits a nonce-bound production policy without development script exceptions', () => {
    const headers = adminSecurityHeaders('0123456789abcdef0123456789abcdef', false);

    expect(headers['Content-Security-Policy']).toContain(
      "script-src 'self' 'nonce-0123456789abcdef0123456789abcdef' 'strict-dynamic'",
    );
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy']).toContain('upgrade-insecure-requests');
    expect(headers['Content-Security-Policy']).not.toContain("'unsafe-eval'");
    expect(headers).toMatchObject({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
  });

  it('allows only loopback websocket development connections', () => {
    const headers = adminSecurityHeaders('0123456789abcdef0123456789abcdef', true);

    expect(headers['Content-Security-Policy']).toContain("'unsafe-eval'");
    expect(headers['Content-Security-Policy']).toContain('ws://127.0.0.1:*');
    expect(headers['Content-Security-Policy']).not.toContain('upgrade-insecure-requests');
  });

  it('rejects an unsafe nonce', () => {
    expect(() => adminSecurityHeaders("bad'; script-src *", false)).toThrow(
      'ADMIN_CSP_NONCE_INVALID',
    );
  });
});
