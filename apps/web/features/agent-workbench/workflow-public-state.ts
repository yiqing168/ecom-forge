import type { WorkflowSnapshot } from '@/features/realtime/workflow-realtime.types';

export type WorkflowReviewState = 'content_review' | 'result_confirmation';

export function projectWorkflowReviewState(
  snapshot: WorkflowSnapshot | null,
): WorkflowReviewState | null {
  if (!snapshot) return null;

  // A task with a retry link has been superseded by that retry; its stale
  // waiting_manual_review state must no longer drive the review banner,
  // including after a page refresh when in-memory retry links are gone.
  const waitingTasks = snapshot.tasks.filter(
    (task) => task.status === 'waiting_manual_review' && !task.latest_retry,
  );
  if (waitingTasks.length === 0) return null;

  return waitingTasks.some((task) => task.type === 'moderation.image')
    ? 'content_review'
    : 'result_confirmation';
}
