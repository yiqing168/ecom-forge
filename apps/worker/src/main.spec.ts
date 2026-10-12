import { describe, expect, it } from 'vitest';

import { getWorkerHealth } from './main.js';

describe('worker bootstrap', () => {
  it('reports a ready state', () => {
    expect(getWorkerHealth()).toEqual({
      service: 'ecom-forge-worker',
      status: 'ready',
    });
  });
});
