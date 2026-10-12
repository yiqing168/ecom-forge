import { describe, expect, it } from 'vitest';

import { publicAgentAttachments } from './agent-public-projection.js';

describe('publicAgentAttachments', () => {
  it('projects an artifact creation note but never adds one to a source asset', () => {
    expect(
      publicAgentAttachments([
        {
          kind: 'artifact',
          object_id: '77777777-7777-4777-8777-777777777777',
          role: 'other',
          position: 0,
          creative_note: '  用偏心主重量和纤维边缘重组原场景。  ',
        },
        {
          kind: 'asset',
          object_id: '88888888-8888-4888-8888-888888888888',
          role: 'semantic_reference',
          position: 1,
          creative_note: '不应公开',
        },
      ]),
    ).toEqual([
      {
        resource_type: 'artifact',
        resource_id: '77777777-7777-4777-8777-777777777777',
        role: 'other',
        position: 0,
        creative_note: '用偏心主重量和纤维边缘重组原场景。',
      },
      {
        resource_type: 'asset',
        resource_id: '88888888-8888-4888-8888-888888888888',
        role: 'semantic_reference',
        position: 1,
      },
    ]);
  });
});
