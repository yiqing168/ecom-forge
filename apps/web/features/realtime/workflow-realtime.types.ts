export type { RealtimeConnectionStatus } from './realtime.client';
import type { RealtimeConnectionStatus } from './realtime.client';

export interface WorkflowSnapshot {
  workflow_run: {
    id: string;
    status: string;
    trigger_mode: string;
    created_at: string;
    finished_at: string | null;
  };
  tasks: Array<{
    id: string;
    type: string;
    status: string;
    error_code: string | null;
    output_count: number | null;
    retryable?: boolean;
    latest_retry?: {
      workflow_run_id: string;
      task_id: string;
      status: string;
    } | null;
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
    latest_attempt: { id: string; attempt_no: number; status: string } | null;
  }>;
  last_event_seq: number;
  credit_summary: unknown;
  artifacts: Array<{
    id: string;
    task_id: string;
    type: string;
    visibility: 'private' | 'shared' | 'public';
    publication_revision: number;
    output_index: number | null;
    created_at: string;
  }>;
}

export interface WorkflowRealtimeEvent {
  schema_version: 1;
  scope: string;
  event_seq: number;
  event_type:
    | 'workflow.created'
    | 'workflow.status_changed'
    | 'task.status_changed'
    | 'artifact.created'
    | 'credit.settled'
    | 'credit.released';
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface RealtimeCallbacks {
  onStatus(status: RealtimeConnectionStatus): void;
  onSnapshot(snapshot: WorkflowSnapshot): void;
  onEvent(event: WorkflowRealtimeEvent): void;
  onAuthenticationRequired(): void;
  onUnavailable(): void;
}
