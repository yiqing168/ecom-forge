import { describe, expect, it } from 'vitest';

import { applyWorkflowEvent } from './workflow-realtime.reducer';
import type { WorkflowSnapshot } from './workflow-realtime.types';

const snapshot: WorkflowSnapshot = {
  workflow_run: {
    id: 'run-1',
    status: 'queued',
    trigger_mode: 'chat',
    created_at: '2026-08-11T00:00:00.000Z',
    finished_at: null,
  },
  tasks: [
    {
      id: 'task-1',
      type: 'image.generate',
      status: 'queued',
      error_code: null,
      output_count: 1,
      created_at: '2026-08-11T00:00:00.000Z',
      started_at: null,
      ended_at: null,
      latest_attempt: null,
    },
  ],
  last_event_seq: 1,
  credit_summary: null,
  artifacts: [],
};

describe('workflow realtime reducer', () => {
  it('applies an ordered task event and ignores a duplicate', () => {
    const event = {
      schema_version: 1 as const,
      scope: 'workflow_run:run-1',
      event_seq: 2,
      event_type: 'task.status_changed' as const,
      occurred_at: '2026-08-11T00:00:01.000Z',
      payload: { task_id: 'task-1', from: 'queued', to: 'running' },
    };
    const updated = applyWorkflowEvent(snapshot, event);
    expect(updated.tasks[0]?.status).toBe('running');
    expect(applyWorkflowEvent(updated, event)).toBe(updated);
  });

  it('rejects a gap instead of guessing state', () => {
    expect(() =>
      applyWorkflowEvent(snapshot, {
        schema_version: 1,
        scope: 'workflow_run:run-1',
        event_seq: 3,
        event_type: 'workflow.status_changed',
        occurred_at: '2026-08-11T00:00:01.000Z',
        payload: { from: 'queued', to: 'running' },
      }),
    ).toThrow(/gap/);
  });
});
