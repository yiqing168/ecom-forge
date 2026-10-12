import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchBackoffMs, QueueDispatcher } from './dispatcher.js';

describe('dispatcher backoff', () => {
  it('grows exponentially and applies deterministic jitter', () => {
    expect(
      dispatchBackoffMs({ attemptCount: 0, baseMs: 1_000, maxMs: 60_000, random: () => 0.5 }),
    ).toBe(1_000);
    expect(
      dispatchBackoffMs({ attemptCount: 3, baseMs: 1_000, maxMs: 60_000, random: () => 0.5 }),
    ).toBe(8_000);
  });

  it('never exceeds the configured maximum', () => {
    expect(
      dispatchBackoffMs({ attemptCount: 30, baseMs: 1_000, maxMs: 60_000, random: () => 1 }),
    ).toBe(60_000);
  });

  it('never schedules below the configured base', () => {
    expect(
      dispatchBackoffMs({ attemptCount: 0, baseMs: 1_000, maxMs: 60_000, random: () => 0 }),
    ).toBe(1_000);
  });
});

describe('QueueDispatcher write fence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs the underlying queue error before scheduling a retry', async () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const intents = {
      claimPending: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000001',
          queueName: 'agent',
          jobId: '00000000-0000-4000-8000-000000000002',
          aggregateType: 'agent_turn',
          aggregateId: '00000000-0000-4000-8000-000000000003',
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            job_type: 'agent.continue',
            trace_id: '00000000-0000-4000-8000-000000000004',
            session_id: '00000000-0000-4000-8000-000000000005',
            turn_id: '00000000-0000-4000-8000-000000000003',
            turn_revision: 1,
            continuation_no: 1,
            user_message_id: '00000000-0000-4000-8000-000000000006',
          },
          status: 'dispatching',
          attemptCount: 2,
          nextAttemptAt: new Date(),
          leaseOwner: 'owner',
          leaseExpiresAt: new Date(Date.now() + 30_000),
          lastErrorCode: 'QUEUE_ADD_FAILED',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      renewLease: vi.fn().mockResolvedValue(true),
      releaseForRetry: vi.fn().mockResolvedValue(true),
    };
    const publisher = {
      add: vi.fn().mockRejectedValue(new Error('Redis connection is closed')),
    };
    const dispatcher = new QueueDispatcher(
      intents as never,
      publisher as never,
      {
        dispatchLeaseMs: 30_000,
        dispatchLeaseRenewMs: 10_000,
        dispatchBatchSize: 100,
        dispatchBackoffBaseMs: 1_000,
        dispatchBackoffMaxMs: 60_000,
      } as never,
      undefined,
      logger,
    );

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({ retryScheduled: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'queue_dispatch_failed',
        error_code: 'QUEUE_ADD_FAILED',
        error_name: 'Error',
        error_message: 'Redis connection is closed',
      }),
    );
  });

  it('does not update an intent after publishing when the worker lost write authority', async () => {
    let writesAllowed = true;
    const intents = {
      claimPending: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000001',
          queueName: 'workflow',
          jobId: '00000000-0000-4000-8000-000000000002',
          aggregateType: 'workflow_run',
          aggregateId: '00000000-0000-4000-8000-000000000002',
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            job_type: 'workflow.advance',
            trace_id: '00000000-0000-4000-8000-000000000003',
            workflow_run_id: '00000000-0000-4000-8000-000000000002',
            user_id: '00000000-0000-4000-8000-000000000004',
          },
          status: 'dispatching',
          attemptCount: 0,
          nextAttemptAt: new Date(),
          leaseOwner: 'owner',
          leaseExpiresAt: new Date(Date.now() + 30_000),
          lastErrorCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      markDispatched: vi.fn(),
      renewLease: vi.fn().mockResolvedValue(true),
      cancelPoison: vi.fn(),
      releaseForRetry: vi.fn(),
    };
    const publisher = {
      add: vi.fn().mockImplementation(() => {
        writesAllowed = false;
        return Promise.resolve();
      }),
      close: vi.fn(),
    };
    const dispatcher = new QueueDispatcher(
      intents as never,
      publisher,
      {
        dispatchLeaseMs: 30_000,
        dispatchBatchSize: 100,
        dispatchBackoffBaseMs: 1_000,
        dispatchBackoffMaxMs: 60_000,
      } as never,
      () => writesAllowed,
    );

    const summary = await dispatcher.dispatchOnce();

    expect(summary.ownerLost).toBe(1);
    expect(intents.markDispatched).not.toHaveBeenCalled();
    expect(intents.releaseForRetry).not.toHaveBeenCalled();
  });

  it('renews a lease while a queue publish is in flight', async () => {
    vi.useFakeTimers();
    let resolvePublish: (() => void) | undefined;
    const intents = {
      claimPending: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000001',
          queueName: 'workflow',
          jobId: '00000000-0000-4000-8000-000000000002',
          aggregateType: 'workflow_run',
          aggregateId: '00000000-0000-4000-8000-000000000002',
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            job_type: 'workflow.advance',
            trace_id: '00000000-0000-4000-8000-000000000003',
            workflow_run_id: '00000000-0000-4000-8000-000000000002',
            user_id: '00000000-0000-4000-8000-000000000004',
          },
          status: 'dispatching',
          attemptCount: 0,
          nextAttemptAt: new Date(),
          leaseOwner: 'owner',
          leaseExpiresAt: new Date(Date.now() + 30_000),
          lastErrorCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      renewLease: vi.fn().mockResolvedValue(true),
      markDispatched: vi.fn().mockResolvedValue(true),
    };
    const publisher = {
      add: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePublish = resolve;
          }),
      ),
    };
    const dispatcher = new QueueDispatcher(
      intents as never,
      publisher as never,
      {
        dispatchLeaseMs: 1_000,
        dispatchLeaseRenewMs: 100,
        dispatchBatchSize: 100,
        dispatchBackoffBaseMs: 1_000,
        dispatchBackoffMaxMs: 60_000,
      } as never,
    );

    const dispatch = dispatcher.dispatchOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(intents.renewLease).toHaveBeenCalled();
    resolvePublish?.();
    await expect(dispatch).resolves.toMatchObject({ dispatched: 1 });
  });

  it('stops writing when lease renewal loses ownership', async () => {
    vi.useFakeTimers();
    let resolvePublish: (() => void) | undefined;
    const intents = {
      claimPending: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000001',
          queueName: 'workflow',
          jobId: '00000000-0000-4000-8000-000000000002',
          aggregateType: 'workflow_run',
          aggregateId: '00000000-0000-4000-8000-000000000002',
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            job_type: 'workflow.advance',
            trace_id: '00000000-0000-4000-8000-000000000003',
            workflow_run_id: '00000000-0000-4000-8000-000000000002',
            user_id: '00000000-0000-4000-8000-000000000004',
          },
          status: 'dispatching',
          attemptCount: 0,
          nextAttemptAt: new Date(),
          leaseOwner: 'owner',
          leaseExpiresAt: new Date(Date.now() + 30_000),
          lastErrorCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      renewLease: vi.fn().mockResolvedValue(false),
      markDispatched: vi.fn(),
    };
    const publisher = {
      add: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolvePublish = resolve;
          }),
      ),
    };
    const dispatcher = new QueueDispatcher(
      intents as never,
      publisher as never,
      {
        dispatchLeaseMs: 1_000,
        dispatchLeaseRenewMs: 100,
        dispatchBatchSize: 100,
        dispatchBackoffBaseMs: 1_000,
        dispatchBackoffMaxMs: 60_000,
      } as never,
    );

    const dispatch = dispatcher.dispatchOnce();
    await vi.advanceTimersByTimeAsync(100);
    resolvePublish?.();
    await expect(dispatch).resolves.toMatchObject({ ownerLost: 1, dispatched: 0 });
    expect(intents.markDispatched).not.toHaveBeenCalled();
  });
});
