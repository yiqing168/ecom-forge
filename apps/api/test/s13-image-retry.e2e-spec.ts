import { randomUUID } from 'node:crypto';

import {
  creditAccounts,
  creditLedger,
  creditReservations,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  models,
  providerCircuitStates,
  queueDispatchIntents,
  runQuotes,
  taskAttempts,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import { releaseReservationInTransaction } from '@ecom-forge/credit';
import { NOOP_EVENT_WAKE_PUBLISHER } from '@ecom-forge/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { WorkflowRetryService } from '../src/modules/workflow/workflow-retry.service.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';

function assertIsolatedDatabase(): void {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
  if (!/_test(?:_|$)/.test(name)) {
    throw new Error('S13 image retry tests require a database name containing _test');
  }
}

assertIsolatedDatabase();

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const service = new WorkflowRetryService(resource.db, NOOP_EVENT_WAKE_PUBLISHER);
const trackedUsers = new Set<string>();

async function createFixture(input: {
  attemptStatus?: 'failed' | 'outcome_unknown' | 'timeout';
  dispatchState?: 'accepted' | 'not_dispatched' | 'outcome_unknown';
  outputCount?: number;
  balance?: string;
}) {
  const id = randomUUID();
  const evidenceDigest = 'e'.repeat(64);
  const dispatchState = input.dispatchState ?? 'accepted';
  const attemptStatus =
    input.attemptStatus ?? (dispatchState === 'outcome_unknown' ? 'outcome_unknown' : 'failed');
  const isOutcomeUnknown =
    attemptStatus === 'outcome_unknown' && dispatchState === 'outcome_unknown';
  const balance = input.balance ?? '10.00';
  const [user] = await resource.db
    .insert(users)
    .values({
      id,
      email: `s13-retry-${id}@example.test`,
      displayName: 'S13 retry integration user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create retry user');
  trackedUsers.add(user.id);
  await resource.db.insert(creditAccounts).values({
    userId: user.id,
    balance,
    frozen: '0.00',
    version: balance === '0.00' ? 0 : 1,
  });
  if (balance !== '0.00') {
    await resource.db.insert(creditLedger).values({
      userId: user.id,
      type: 'grant',
      amount: balance,
      idempotencyKey: `s13-retry-grant:${user.id}`,
      accountVersion: 1,
      balanceAfter: balance,
      frozenAfter: '0.00',
      metadata: { test_run_id: user.id },
    });
  }
  const [model] = await resource.db
    .insert(models)
    .values({
      provider: `s13-retry-${id}`,
      modelId: 'image-model',
      version: '1',
      capabilityContractJson: {},
      pricingJson: {},
      quotaJson: {},
      status: 'poc_passed',
      statusEvidenceDigest: evidenceDigest,
    })
    .returning();
  if (!model) throw new Error('Failed to create retry model');
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId: user.id,
      triggerMode: 'chat',
      status: isOutcomeUnknown ? 'running' : 'failed',
      planSnapshot: {},
      skillSnapshot: { primary_skill_id: 'minimal-scene-collage@1.0.0' },
      pricingSnapshot: { schema_version: 1 },
      ...(isOutcomeUnknown ? {} : { finishedAt: new Date() }),
    })
    .returning();
  if (!workflow) throw new Error('Failed to create source workflow');
  const [task] = await resource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow.id,
      type: 'image.edit',
      status: isOutcomeUnknown ? 'waiting_manual_review' : 'failed',
      modelId: model.id,
      modelVersion: model.version,
      costEstimate: '1.00',
      idempotencyKey: `s13-retry-source-task:${id}`,
      dagNodeId: 'source-image',
      dagJson: { node_id: 'source-image', depends_on: [] },
      paramsSnapshot: {
        source: 'chat',
        operation_key: 'a'.repeat(64),
        output_count: input.outputCount ?? 1,
        output_count_source: 'skill_default',
        input_bindings: [],
        creative_prompt: 'Frozen source-specific Provider prompt',
        model_snapshot: {
          id: model.id,
          provider: model.provider,
          model_id: model.modelId,
          version: model.version,
          status_evidence_digest: evidenceDigest,
        },
      },
      errorCode: 'PROVIDER_FAILED',
      endedAt: new Date(),
    })
    .returning();
  if (!task) throw new Error('Failed to create source task');
  await resource.db.insert(taskAttempts).values({
    taskId: task.id,
    attemptNo: 1,
    status: attemptStatus,
    dispatchState,
    provider: model.provider,
    endedAt: new Date(),
  });
  return { model, task, user, workflow };
}

async function cleanupUser(userId: string): Promise<void> {
  const userWorkflows = await resource.db.query.workflowRuns.findMany({
    where: eq(workflowRuns.userId, userId),
    columns: { id: true },
  });
  const workflowIds = userWorkflows.map((workflow) => workflow.id);
  const userTasks =
    workflowIds.length > 0
      ? await resource.db.query.tasks.findMany({
          where: inArray(tasks.workflowRunId, workflowIds),
          columns: { id: true },
        })
      : [];
  const taskIds = userTasks.map((task) => task.id);
  const aggregateIds = [...workflowIds, ...taskIds];
  if (workflowIds.length > 0) {
    await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, workflowIds));
  }
  if (aggregateIds.length > 0) {
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, aggregateIds));
  }
  await resource.db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  if (taskIds.length > 0) {
    // The cross-user boundary regression fixture intentionally creates this invalid graph.
    await resource.db
      .update(tasks)
      .set({ parentTaskId: null })
      .where(inArray(tasks.parentTaskId, taskIds));
    await resource.db.delete(taskAttempts).where(inArray(taskAttempts.taskId, taskIds));
    await resource.db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  await resource.db
    .update(runQuotes)
    .set({ workflowRunId: null })
    .where(eq(runQuotes.userId, userId));
  await resource.db
    .update(creditReservations)
    .set({ workflowRunId: null })
    .where(eq(creditReservations.userId, userId));
  if (workflowIds.length > 0) {
    await resource.db.delete(workflowRuns).where(inArray(workflowRuns.id, workflowIds));
  }
  await resource.db.delete(creditReservations).where(eq(creditReservations.userId, userId));
  await resource.db.delete(runQuotes).where(eq(runQuotes.userId, userId));
  await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
  const provider = `s13-retry-${userId}`;
  const userModels = await resource.db.query.models.findMany({
    where: eq(models.provider, provider),
    columns: { id: true },
  });
  const modelIds = userModels.map((model) => model.id);
  if (modelIds.length > 0) {
    await resource.db
      .delete(providerCircuitStates)
      .where(eq(providerCircuitStates.provider, provider));
    await resource.db.delete(models).where(inArray(models.id, modelIds));
  }
  await resource.db.delete(users).where(eq(users.id, userId));
}

afterEach(async () => {
  for (const userId of trackedUsers) await cleanupUser(userId);
  trackedUsers.clear();
});

afterAll(async () => {
  await resource.client.end();
});

describe('S13 failed image retry transaction', () => {
  it('does not reuse an expired quote left by a provider circuit rejection', async () => {
    const fixture = await createFixture({});
    await resource.db.insert(providerCircuitStates).values({
      scopeType: 'model',
      scopeKey: `model:${fixture.model.id}`,
      provider: fixture.model.provider,
      modelId: fixture.model.id,
      status: 'open',
      reasonCode: 'provider_auth_failed',
    });

    await expect(
      service.retryFailedImage({
        userId: fixture.user.id,
        workflowRunId: fixture.workflow.id,
        taskId: fixture.task.id,
        idempotencyKey: `s13-circuit-open-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    const staleQuote = await resource.db.query.runQuotes.findFirst({
      where: eq(runQuotes.userId, fixture.user.id),
    });
    expect(staleQuote?.status).toBe('quoted');
    if (!staleQuote) throw new Error('Retry quote was not created');
    await resource.db
      .update(runQuotes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(runQuotes.id, staleQuote.id));
    await resource.db
      .update(providerCircuitStates)
      .set({ status: 'closed', reasonCode: null })
      .where(eq(providerCircuitStates.scopeKey, `model:${fixture.model.id}`));

    const retry = await service.retryFailedImage({
      userId: fixture.user.id,
      workflowRunId: fixture.workflow.id,
      taskId: fixture.task.id,
      idempotencyKey: `s13-circuit-recovered-${randomUUID()}`,
    });
    expect(retry.replayed).toBe(false);
    expect(
      await resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.id, staleQuote.id) }),
    ).toMatchObject({ status: 'expired' });
    expect(
      await resource.db.query.runQuotes.findMany({ where: eq(runQuotes.userId, fixture.user.id) }),
    ).toHaveLength(2);
    expect(
      await resource.db.query.tasks.findFirst({ where: eq(tasks.id, retry.task_id) }),
    ).toMatchObject({ workflowRunId: retry.workflow_run_id, parentTaskId: fixture.task.id });
  });

  it('deduplicates concurrent clicks into one charged workflow and one Provider task', async () => {
    const fixture = await createFixture({});

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.retryFailedImage({
          userId: fixture.user.id,
          workflowRunId: fixture.workflow.id,
          taskId: fixture.task.id,
          idempotencyKey: `s13-retry-click-${index}`,
        }),
      ),
    );

    expect(new Set(results.map((result) => result.workflow_run_id)).size).toBe(1);
    expect(new Set(results.map((result) => result.task_id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      await resource.db.query.workflowRuns.findMany({
        where: eq(workflowRuns.userId, fixture.user.id),
      }),
    ).toHaveLength(2);
    const retryTasks = await resource.db.query.tasks.findMany({
      where: eq(tasks.parentTaskId, fixture.task.id),
    });
    expect(retryTasks).toHaveLength(1);
    expect(retryTasks[0]?.paramsSnapshot).toMatchObject({
      creative_prompt: 'Frozen source-specific Provider prompt',
      output_count: 1,
    });
    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, fixture.user.id),
      }),
    ).toHaveLength(1);
    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, fixture.user.id),
    });
    expect(ledger.filter((entry) => entry.type === 'reservation_freeze')).toHaveLength(1);
    expect(
      await resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.user.id),
      }),
    ).toMatchObject({ balance: '9.00', frozen: '1.00' });
  });

  it('deduplicates explicit regeneration for an unknown result without rewriting the old attempt', async () => {
    const fixture = await createFixture({ dispatchState: 'outcome_unknown' });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.retryFailedImage({
          userId: fixture.user.id,
          workflowRunId: fixture.workflow.id,
          taskId: fixture.task.id,
          idempotencyKey: `s13-unknown-regenerate-${index}`,
        }),
      ),
    );

    expect(new Set(results.map((result) => result.workflow_run_id)).size).toBe(1);
    expect(new Set(results.map((result) => result.task_id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      await resource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, fixture.task.id),
      }),
    ).toMatchObject({ status: 'outcome_unknown', dispatchState: 'outcome_unknown' });
    expect(
      await resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.task.id) }),
    ).toMatchObject({ status: 'waiting_manual_review' });
    expect(
      await resource.db.query.tasks.findMany({ where: eq(tasks.parentTaskId, fixture.task.id) }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, fixture.user.id),
      }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.user.id),
      }),
    ).toMatchObject({ balance: '9.00', frozen: '1.00' });
  });

  it.each([
    ['multi-output task', { dispatchState: 'accepted' as const, outputCount: 2 }],
    [
      'invalid timeout/not-dispatched state',
      {
        attemptStatus: 'timeout' as const,
        dispatchState: 'not_dispatched' as const,
        outputCount: 1,
      },
    ],
  ])('does not charge or create a retry for a protected %s', async (_, input) => {
    const fixture = await createFixture(input);

    await expect(
      service.retryFailedImage({
        userId: fixture.user.id,
        workflowRunId: fixture.workflow.id,
        taskId: fixture.task.id,
        idempotencyKey: `s13-protected-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_PROTECTED' });

    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, fixture.user.id),
      }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.tasks.findMany({ where: eq(tasks.parentTaskId, fixture.task.id) }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.user.id),
      }),
    ).toMatchObject({ balance: '10.00', frozen: '0.00' });
  });

  it('rejects unknown-result regeneration when the user has no available credits', async () => {
    const fixture = await createFixture({ dispatchState: 'outcome_unknown', balance: '0.00' });

    await expect(
      service.retryFailedImage({
        userId: fixture.user.id,
        workflowRunId: fixture.workflow.id,
        taskId: fixture.task.id,
        idempotencyKey: `s13-unknown-no-credit-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, fixture.user.id),
      }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.tasks.findMany({ where: eq(tasks.parentTaskId, fixture.task.id) }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, fixture.task.id),
      }),
    ).toMatchObject({ status: 'outcome_unknown', dispatchState: 'outcome_unknown' });
  });

  it('rejects a cross-user retry without creating a quote or reservation', async () => {
    const source = await createFixture({});
    const other = await createFixture({});

    await expect(
      service.retryFailedImage({
        userId: other.user.id,
        workflowRunId: source.workflow.id,
        taskId: source.task.id,
        idempotencyKey: `s13-cross-user-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    expect(
      await resource.db.query.runQuotes.findMany({ where: eq(runQuotes.userId, other.user.id) }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, other.user.id),
      }),
    ).toHaveLength(0);
  });

  it("does not treat a foreign workflow child as this user's existing retry", async () => {
    const source = await createFixture({});
    const foreign = await createFixture({});
    const [foreignChild] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: foreign.workflow.id,
        parentTaskId: source.task.id,
        type: 'image.generate',
        status: 'queued',
        modelId: foreign.model.id,
        modelVersion: foreign.model.version,
        costEstimate: '1.00',
        idempotencyKey: `s13-foreign-child-${randomUUID()}`,
        dagNodeId: 'foreign-retry-child',
        dagJson: {},
        paramsSnapshot: {},
      })
      .returning({ id: tasks.id });
    if (!foreignChild) throw new Error('Failed to create foreign retry child');

    const retry = await service.retryFailedImage({
      userId: source.user.id,
      workflowRunId: source.workflow.id,
      taskId: source.task.id,
      idempotencyKey: `s13-foreign-child-${randomUUID()}`,
    });

    expect(retry.task_id).not.toBe(foreignChild.id);
    expect(
      await resource.db.query.tasks.findMany({
        where: eq(tasks.parentTaskId, source.task.id),
        columns: { id: true, workflowRunId: true },
      }),
    ).toEqual(
      expect.arrayContaining([{ id: foreignChild.id, workflowRunId: foreign.workflow.id }]),
    );
    expect(
      await resource.db.query.tasks.findFirst({ where: eq(tasks.id, retry.task_id) }),
    ).toMatchObject({ workflowRunId: retry.workflow_run_id, parentTaskId: source.task.id });
  });

  it('rejects a retry when a frozen source binding is no longer authorized', async () => {
    const fixture = await createFixture({});
    await resource.db
      .update(tasks)
      .set({
        paramsSnapshot: {
          ...(fixture.task.paramsSnapshot as Record<string, unknown>),
          input_bindings: [
            {
              kind: 'asset',
              object_id: randomUUID(),
              content_hash: 'f'.repeat(64),
            },
          ],
        },
      })
      .where(eq(tasks.id, fixture.task.id));

    await expect(
      service.retryFailedImage({
        userId: fixture.user.id,
        workflowRunId: fixture.workflow.id,
        taskId: fixture.task.id,
        idempotencyKey: `s13-stale-binding-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_STATE_INVALID' });

    expect(
      await resource.db.query.runQuotes.findMany({ where: eq(runQuotes.userId, fixture.user.id) }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, fixture.user.id),
      }),
    ).toHaveLength(0);
  });

  it('creates a new child workflow when the latest retry task also fails', async () => {
    const fixture = await createFixture({});
    const firstRetry = await service.retryFailedImage({
      userId: fixture.user.id,
      workflowRunId: fixture.workflow.id,
      taskId: fixture.task.id,
      idempotencyKey: `s13-chain-first-${randomUUID()}`,
    });
    const [firstAttempt] = await resource.db
      .insert(taskAttempts)
      .values({
        taskId: firstRetry.task_id,
        attemptNo: 1,
        status: 'failed',
        dispatchState: 'not_dispatched',
        provider: fixture.model.provider,
        endedAt: new Date(),
      })
      .returning({ id: taskAttempts.id });
    if (!firstAttempt) throw new Error('Failed to create chained retry attempt');
    await resource.db
      .update(tasks)
      .set({ status: 'failed', errorCode: 'PROVIDER_FAILED', endedAt: new Date() })
      .where(eq(tasks.id, firstRetry.task_id));
    await resource.db
      .update(workflowRuns)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(eq(workflowRuns.id, firstRetry.workflow_run_id));
    const firstReservation = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.workflowRunId, firstRetry.workflow_run_id),
    });
    if (!firstReservation) throw new Error('First retry reservation was not created');
    await resource.db.transaction((transaction) =>
      releaseReservationInTransaction(transaction, {
        userId: fixture.user.id,
        reservationId: firstReservation.id,
        taskAttemptId: firstAttempt.id,
        amount: '1.00',
        idempotencyKey: `s13-chain-release-${firstAttempt.id}`,
      }),
    );

    const secondRetry = await service.retryFailedImage({
      userId: fixture.user.id,
      workflowRunId: firstRetry.workflow_run_id,
      taskId: firstRetry.task_id,
      idempotencyKey: `s13-chain-second-${randomUUID()}`,
    });

    expect(secondRetry.workflow_run_id).not.toBe(firstRetry.workflow_run_id);
    expect(secondRetry.task_id).not.toBe(firstRetry.task_id);
    expect(
      await resource.db.query.tasks.findFirst({ where: eq(tasks.id, secondRetry.task_id) }),
    ).toMatchObject({ parentTaskId: firstRetry.task_id, status: 'queued' });
    expect(
      await resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.user.id),
      }),
    ).toMatchObject({ balance: '9.00', frozen: '1.00' });
  });
});
