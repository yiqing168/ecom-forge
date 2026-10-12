import { InvalidProxyAddressError, rateLimitIpBucket, TrustedProxyResolver } from './client-ip.js';

describe('TrustedProxyResolver', () => {
  const resolver = new TrustedProxyResolver(['127.0.0.1/32', '10.0.0.0/8', '::1/128']);

  it('ignores spoofed forwarding headers from an untrusted client', () => {
    expect(
      resolver.resolve('203.0.113.8', {
        'x-real-ip': '198.51.100.9',
        'x-forwarded-for': '192.0.2.10',
        forwarded: 'for=192.0.2.11',
      }),
    ).toBe('203.0.113.8');
  });

  it('accepts an address overwritten by a trusted ingress', () => {
    expect(resolver.resolve('127.0.0.1', { 'x-real-ip': '203.0.113.18' })).toBe('203.0.113.18');
    expect(resolver.resolve('10.0.0.4', { 'x-forwarded-for': '203.0.113.20, 10.0.0.3' })).toBe(
      '203.0.113.20',
    );
  });

  it('fails closed on malformed headers from a trusted proxy', () => {
    expect(() => resolver.resolve('127.0.0.1', { 'x-real-ip': 'not-an-ip' })).toThrow(
      InvalidProxyAddressError,
    );
  });
});

describe('rateLimitIpBucket', () => {
  it('keeps IPv4 addresses and aggregates IPv6 by /64', () => {
    expect(rateLimitIpBucket('203.0.113.8')).toBe('203.0.113.8');
    expect(rateLimitIpBucket('2001:db8:1234:5678:abcd::1')).toBe('2001:db8:1234:5678:0:0:0:0/64');
    expect(rateLimitIpBucket('2001:db8:1234:5678:ffff::2')).toBe('2001:db8:1234:5678:0:0:0:0/64');
  });
});
