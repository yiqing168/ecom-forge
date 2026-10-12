'use client';

import { useEffect, useState } from 'react';

import { RealtimeStatus } from './realtime-status';
import { useWorkflowRealtime } from './use-workflow-realtime';

export function RealtimeLiveHarness({ workflowRunId }: { workflowRunId: string }) {
  const [hydrated, setHydrated] = useState(false);
  const { snapshot, status } = useWorkflowRealtime(workflowRunId);
  useEffect(() => setHydrated(true), []);

  return (
    <main
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-6 py-12"
      id="main-content"
    >
      <header>
        <h1 className="text-2xl font-semibold">S06 realtime probe</h1>
        <RealtimeStatus status={status} />
        <output data-testid="hydration-status">{hydrated ? 'hydrated' : 'server'}</output>
        <output data-testid="connection-status">{status}</output>
      </header>
      <dl className="grid grid-cols-2 gap-3">
        <dt>Workflow status</dt>
        <dd data-testid="workflow-status">{snapshot?.workflow_run.status ?? 'loading'}</dd>
        <dt>Last event sequence</dt>
        <dd data-testid="last-event-seq">{snapshot?.last_event_seq ?? 'loading'}</dd>
      </dl>
      <ul aria-label="Workflow tasks" data-testid="task-list">
        {snapshot?.tasks.map((task) => (
          <li className="flex justify-between py-2" data-task-id={task.id} key={task.id}>
            <span>{task.type}</span>
            <output data-testid={`task-status-${task.id}`}>{task.status}</output>
          </li>
        ))}
      </ul>
    </main>
  );
}
