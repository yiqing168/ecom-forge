'use client';

import { useEffect, useRef, useState } from 'react';

import { WorkflowRealtimeClient } from './workflow-realtime.client';
import { applyWorkflowEvent } from './workflow-realtime.reducer';
import type { RealtimeConnectionStatus, WorkflowSnapshot } from './workflow-realtime.types';

export interface UseWorkflowRealtimeOptions {
  onAuthenticationRequired?: () => void;
  onUnavailable?: () => void;
}

export function useWorkflowRealtimeCollection(
  workflowRunIds: readonly string[],
  options: UseWorkflowRealtimeOptions = {},
) {
  const [snapshots, setSnapshots] = useState<Record<string, WorkflowSnapshot>>({});
  const clientsRef = useRef(new Map<string, WorkflowRealtimeClient>());
  const snapshotsRef = useRef(new Map<string, WorkflowSnapshot>());
  const authCallbackRef = useRef(options.onAuthenticationRequired);
  const unavailableCallbackRef = useRef(options.onUnavailable);
  authCallbackRef.current = options.onAuthenticationRequired;
  unavailableCallbackRef.current = options.onUnavailable;
  const workflowKey = [...new Set(workflowRunIds)].sort().join('|');

  useEffect(() => {
    const desiredIds = new Set(workflowKey ? workflowKey.split('|') : []);
    for (const [workflowRunId, client] of clientsRef.current) {
      if (desiredIds.has(workflowRunId)) continue;
      client.stop();
      clientsRef.current.delete(workflowRunId);
      snapshotsRef.current.delete(workflowRunId);
    }
    for (const workflowRunId of desiredIds) {
      if (clientsRef.current.has(workflowRunId)) continue;
      const client = new WorkflowRealtimeClient(workflowRunId, {
        onStatus() {},
        onSnapshot(next) {
          snapshotsRef.current.set(workflowRunId, next);
          setSnapshots(Object.fromEntries(snapshotsRef.current));
          if (isTerminalWorkflow(next)) clientsRef.current.get(workflowRunId)?.stop();
        },
        onEvent(event) {
          const current = snapshotsRef.current.get(workflowRunId);
          if (!current) throw new Error('Workflow event arrived before its snapshot');
          const next = applyWorkflowEvent(current, event);
          snapshotsRef.current.set(workflowRunId, next);
          setSnapshots(Object.fromEntries(snapshotsRef.current));
        },
        onAuthenticationRequired() {
          authCallbackRef.current?.();
        },
        onUnavailable() {
          unavailableCallbackRef.current?.();
        },
      });
      clientsRef.current.set(workflowRunId, client);
      void client.start();
    }
    setSnapshots(Object.fromEntries(snapshotsRef.current));
  }, [workflowKey]);

  useEffect(
    () => () => {
      for (const client of clientsRef.current.values()) client.stop();
      clientsRef.current.clear();
      snapshotsRef.current.clear();
    },
    [],
  );

  return { snapshots };
}

function isTerminalWorkflow(snapshot: WorkflowSnapshot): boolean {
  return ['succeeded', 'failed', 'cancelled', 'refunded'].includes(snapshot.workflow_run.status);
}

export function useWorkflowRealtime(
  workflowRunId: string | null,
  options: UseWorkflowRealtimeOptions = {},
) {
  const [status, setStatus] = useState<RealtimeConnectionStatus>('idle');
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const snapshotRef = useRef<WorkflowSnapshot | null>(null);
  const authCallbackRef = useRef(options.onAuthenticationRequired);
  const unavailableCallbackRef = useRef(options.onUnavailable);
  authCallbackRef.current = options.onAuthenticationRequired;
  unavailableCallbackRef.current = options.onUnavailable;

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    if (!workflowRunId) {
      setStatus('idle');
      return;
    }
    const client = new WorkflowRealtimeClient(workflowRunId, {
      onStatus: setStatus,
      onSnapshot(next) {
        snapshotRef.current = next;
        setSnapshot(next);
      },
      onEvent(event) {
        const current = snapshotRef.current;
        if (!current) throw new Error('Workflow event arrived before its snapshot');
        const next = applyWorkflowEvent(current, event);
        snapshotRef.current = next;
        setSnapshot(next);
      },
      onAuthenticationRequired() {
        authCallbackRef.current?.();
      },
      onUnavailable() {
        unavailableCallbackRef.current?.();
      },
    });
    void client.start();
    return () => client.stop();
  }, [workflowRunId]);

  return { snapshot, status };
}
