import { describe, expect, it } from 'vitest';

import { buildArtifactAttachments } from './agent-turn-terminal.repository.js';

describe('AgentTurnTerminalRepository artifact attachments', () => {
  it('binds each artifact to the creative note from its own generation task', () => {
    expect(
      buildArtifactAttachments(
        [
          { id: 'task-1', paramsSnapshot: { creative_note: '命题一：以断裂边缘连接远近。' } },
          { id: 'task-2', paramsSnapshot: { creative_note: '命题二：以单点亮色标记出口。' } },
        ],
        [
          { id: 'artifact-2', taskId: 'task-2' },
          { id: 'artifact-1', taskId: 'task-1' },
        ],
      ),
    ).toEqual([
      {
        kind: 'artifact',
        object_id: 'artifact-2',
        role: 'other',
        position: 0,
        creative_note: '命题二：以单点亮色标记出口。',
      },
      {
        kind: 'artifact',
        object_id: 'artifact-1',
        role: 'other',
        position: 1,
        creative_note: '命题一：以断裂边缘连接远近。',
      },
    ]);
  });
});
