import { describe, expect, it } from 'vitest';

import nextConfig, { ADMIN_API_PROXY_TIMEOUT_MS } from './next.config';

describe('admin Next.js configuration', () => {
  it('keeps the API rewrite open for the complete image model PoC window', () => {
    expect(ADMIN_API_PROXY_TIMEOUT_MS).toBe(300_000);
    expect(nextConfig.experimental?.proxyTimeout).toBe(ADMIN_API_PROXY_TIMEOUT_MS);
  });
});
