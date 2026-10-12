import { describe, expect, it } from 'vitest';

import type { AdminRequest } from './admin-http.js';
import { isLocalAdminSessionAvailable, isLoopbackAdminRequest } from './admin-auth.service.js';

function request(remoteAddress: string): AdminRequest {
  return { socket: { remoteAddress } } as unknown as AdminRequest;
}

describe('local admin session boundary', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts loopback %s', (address) => {
    expect(isLoopbackAdminRequest(request(address))).toBe(true);
  });

  it.each(['10.0.0.2', '192.168.1.9', '203.0.113.5'])('rejects non-loopback %s', (address) => {
    expect(isLoopbackAdminRequest(request(address))).toBe(false);
  });

  it.each(['local'] as const)('allows the local session only in %s', (appEnv) => {
    expect(isLocalAdminSessionAvailable(appEnv, request('127.0.0.1'))).toBe(true);
  });

  it.each(['test', 'staging', 'beta', 'production'] as const)(
    'rejects the local session endpoint in %s even from loopback',
    (appEnv) => {
      expect(isLocalAdminSessionAvailable(appEnv, request('127.0.0.1'))).toBe(false);
    },
  );

  it('rejects a non-loopback request in local', () => {
    expect(isLocalAdminSessionAvailable('local', request('192.168.1.9'))).toBe(false);
  });
});
