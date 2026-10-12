import { describe, expect, it } from 'vitest';

import type { WorkflowSnapshot } from '@/features/realtime/workflow-realtime.types';

import { projectWorkflowReviewState } from './workflow-public-state';

describe('projectWorkflowReviewState', () => {
  it('maps a waiting moderation task to the 24-hour content review state', () => {
    expect(
      projectWorkflowReviewState(
        workflowSnapshot('running', [workflowTask('moderation.image', 'waiting_manual_review')]),
      ),
    ).toBe('content_review');
  });

  it('maps other manual review waits to result confirmation', () => {
    expect(
      projectWorkflowReviewState(
        workflowSnapshot('waiting_manual_review', [
          workflowTask('image.generate', 'waiting_manual_review'),
        ]),
      ),
    ).toBe('result_confirmation');
  });

  it('suppresses the review state when the waiting task has a retry link', () => {
    const superseded = {
      ...workflowTask('image.generate', 'waiting_manual_review'),
      latest_retry: { workflow_run_id: 'run-2', task_id: 'task-retry', status: 'running' },
    };
    expect(
      projectWorkflowReviewState(workflowSnapshot('waiting_manual_review', [superseded])),
    ).toBeNull();
  });

  it('does not project a review state for an active workflow', () => {
    expect(
      projectWorkflowReviewState(
        workflowSnapshot('running', [workflowTask('image.generate', 'running')]),
      ),
    ).toBeNull();
  });
});

function workflowSnapshot(status: string, tasks: WorkflowSnapshot['tasks']): WorkflowSnapshot {
  return {
    workflow_run: {
      id: 'run-1',
      status,
      trigger_mode: 'chat',
      created_at: '2026-08-26T00:00:00.000Z',
      finished_at: null,
    },
    tasks,
    last_event_seq: 1,
    credit_summary: null,
    artifacts: [],
  };
}

function workflowTask(type: string, status: string): WorkflowSnapshot['tasks'][number] {
  return {
    id: `task-${type}`,
    type,
    status,
    error_code: null,
    output_count: type.startsWith('image.') ? 1 : null,
    created_at: '2026-08-26T00:00:00.000Z',
    started_at: '2026-08-26T00:00:01.000Z',
    ended_at: null,
    latest_attempt: null,
  };
}
