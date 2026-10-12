import { describe, expect, it } from 'vitest';

import { buildServiceName } from './index.js';

describe('buildServiceName', () => {
  it('normalizes a service name', () => {
    expect(buildServiceName(' API ')).toBe('ecom-forge-api');
  });

  it('rejects an empty service name', () => {
    expect(() => buildServiceName(' ')).toThrow('service must not be empty');
  });
});
