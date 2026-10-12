import { describe, expect, it } from 'vitest';

import { resolveRetryChain, resolveTurnRetryChain } from './retry-chain';
import type { WorkflowSnapshot } from '../realtime/workflow-realtime.types';

function workflowSnapshot(input: {
  workflowRunId: string;
  status?: string;
  tasks: Array<WorkflowSnapshot['tasks'][number]>;
  artifacts?: WorkflowSnapshot['artifacts'];
}): WorkflowSnapshot {
  return {
    workflow_run: {
      id: input.workflowRunId,
      status: input.status ?? 'failed',
      trigger_mode: 'agent',
      created_at: '2026-09-06T08:00:00.000Z',
      finished_at: null,
    },
    tasks: input.tasks,
    last_event_seq: 1,
    credit_summary: null,
    artifacts: input.artifacts ?? [],
  };
}

function task(input: {
  id: string;
  status: string;
  latestRetry?: { workflowRunId: string; taskId: string; status: string } | null;
}): WorkflowSnapshot['tasks'][number] {
  return {
    id: input.id,
    type: 'image.generate',
    status: input.status,
    error_code: null,
    output_count: 1,
    latest_retry: input.latestRetry
      ? {
          workflow_run_id: input.latestRetry.workflowRunId,
          task_id: input.latestRetry.taskId,
          status: input.latestRetry.status,
        }
      : null,
    created_at: '2026-09-06T08:00:00.000Z',
    started_at: null,
    ended_at: null,
    latest_attempt: null,
  };
}

describe('resolveRetryChain', () => {
  it('walks a single retry link to a succeeded end', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-a',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'succeeded' },
          }),
        ],
      }),
      'workflow-b': workflowSnapshot({
        workflowRunId: 'workflow-b',
        status: 'succeeded',
        tasks: [task({ id: 'task-b', status: 'succeeded' })],
        artifacts: [],
      }),
    };
    expect(resolveRetryChain(snapshots, 'workflow-a', 'task-a')).toEqual({
      depth: 1,
      endStatus: 'succeeded',
      endWorkflowRunId: 'workflow-b',
      endTaskId: 'task-b',
    });
  });

  it('reports detached when the retry workflow snapshot is missing', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-a',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'running' },
          }),
        ],
      }),
    };
    expect(resolveRetryChain(snapshots, 'workflow-a', 'task-a')).toEqual({
      depth: 1,
      endStatus: 'detached',
    });
  });
});

describe('resolveTurnRetryChain', () => {
  it('resolves a chain that ends in success', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-a',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'succeeded' },
          }),
        ],
      }),
      'workflow-b': workflowSnapshot({
        workflowRunId: 'workflow-b',
        status: 'succeeded',
        tasks: [task({ id: 'task-b', status: 'succeeded' })],
      }),
    };
    expect(resolveTurnRetryChain(snapshots, 'workflow-a')).toBe('succeeded');
  });

  it('resolves a chain that ends in failure', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-a',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'failed' },
          }),
        ],
      }),
      'workflow-b': workflowSnapshot({
        workflowRunId: 'workflow-b',
        tasks: [task({ id: 'task-b', status: 'failed' })],
      }),
    };
    expect(resolveTurnRetryChain(snapshots, 'workflow-a')).toBe('failed');
  });

  it('follows a multi-hop chain to the final outcome', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-a',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'failed' },
          }),
        ],
      }),
      'workflow-b': workflowSnapshot({
        workflowRunId: 'workflow-b',
        tasks: [
          task({
            id: 'task-b',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-c', taskId: 'task-c', status: 'succeeded' },
          }),
        ],
      }),
      'workflow-c': workflowSnapshot({
        workflowRunId: 'workflow-c',
        status: 'succeeded',
        tasks: [task({ id: 'task-c', status: 'succeeded' })],
      }),
    };
    expect(resolveTurnRetryChain(snapshots, 'workflow-a')).toBe('succeeded');
  });

  it('treats a cancelled retry link as a failed end', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-a',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'cancelled' },
          }),
        ],
      }),
    };
    expect(resolveTurnRetryChain(snapshots, 'workflow-a')).toBe('failed');
  });

  it('falls back to the retry link status when the retry snapshot is missing', () => {
    const succeededLink = workflowSnapshot({
      workflowRunId: 'workflow-a',
      tasks: [
        task({
          id: 'task-a',
          status: 'failed',
          latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'succeeded' },
        }),
      ],
    });
    expect(resolveTurnRetryChain({ 'workflow-a': succeededLink }, 'workflow-a')).toBe('succeeded');
    const runningLink = workflowSnapshot({
      workflowRunId: 'workflow-a',
      tasks: [
        task({
          id: 'task-a',
          status: 'failed',
          latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'running' },
        }),
      ],
    });
    expect(resolveTurnRetryChain({ 'workflow-a': runningLink }, 'workflow-a')).toBe('running');
  });

  it('reports running while the latest retry is still executing', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-a',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-b', status: 'running' },
          }),
        ],
      }),
      'workflow-b': workflowSnapshot({
        workflowRunId: 'workflow-b',
        tasks: [task({ id: 'task-b', status: 'running' })],
      }),
    };
    expect(resolveTurnRetryChain(snapshots, 'workflow-a')).toBe('running');
  });

  it('prefers a succeeded chain over failed ones across tasks', () => {
    const snapshots = {
      'workflow-a': workflowSnapshot({
        workflowRunId: 'workflow-a',
        tasks: [
          task({
            id: 'task-1',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-b', taskId: 'task-1b', status: 'failed' },
          }),
          task({
            id: 'task-2',
            status: 'failed',
            latestRetry: { workflowRunId: 'workflow-c', taskId: 'task-2c', status: 'succeeded' },
          }),
        ],
      }),
      'workflow-b': workflowSnapshot({
        workflowRunId: 'workflow-b',
        tasks: [task({ id: 'task-1b', status: 'failed' })],
      }),
      'workflow-c': workflowSnapshot({
        workflowRunId: 'workflow-c',
        status: 'succeeded',
        tasks: [task({ id: 'task-2c', status: 'succeeded' })],
      }),
    };
    expect(resolveTurnRetryChain(snapshots, 'workflow-a')).toBe('succeeded');
  });

  it('returns none without snapshots or retry links', () => {
    expect(resolveTurnRetryChain({}, 'workflow-a')).toBe('none');
    expect(resolveTurnRetryChain({}, null)).toBe('none');
    const noRetry = workflowSnapshot({
      workflowRunId: 'workflow-a',
      tasks: [task({ id: 'task-a', status: 'failed' })],
    });
    expect(resolveTurnRetryChain({ 'workflow-a': noRetry }, 'workflow-a')).toBe('none');
  });
});
