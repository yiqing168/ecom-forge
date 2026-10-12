import { describe, expect, it } from 'vitest';

import { retryExecutionParams } from './workflow-retry.service.js';

describe('workflow image retry execution snapshot', () => {
  it('preserves the frozen creative input but derives a fresh Provider execution identity', () => {
    const original = {
      creative_prompt: 'server-only prompt',
      creative_note: 'public note',
      input_bindings: [],
      operation_key: 'a'.repeat(64),
      output_count: 1,
      depends_on: ['other-task'],
      model_snapshot: { id: 'model-a' },
    };

    const retry = retryExecutionParams(original, '00000000-0000-4000-8000-000000000001');

    expect(retry).toMatchObject({
      creative_prompt: original.creative_prompt,
      creative_note: original.creative_note,
      input_bindings: original.input_bindings,
      model_snapshot: original.model_snapshot,
      output_count: 1,
      depends_on: [],
      source: 'chat',
    });
    expect(retry.operation_key).toMatch(/^[a-f0-9]{64}$/);
    expect(retry.operation_key).not.toBe(original.operation_key);
    expect(
      retryExecutionParams(original, '00000000-0000-4000-8000-000000000001').operation_key,
    ).toBe(retry.operation_key);
  });
});
