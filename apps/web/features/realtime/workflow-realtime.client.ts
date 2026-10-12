import { ScopedRealtimeClient } from './realtime.client';
import type { RealtimeCallbacks, WorkflowRealtimeEvent } from './workflow-realtime.types';
import { parseWorkflowEvent, parseWorkflowSnapshot } from './workflow-realtime.validation';

export interface WorkflowRealtimeClientOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  random?: () => number;
}

export class WorkflowRealtimeClient {
  private readonly client: ScopedRealtimeClient<
    ReturnType<typeof parseWorkflowSnapshot>,
    WorkflowRealtimeEvent
  >;

  constructor(
    workflowRunId: string,
    callbacks: RealtimeCallbacks,
    options: WorkflowRealtimeClientOptions = {},
  ) {
    this.client = new ScopedRealtimeClient({
      scope: `workflow_run:${workflowRunId}`,
      snapshotUrl: `/api/v1/workflow-runs/${encodeURIComponent(workflowRunId)}`,
      parseSnapshot(value) {
        const snapshot = parseWorkflowSnapshot(value);
        if (snapshot.workflow_run.id !== workflowRunId) {
          throw new Error('Workflow snapshot identity does not match the request');
        }
        return snapshot;
      },
      snapshotCursor: (snapshot) => snapshot.last_event_seq,
      parseEvent: parseWorkflowEvent,
      callbacks,
      refreshSnapshotAfterEvent: (event) =>
        event.event_type === 'workflow.status_changed' ||
        event.event_type === 'task.status_changed' ||
        event.event_type === 'artifact.created' ||
        event.event_type === 'credit.settled' ||
        event.event_type === 'credit.released',
      ...options,
    });
  }

  start(): Promise<void> {
    return this.client.start();
  }

  stop(): void {
    this.client.stop();
  }
}
