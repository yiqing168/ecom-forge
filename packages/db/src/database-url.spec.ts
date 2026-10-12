import { describe, expect, it } from 'vitest';

import { LOCAL_DATABASE_URL, resolveDatabaseUrl } from './database-url.js';

describe('resolveDatabaseUrl', () => {
  it('uses the configured database URL', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgresql://configured' })).toBe(
      'postgresql://configured',
    );
  });

  it('uses the local database only outside production', () => {
    expect(resolveDatabaseUrl({ NODE_ENV: 'development' })).toBe(LOCAL_DATABASE_URL);
  });

  it('fails immediately when production configuration is missing', () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: 'production' })).toThrow(
      'DATABASE_URL is required when NODE_ENV=production',
    );
  });
});
