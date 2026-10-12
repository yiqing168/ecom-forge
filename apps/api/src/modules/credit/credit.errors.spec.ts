import { CreditError } from '@ecom-forge/credit';
import { describe, expect, it } from 'vitest';

import { mapCreditError } from './credit.errors.js';

describe('credit HTTP error projection', () => {
  it('projects hidden workflow ownership misses as RESOURCE_NOT_FOUND', () => {
    expect(
      mapCreditError(new CreditError('Image task was not found', 'RESOURCE_NOT_FOUND')),
    ).toEqual({
      status: 404,
      body: { code: 'RESOURCE_NOT_FOUND', message: '未找到该任务' },
    });
  });
});
