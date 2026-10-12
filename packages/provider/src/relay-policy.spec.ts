import { describe, expect, it } from 'vitest';

import { isOutputOriginAllowed, normalizeOutputOriginEntry } from './relay-policy.js';

describe('normalizeOutputOriginEntry', () => {
  it('keeps an exact HTTPS origin', () => {
    expect(normalizeOutputOriginEntry('https://oss4.cxkedu.shop/')).toBe(
      'https://oss4.cxkedu.shop',
    );
  });

  it('normalizes a single-domain wildcard entry', () => {
    expect(normalizeOutputOriginEntry('https://*.CXKEDU.shop')).toBe('https://*.cxkedu.shop');
  });

  it('rejects non-HTTPS, bare, nested, and single-label wildcards', () => {
    expect(() => normalizeOutputOriginEntry('http://*.cxkedu.shop')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
    expect(() => normalizeOutputOriginEntry('https://*')).toThrow('PROVIDER_RELAY_URL_INVALID');
    expect(() => normalizeOutputOriginEntry('https://*.*.shop')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
    expect(() => normalizeOutputOriginEntry('https://*.shop')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
  });

  it('preserves an explicit port on a wildcard entry', () => {
    expect(normalizeOutputOriginEntry('https://*.cxkedu.shop:8443')).toBe(
      'https://*.cxkedu.shop:8443',
    );
    expect(() => normalizeOutputOriginEntry('https://*.cxkedu.shop:0')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
    expect(() => normalizeOutputOriginEntry('https://*.cxkedu.shop:99999')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
    expect(() => normalizeOutputOriginEntry('https://*.cxkedu.shop:abc')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
  });

  it('rejects userinfo, paths, query, and hash on wildcard entries', () => {
    expect(() => normalizeOutputOriginEntry('https://user:pass@*.cxkedu.shop')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
    expect(() => normalizeOutputOriginEntry('https://*.cxkedu.shop/pool')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
    expect(() => normalizeOutputOriginEntry('https://*.cxkedu.shop/?a=1')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
    expect(() => normalizeOutputOriginEntry('https://*.cxkedu.shop#f')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
  });

  it('rejects a misplaced wildcard inside the host', () => {
    expect(() => normalizeOutputOriginEntry('https://oss*.cxkedu.shop')).toThrow(
      'PROVIDER_RELAY_URL_INVALID',
    );
  });
});

describe('isOutputOriginAllowed', () => {
  const allowlist = ['https://*.cxkedu.shop', 'https://provider-output.example.com'];

  it('allows every subdomain of the wildcard domain family', () => {
    expect(isOutputOriginAllowed(new URL('https://oss5.cxkedu.shop/f.png'), allowlist)).toBe(true);
    expect(isOutputOriginAllowed(new URL('https://oss99.cxkedu.shop/f.png'), allowlist)).toBe(true);
    expect(isOutputOriginAllowed(new URL('https://a.b.cxkedu.shop/f.png'), allowlist)).toBe(true);
    expect(isOutputOriginAllowed(new URL('https://cxkedu.shop/f.png'), allowlist)).toBe(true);
  });

  it('keeps the dot boundary and rejects foreign hosts', () => {
    expect(isOutputOriginAllowed(new URL('https://evilcxkedu.shop/f.png'), allowlist)).toBe(false);
    expect(isOutputOriginAllowed(new URL('https://cxkedu.shop.evil.com/f.png'), allowlist)).toBe(
      false,
    );
    expect(isOutputOriginAllowed(new URL('https://other.example.com/f.png'), allowlist)).toBe(
      false,
    );
  });

  it('scopes wildcard port matching to the configured port', () => {
    const portedList = ['https://*.example.com:8443'];
    expect(isOutputOriginAllowed(new URL('https://a.example.com:8443/f.png'), portedList)).toBe(
      true,
    );
    expect(isOutputOriginAllowed(new URL('https://a.example.com/f.png'), portedList)).toBe(false);
    expect(isOutputOriginAllowed(new URL('https://a.example.com:8444/f.png'), portedList)).toBe(
      false,
    );
  });

  it('still matches exact origin entries', () => {
    expect(
      isOutputOriginAllowed(new URL('https://provider-output.example.com/f.png'), allowlist),
    ).toBe(true);
    expect(
      isOutputOriginAllowed(new URL('http://provider-output.example.com/f.png'), allowlist),
    ).toBe(false);
  });
});
