import { describe, expect, it, vi } from 'vitest';

import { ensureQueueRecoveryReady, QueueReconciler } from './reconciler.js';

const workflowPayload = {
  schema_version: 1,
  job_type: 'workflow.advance',
  trace_id: '00000000-0000-4000-8000-000000000003',
  workflow_run_id: '00000000-0000-4000-8000-000000000002',
  user_id: '00000000-0000-4000-8000-000000000004',
} as const;

const taskPayload = {
  schema_version: 1,
  job_type: 'task.execute',
  trace_id: '00000000-0000-4000-8000-000000000003',
  task_id: '00000000-0000-4000-8000-000000000005',
  workflow_run_id: '00000000-0000-4000-8000-000000000002',
  user_id: '00000000-0000-4000-8000-000000000004',
} as const;

const moderationPayload = {
  schema_version: 4,
  job_type: 'moderation.execute',
  trace_id: '00000000-0000-4000-8000-000000000003',
  task_id: '00000000-0000-4000-8000-000000000008',
  workflow_run_id: '00000000-0000-4000-8000-000000000002',
  user_id: '00000000-0000-4000-8000-000000000004',
} as const;

const pollPayload = {
  schema_version: 1,
  job_type: 'provider.poll',
  trace_id: '00000000-0000-4000-8000-000000000003',
  task_attempt_id: '00000000-0000-4000-8000-000000000006',
  poll_no: 2,
} as const;

const callbackPayload = {
  schema_version: 1,
  job_type: 'provider.callback.process',
  trace_id: '00000000-0000-4000-8000-000000000003',
  provider_callback_event_id: '00000000-0000-4000-8000-000000000007',
  processing_no: 2,
} as const;

function intent(
  payload:
    | typeof workflowPayload
    | typeof taskPayload
    | typeof moderationPayload
    | typeof pollPayload
    | typeof callbackPayload,
) {
  const providerPayload =
    payload.job_type === 'provider.poll' || payload.job_type === 'provider.callback.process';
  return {
    id: '00000000-0000-4000-8000-000000000001',
    queueName:
      payload.job_type === 'workflow.advance'
        ? 'workflow'
        : payload.job_type === 'moderation.execute'
          ? 'moderation'
          : providerPayload
            ? 'provider-callback'
            : 'task',
    jobId:
      payload.job_type === 'workflow.advance'
        ? payload.workflow_run_id
        : payload.job_type === 'task.execute'
          ? payload.task_id
          : payload.job_type === 'moderation.execute'
            ? payload.task_id
            : payload.job_type === 'provider.poll'
              ? payload.task_attempt_id
              : payload.provider_callback_event_id,
    aggregateType:
      payload.job_type === 'workflow.advance'
        ? 'workflow_run'
        : payload.job_type === 'provider.callback.process'
          ? 'provider_callback_event'
          : payload.job_type === 'provider.poll'
            ? 'task_attempt'
            : 'task',
    aggregateId:
      payload.job_type === 'workflow.advance'
        ? payload.workflow_run_id
        : payload.job_type === 'task.execute'
          ? payload.task_id
          : payload.job_type === 'moderation.execute'
            ? payload.task_id
            : payload.job_type === 'provider.poll'
              ? payload.task_attempt_id
              : payload.provider_callback_event_id,
    payloadVersion: payload.schema_version,
    payload,
    status: 'dispatched',
    attemptCount: 0,
    nextAttemptAt: new Date(0),
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function redisFixture(initialReady = false) {
  let ready = initialReady;
  return {
    status: 'ready',
    ping: vi.fn().mockResolvedValue('PONG'),
    connect: vi.fn(),
    get: vi.fn().mockImplementation(() => Promise.resolve(ready ? 'ready' : null)),
    set: vi.fn().mockImplementation(() => {
      ready = true;
      return Promise.resolve('OK');
    }),
  };
}

function reservedFixture(ownsLock = true) {
  return {
    unsafe: vi.fn().mockImplementation((query: string) => {
      if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ locked: ownsLock }]);
      return Promise.resolve([{ unlocked: true }]);
    }),
    release: vi.fn(),
  };
}

function config() {
  return { redisPrefix: 's05-test-reconcile' } as never;
}

describe('QueueReconciler', () => {
  it('keeps the control plane closed while another owner is still reconciling', async () => {
    const reconciler = {
      isReady: vi.fn().mockResolvedValue(false),
      reconcile: vi.fn().mockResolvedValue({ status: 'not_owner' }),
    };

    await expect(ensureQueueRecoveryReady(reconciler as never)).resolves.toMatchObject({
      ready: false,
      reconciliation: { status: 'not_owner' },
    });
  });

  it('opens the control plane only after reconciliation writes the sentinel', async () => {
    const reconciler = {
      isReady: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      reconcile: vi.fn().mockResolvedValue({ status: 'completed' }),
    };

    await expect(ensureQueueRecoveryReady(reconciler as never)).resolves.toMatchObject({
      ready: true,
      reconciliation: { status: 'completed' },
    });
  });

  it('does no database work when the recovery sentinel is ready', async () => {
    const redis = redisFixture(true);
    const databaseClient = { reserve: vi.fn() };
    const reconciler = new QueueReconciler(
      {} as never,
      databaseClient as never,
      redis as never,
      {} as never,
      {} as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ status: 'already_ready' });
    expect(databaseClient.reserve).not.toHaveBeenCalled();
  });

  it('returns not_owner when another reconciler owns the session lock', async () => {
    const reserved = reservedFixture(false);
    const reconciler = new QueueReconciler(
      {} as never,
      { reserve: vi.fn().mockResolvedValue(reserved) } as never,
      redisFixture() as never,
      {} as never,
      {} as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ status: 'not_owner' });
    expect(reserved.release).toHaveBeenCalledOnce();
  });

  it('can resume after a crash before writing the sentinel', async () => {
    const redis = redisFixture();
    const reserved = reservedFixture();
    const intents = {
      listDispatchedPage: vi
        .fn()
        .mockResolvedValueOnce([intent(workflowPayload)])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([intent(workflowPayload)])
        .mockResolvedValueOnce([]),
    };
    const publisher = { add: vi.fn().mockResolvedValue(undefined) };
    const database = {
      query: {
        workflowRuns: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ id: workflowPayload.workflow_run_id, status: 'queued' }),
        },
      },
    };
    const reconciler = new QueueReconciler(
      database as never,
      { reserve: vi.fn().mockResolvedValue(reserved) } as never,
      redis as never,
      intents as never,
      publisher as never,
      config(),
    );

    await expect(
      reconciler.reconcile({ beforeSentinel: () => Promise.reject(new Error('crash')) }),
    ).rejects.toThrow('crash');
    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'completed',
      rebuilt: 1,
    });
    expect(publisher.add).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledOnce();
  });

  it('does not rebuild accepted task attempts', async () => {
    const latestAttempt = {
      status: 'accepted',
      dispatchState: 'accepted',
    };
    const queryBuilder = {
      from: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn().mockResolvedValue([latestAttempt]),
    };
    queryBuilder.from.mockReturnValue(queryBuilder);
    queryBuilder.where.mockReturnValue(queryBuilder);
    queryBuilder.orderBy.mockReturnValue(queryBuilder);
    const database = {
      query: {
        tasks: {
          findFirst: vi.fn().mockResolvedValue({ id: taskPayload.task_id, status: 'running' }),
        },
      },
      select: vi.fn().mockReturnValue(queryBuilder),
    };
    const intents = {
      listDispatchedPage: vi
        .fn()
        .mockResolvedValueOnce([intent(taskPayload)])
        .mockResolvedValueOnce([]),
    };
    const publisher = { add: vi.fn() };
    const reconciler = new QueueReconciler(
      database as never,
      { reserve: vi.fn().mockResolvedValue(reservedFixture()) } as never,
      redisFixture() as never,
      intents as never,
      publisher as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'completed',
      rebuilt: 0,
      skippedProtected: 1,
    });
    expect(publisher.add).not.toHaveBeenCalled();
  });

  it('rebuilds an eligible v4 moderation job on its dedicated queue', async () => {
    const database = {
      query: {
        tasks: {
          findFirst: vi.fn().mockResolvedValue({
            id: moderationPayload.task_id,
            type: 'moderation.image',
            status: 'queued',
          }),
        },
      },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      }),
    };
    const intents = {
      listDispatchedPage: vi
        .fn()
        .mockResolvedValueOnce([intent(moderationPayload)])
        .mockResolvedValueOnce([]),
    };
    const publisher = { add: vi.fn().mockResolvedValue(undefined) };
    const reconciler = new QueueReconciler(
      database as never,
      { reserve: vi.fn().mockResolvedValue(reservedFixture()) } as never,
      redisFixture() as never,
      intents as never,
      publisher as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ rebuilt: 1 });
    expect(publisher.add).toHaveBeenCalledWith(
      'moderation',
      moderationPayload.task_id,
      moderationPayload,
      undefined,
    );
  });

  it('protects a v4 moderation payload that points at a non-moderation task', async () => {
    const database = {
      query: {
        tasks: {
          findFirst: vi.fn().mockResolvedValue({
            id: moderationPayload.task_id,
            type: 'image.edit',
            status: 'queued',
          }),
        },
      },
    };
    const intents = {
      listDispatchedPage: vi
        .fn()
        .mockResolvedValueOnce([intent(moderationPayload)])
        .mockResolvedValueOnce([]),
    };
    const publisher = { add: vi.fn() };
    const reconciler = new QueueReconciler(
      database as never,
      { reserve: vi.fn().mockResolvedValue(reservedFixture()) } as never,
      redisFixture() as never,
      intents as never,
      publisher as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      rebuilt: 0,
      skippedProtected: 1,
    });
    expect(publisher.add).not.toHaveBeenCalled();
  });

  it('rebuilds only the current provider poll and callback sequence', async () => {
    const database = {
      query: {
        taskAttempts: {
          findFirst: vi.fn().mockResolvedValue({
            id: pollPayload.task_attempt_id,
            status: 'polling',
            dispatchState: 'accepted',
            pollCount: 1,
          }),
        },
        providerCallbackEvents: {
          findFirst: vi.fn().mockResolvedValue({
            id: callbackPayload.provider_callback_event_id,
            status: 'dead_letter',
            processingCount: 1,
            nextProcessAt: new Date(),
          }),
        },
      },
    };
    const intents = {
      listDispatchedPage: vi
        .fn()
        .mockResolvedValueOnce([intent(pollPayload), intent(callbackPayload)])
        .mockResolvedValueOnce([]),
    };
    const publisher = { add: vi.fn().mockResolvedValue(undefined) };
    const reconciler = new QueueReconciler(
      database as never,
      { reserve: vi.fn().mockResolvedValue(reservedFixture()) } as never,
      redisFixture() as never,
      intents as never,
      publisher as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({ rebuilt: 2 });
    expect(publisher.add).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild stale provider poll or terminal callback intents', async () => {
    const database = {
      query: {
        taskAttempts: {
          findFirst: vi.fn().mockResolvedValue({
            id: pollPayload.task_attempt_id,
            status: 'succeeded',
            dispatchState: 'accepted',
            pollCount: 2,
          }),
        },
        providerCallbackEvents: {
          findFirst: vi.fn().mockResolvedValue({
            id: callbackPayload.provider_callback_event_id,
            status: 'dead_letter',
            processingCount: 2,
            nextProcessAt: null,
          }),
        },
      },
    };
    const intents = {
      listDispatchedPage: vi
        .fn()
        .mockResolvedValueOnce([intent(pollPayload), intent(callbackPayload)])
        .mockResolvedValueOnce([]),
    };
    const publisher = { add: vi.fn() };
    const reconciler = new QueueReconciler(
      database as never,
      { reserve: vi.fn().mockResolvedValue(reservedFixture()) } as never,
      redisFixture() as never,
      intents as never,
      publisher as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      rebuilt: 0,
      skippedTerminal: 2,
    });
    expect(publisher.add).not.toHaveBeenCalled();
  });

  it('cancels a dispatched poison intent instead of blocking recovery', async () => {
    const poison = {
      ...intent(workflowPayload),
      payload: { schema_version: 999, job_type: 'workflow.advance' },
    };
    const intents = {
      listDispatchedPage: vi.fn().mockResolvedValueOnce([poison]).mockResolvedValueOnce([]),
      cancelDispatchedPoison: vi.fn().mockResolvedValue(true),
    };
    const reconciler = new QueueReconciler(
      {} as never,
      { reserve: vi.fn().mockResolvedValue(reservedFixture()) } as never,
      redisFixture() as never,
      intents as never,
      { add: vi.fn() } as never,
      config(),
    );

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      status: 'completed',
      poisonCancelled: 1,
    });
    expect(intents.cancelDispatchedPoison).toHaveBeenCalledWith(
      expect.objectContaining({
        id: poison.id,
        errorCode: 'QUEUE_SCHEMA_VERSION_UNSUPPORTED',
      }),
    );
  });
});
