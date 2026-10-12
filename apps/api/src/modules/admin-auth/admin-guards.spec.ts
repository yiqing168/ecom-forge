import { describe, expect, it } from 'vitest';

import { isAdminOriginAllowed } from './admin-guards.js';

describe('admin origin guard', () => {
  it('accepts the configured origin in every environment', () => {
    expect(
      isAdminOriginAllowed('production', 'https://admin.example.com', 'https://admin.example.com'),
    ).toBe(true);
  });

  it('accepts localhost and loopback aliases only for local/test', () => {
    expect(isAdminOriginAllowed('local', 'http://127.0.0.1:3002', 'http://localhost:3002')).toBe(
      true,
    );
    expect(isAdminOriginAllowed('test', 'http://localhost:3200', 'http://127.0.0.1:3200')).toBe(
      true,
    );
    expect(
      isAdminOriginAllowed('production', 'https://127.0.0.1:3002', 'https://localhost:3002'),
    ).toBe(false);
  });

  it('rejects a different port or non-loopback alias', () => {
    expect(isAdminOriginAllowed('local', 'http://127.0.0.1:3002', 'http://localhost:3001')).toBe(
      false,
    );
    expect(isAdminOriginAllowed('local', 'http://127.0.0.1:3002', 'http://evil.test:3002')).toBe(
      false,
    );
  });
});
