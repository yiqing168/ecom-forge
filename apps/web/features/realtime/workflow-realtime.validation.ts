import type { WorkflowRealtimeEvent, WorkflowSnapshot } from './workflow-realtime.types';

const SUPPORTED_EVENTS = new Set([
  'workflow.created',
  'workflow.status_changed',
  'task.status_changed',
  'artifact.created',
  'credit.settled',
  'credit.released',
]);

export class RealtimeRecoveryError extends Error {
  constructor() {
    super('Realtime state requires a snapshot recovery');
    this.name = 'RealtimeRecoveryError';
  }
}

export function parseRecord(serialized: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new RealtimeRecoveryError();
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RealtimeRecoveryError();
  }
  return value as Record<string, unknown>;
}

export function parseWorkflowEvent(
  serialized: string,
  expectedScope: string,
): WorkflowRealtimeEvent {
  const value = parseRecord(serialized);
  if (
    value.schema_version !== 1 ||
    value.scope !== expectedScope ||
    typeof value.event_seq !== 'number' ||
    !Number.isInteger(value.event_seq) ||
    typeof value.event_type !== 'string' ||
    !SUPPORTED_EVENTS.has(value.event_type) ||
    typeof value.occurred_at !== 'string' ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  ) {
    throw new RealtimeRecoveryError();
  }
  return value as unknown as WorkflowRealtimeEvent;
}

export function parseWorkflowSnapshot(value: unknown): WorkflowSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Workflow snapshot is invalid');
  }
  const snapshot = value as Partial<WorkflowSnapshot>;
  if (
    typeof snapshot.workflow_run?.id !== 'string' ||
    !Array.isArray(snapshot.tasks) ||
    !Number.isInteger(snapshot.last_event_seq) ||
    (snapshot.last_event_seq ?? -1) < 0 ||
    !Array.isArray(snapshot.artifacts)
  ) {
    throw new Error('Workflow snapshot is invalid');
  }
  for (const task of snapshot.tasks) {
    if (
      typeof task !== 'object' ||
      task === null ||
      typeof task.id !== 'string' ||
      typeof task.type !== 'string' ||
      typeof task.status !== 'string' ||
      (task.retryable !== undefined && typeof task.retryable !== 'boolean') ||
      (task.latest_retry !== undefined &&
        task.latest_retry !== null &&
        (typeof task.latest_retry !== 'object' ||
          typeof task.latest_retry.workflow_run_id !== 'string' ||
          typeof task.latest_retry.task_id !== 'string' ||
          typeof task.latest_retry.status !== 'string')) ||
      (task.output_count !== null &&
        (!Number.isInteger(task.output_count) || task.output_count < 1 || task.output_count > 16))
    ) {
      throw new Error('Workflow snapshot is invalid');
    }
  }
  for (const artifact of snapshot.artifacts) {
    if (
      typeof artifact !== 'object' ||
      artifact === null ||
      typeof artifact.id !== 'string' ||
      typeof artifact.task_id !== 'string' ||
      typeof artifact.type !== 'string' ||
      !['private', 'shared', 'public'].includes(artifact.visibility) ||
      !Number.isInteger(artifact.publication_revision) ||
      (artifact.output_index !== null &&
        (!Number.isInteger(artifact.output_index) ||
          artifact.output_index < 0 ||
          artifact.output_index >= 16)) ||
      typeof artifact.created_at !== 'string'
    ) {
      throw new Error('Workflow snapshot is invalid');
    }
  }
  return snapshot as WorkflowSnapshot;
}
