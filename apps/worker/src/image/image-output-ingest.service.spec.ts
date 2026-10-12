import { describe, expect, it, vi } from 'vitest';

import { resolveProducerTurn, workflowOriginDomain } from './image-output-ingest.service.js';

describe('image artifact origin domain', () => {
  it('keeps a commerce origin for current-session edits that inherit product facts', () => {
    expect(
      workflowOriginDomain({ canonical_plan: { intent: { kind: 'chat_artifact_edit' } } }, true),
    ).toBe('commerce');
  });

  it('uses the compiled intent when no product facts are attached', () => {
    expect(
      workflowOriginDomain({ canonical_plan: { intent: { kind: 'commerce_generate' } } }, false),
    ).toBe('commerce');
    expect(
      workflowOriginDomain({ canonical_plan: { intent: { kind: 'chat_artifact_edit' } } }, false),
    ).toBe('creative');
  });
});

describe('retry artifact producer lineage', () => {
  it('resolves the original chat session through a cross-workflow parent task', async () => {
    const findTurn = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ sessionId: 'session-original' });
    const transaction = {
      query: {
        agentTurns: { findFirst: findTurn },
        tasks: {
          findFirst: vi.fn().mockResolvedValue({
            workflowRunId: 'workflow-original',
            parentTaskId: null,
          }),
        },
      },
    };

    await expect(
      resolveProducerTurn(transaction as never, 'workflow-retry', 'task-original'),
    ).resolves.toEqual({ sessionId: 'session-original' });
    expect(transaction.query.tasks.findFirst).toHaveBeenCalledOnce();
  });
});
