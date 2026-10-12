import type { WorkflowRealtimeEvent, WorkflowSnapshot } from './workflow-realtime.types';

export function applyWorkflowEvent(
  snapshot: WorkflowSnapshot,
  event: WorkflowRealtimeEvent,
): WorkflowSnapshot {
  if (event.event_seq <= snapshot.last_event_seq) return snapshot;
  if (event.event_seq !== snapshot.last_event_seq + 1) {
    throw new Error('Workflow realtime event sequence has a gap');
  }
  if (event.event_type === 'workflow.status_changed') {
    const next = event.payload.to;
    if (typeof next !== 'string') throw new Error('Workflow status event is invalid');
    return {
      ...snapshot,
      workflow_run: { ...snapshot.workflow_run, status: next },
      last_event_seq: event.event_seq,
    };
  }
  if (event.event_type === 'task.status_changed') {
    const taskId = event.payload.task_id;
    const next = event.payload.to;
    if (typeof taskId !== 'string' || typeof next !== 'string') {
      throw new Error('Task status event is invalid');
    }
    return {
      ...snapshot,
      tasks: snapshot.tasks.map((task) => (task.id === taskId ? { ...task, status: next } : task)),
      last_event_seq: event.event_seq,
    };
  }
  return { ...snapshot, last_event_seq: event.event_seq };
}
