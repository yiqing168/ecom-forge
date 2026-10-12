import type { WorkflowSnapshot } from '../realtime/workflow-realtime.types';

export interface RetryChainState {
  depth: number;
  endStatus: 'succeeded' | 'failed' | 'running' | 'detached';
  endWorkflowRunId?: string;
  endTaskId?: string;
}

export type TurnRetryChainStatus = 'succeeded' | 'running' | 'failed' | 'none';

const MAX_CHAIN_DEPTH = 9;
const SETTLED_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);

/**
 * Walks the latest_retry chain of a failed task across workflow snapshots and
 * returns the composed slot state. detached means an intermediate workflow
 * snapshot is missing; callers must fall back to the plain failure display.
 */
export function resolveRetryChain(
  snapshots: Record<string, WorkflowSnapshot>,
  workflowRunId: string,
  taskId: string,
): RetryChainState {
  let currentWorkflowRunId = workflowRunId;
  let currentTaskId = taskId;
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth += 1) {
    const snapshot = snapshots[currentWorkflowRunId];
    if (!snapshot) {
      return { depth, endStatus: 'detached' };
    }
    const task = snapshot.tasks.find((item) => item.id === currentTaskId);
    if (!task) {
      return { depth, endStatus: 'detached' };
    }
    const latestRetry = task.latest_retry;
    if (!latestRetry) {
      return { depth, endStatus: 'detached' };
    }
    if (latestRetry.status === 'succeeded' || latestRetry.status === 'failed') {
      return {
        depth: depth + 1,
        endStatus: latestRetry.status,
        endWorkflowRunId: latestRetry.workflow_run_id,
        endTaskId: latestRetry.task_id,
      };
    }
    currentWorkflowRunId = latestRetry.workflow_run_id;
    currentTaskId = latestRetry.task_id;
  }
  return { depth: MAX_CHAIN_DEPTH, endStatus: 'detached' };
}

/**
 * Composes the retry outcomes of every retried task of one workflow into a single
 * turn-level status. When a retry workflow snapshot is not subscribed, the retry
 * link's own projected status stands in for the chain end, so a reloaded session
 * still resolves the outcome. succeeded wins over running, running over failed.
 */
export function resolveTurnRetryChain(
  snapshots: Record<string, WorkflowSnapshot>,
  workflowRunId: string | null | undefined,
): TurnRetryChainStatus {
  if (!workflowRunId) return 'none';
  const snapshot = snapshots[workflowRunId];
  if (!snapshot) return 'none';
  let best: 'succeeded' | 'running' | 'failed' | null = null;
  for (const task of snapshot.tasks) {
    if (!task.latest_retry) continue;
    const status = retryChainEndStatus(snapshots, workflowRunId, task.id);
    if (status === 'succeeded') return 'succeeded';
    if (best === null || (best === 'failed' && status === 'running')) best = status;
  }
  return best ?? 'none';
}

function retryChainEndStatus(
  snapshots: Record<string, WorkflowSnapshot>,
  workflowRunId: string,
  taskId: string,
): 'succeeded' | 'running' | 'failed' {
  let currentWorkflowRunId = workflowRunId;
  let currentTaskId = taskId;
  let incomingLinkStatus: string | null = null;
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth += 1) {
    const task = snapshots[currentWorkflowRunId]?.tasks.find((item) => item.id === currentTaskId);
    if (!task) {
      if (incomingLinkStatus === 'succeeded') return 'succeeded';
      // A cancelled (or otherwise settled) retry is terminal, never 'running'.
      if (
        incomingLinkStatus &&
        incomingLinkStatus !== 'running' &&
        incomingLinkStatus !== 'queued'
      ) {
        return 'failed';
      }
      return 'running';
    }
    if (task.status === 'succeeded') return 'succeeded';
    if (!task.latest_retry) {
      return SETTLED_TASK_STATUSES.has(task.status) ? 'failed' : 'running';
    }
    incomingLinkStatus = task.latest_retry.status;
    currentWorkflowRunId = task.latest_retry.workflow_run_id;
    currentTaskId = task.latest_retry.task_id;
  }
  return 'running';
}
