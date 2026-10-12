import { randomUUID } from 'node:crypto';

import {
  and,
  appeals,
  artifactEvaluations,
  artifacts,
  creditAccounts,
  creditLedger,
  creditReservations,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  models,
  queueDispatchIntents,
  runQuotes,
  taskAttempts,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import { refundAppeal } from '@ecom-forge/credit';
import type { QueuePayload } from '@ecom-forge/queue';
import { subtractMoney } from '@ecom-forge/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { WorkflowStateRepository } from '../src/database/workflow-state.repository.js';
import { SettlementService } from '../src/processors/settlement-processor.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';

function assertIsolatedDatabase(): void {
  const testUrl = new URL(databaseUrl);
  const databaseName = testUrl.pathname.replace(/^\//, '').toLowerCase();
  if (!/_test(?:_|$)/.test(databaseName)) {
    throw new Error('S04 settlement tests require a database name containing _test');
  }
  const developmentUrl = process.env.DATABASE_URL?.trim();
  if (developmentUrl && new URL(developmentUrl).toString() === testUrl.toString()) {
    throw new Error('S04 settlement tests must not target the development database');
  }
}

assertIsolatedDatabase();

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const service = new SettlementService(resource.db);
const trackedUsers = new Set<string>();
const trackedModels = new Set<string>();

async function createSettlementFixture(input: {
  taskStatus: typeof tasks.$inferInsert.status;
  attemptStatus: typeof taskAttempts.$inferInsert.status;
  dispatchState: typeof taskAttempts.$inferInsert.dispatchState;
  estimate?: string;
  taskEstimate?: string;
  providerCost?: string | null;
}) {
  const userId = randomUUID();
  trackedUsers.add(userId);
  const estimate = input.estimate ?? '2.00';
  const taskEstimate = input.taskEstimate ?? estimate;
  const availableAfterFreeze = subtractMoney('10.00', estimate);
  const [user] = await resource.db
    .insert(users)
    .values({
      id: userId,
      email: `s04-worker-${userId}@example.test`,
      displayName: 'S04 worker test user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create settlement user');
  await resource.db.insert(creditAccounts).values({
    userId,
    balance: availableAfterFreeze,
    frozen: estimate,
    version: 2,
  });
  await resource.db.insert(creditLedger).values([
    {
      userId,
      type: 'grant',
      amount: '10.00',
      idempotencyKey: `s04-worker-grant:${userId}`,
      accountVersion: 1,
      balanceAfter: '10.00',
      frozenAfter: '0.00',
      metadata: { test_run_id: userId },
    },
  ]);
  const [quote] = await resource.db
    .insert(runQuotes)
    .values({
      userId,
      source: 'chat',
      status: 'submitted',
      promptPreview: {},
      estimatedCallCount: 1,
      estimatedTotalCredits: estimate,
      idempotencyKey: `s04-worker-quote:${userId}`,
      inputSignature: `s04-worker-signature:${userId}`,
      confirmationSnapshot: {},
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
      confirmedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    .returning();
  if (!quote) throw new Error('Failed to create settlement quote');
  const [reservation] = await resource.db
    .insert(creditReservations)
    .values({
      userId,
      estimatedAmount: estimate,
      status: 'frozen',
      idempotencyKey: `s04-worker-reservation:${userId}`,
    })
    .returning();
  if (!reservation) throw new Error('Failed to create settlement reservation');
  await resource.db.insert(creditLedger).values({
    userId,
    type: 'reservation_freeze',
    amount: `-${estimate}`,
    reservationId: reservation.id,
    idempotencyKey: `freeze:reservation:${reservation.id}`,
    accountVersion: 2,
    balanceAfter: availableAfterFreeze,
    frozenAfter: estimate,
    metadata: { test_run_id: userId },
  });
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId,
      triggerMode: 'chat',
      runQuoteId: quote.id,
      reservationId: reservation.id,
      status: 'running',
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
    })
    .returning();
  if (!workflow) throw new Error('Failed to create settlement workflow');
  await resource.db
    .update(runQuotes)
    .set({ workflowRunId: workflow.id })
    .where(eq(runQuotes.id, quote.id));
  await resource.db
    .update(creditReservations)
    .set({ workflowRunId: workflow.id })
    .where(eq(creditReservations.id, reservation.id));
  const [task] = await resource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow.id,
      type: 'image.generate',
      status: input.taskStatus,
      costEstimate: taskEstimate,
      idempotencyKey: `s04-worker-task:${userId}`,
      dagNodeId: 'image-1',
      dagJson: {},
      paramsSnapshot: {},
      ...(input.taskStatus === 'succeeded' ? { endedAt: new Date() } : {}),
    })
    .returning();
  if (!task) throw new Error('Failed to create settlement task');
  const [attempt] = await resource.db
    .insert(taskAttempts)
    .values({
      taskId: task.id,
      attemptNo: 1,
      status: input.attemptStatus,
      dispatchState: input.dispatchState,
      provider: 's04-test-provider',
      providerReportedCost: input.providerCost ?? null,
      endedAt: new Date(),
    })
    .returning();
  if (!attempt) throw new Error('Failed to create settlement attempt');
  return { user, quote, reservation, workflow, task, attempt };
}

function payload(
  fixture: Awaited<ReturnType<typeof createSettlementFixture>>,
  artifactIds: string[] = [],
): Extract<QueuePayload, { job_type: 'settlement.execute' }> {
  return {
    schema_version: 1,
    job_type: 'settlement.execute',
    trace_id: fixture.workflow.id,
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.task.id,
    task_attempt_id: fixture.attempt.id,
    reservation_id: fixture.reservation.id,
    ...(fixture.attempt.providerReportedCost
      ? { provider_reported_cost: fixture.attempt.providerReportedCost }
      : {}),
    artifact_ids: artifactIds,
    idempotency_key: `settle:task_attempt:${fixture.attempt.id}`,
  };
}

async function cleanupUser(userId: string): Promise<void> {
  const userWorkflows = await resource.db.query.workflowRuns.findMany({
    where: eq(workflowRuns.userId, userId),
    columns: { id: true },
  });
  const workflowIds = userWorkflows.map((item) => item.id);
  const userTasks =
    workflowIds.length > 0
      ? await resource.db.query.tasks.findMany({
          where: inArray(tasks.workflowRunId, workflowIds),
          columns: { id: true },
        })
      : [];
  const taskIds = userTasks.map((item) => item.id);
  const attempts =
    taskIds.length > 0
      ? await resource.db.query.taskAttempts.findMany({
          where: inArray(taskAttempts.taskId, taskIds),
          columns: { id: true },
        })
      : [];
  const aggregateIds = [...workflowIds, ...taskIds, ...attempts.map((item) => item.id)];
  const userArtifacts = await resource.db.query.artifacts.findMany({
    where: eq(artifacts.userId, userId),
    columns: { id: true },
  });
  const artifactIds = userArtifacts.map((item) => item.id);

  if (workflowIds.length > 0) {
    await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, workflowIds));
  }
  if (aggregateIds.length > 0) {
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, aggregateIds));
  }
  const userAppeals = await resource.db.query.appeals.findMany({
    where: eq(appeals.userId, userId),
    columns: { id: true },
  });
  const appealIds = userAppeals.map((item) => item.id);
  if (appealIds.length > 0) {
    await resource.db.delete(creditLedger).where(inArray(creditLedger.appealId, appealIds));
    await resource.db.delete(appeals).where(inArray(appeals.id, appealIds));
  }
  await resource.db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  if (artifactIds.length > 0) {
    await resource.db
      .delete(artifactEvaluations)
      .where(inArray(artifactEvaluations.artifactId, artifactIds));
    await resource.db.delete(artifacts).where(inArray(artifacts.id, artifactIds));
  }
  if (taskIds.length > 0) {
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
  await resource.db.delete(users).where(eq(users.id, userId));
}

afterEach(async () => {
  for (const userId of trackedUsers) await cleanupUser(userId);
  trackedUsers.clear();
  if (trackedModels.size > 0) {
    await resource.db.delete(models).where(inArray(models.id, [...trackedModels]));
    trackedModels.clear();
  }
});

afterAll(async () => {
  await resource.client.end();
});

describe('S04 settlement integration', () => {
  it('settles concurrent duplicate receipts exactly once', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      providerCost: '1.50',
    });

    const settlementPayload = payload(fixture);
    const results = await Promise.all([
      service.execute(settlementPayload),
      service.execute(settlementPayload),
    ]);
    const first = results.find((result) => !result.alreadyApplied);
    const replay = results.find((result) => result.alreadyApplied);
    if (!first || !replay) {
      throw new Error('Concurrent settlement did not produce one apply and one replay');
    }

    expect(first).toMatchObject({ action: 'consumed', alreadyApplied: false });
    expect(replay).toMatchObject({
      action: 'consumed',
      ledgerId: first.ledgerId,
      finalReleaseLedgerId: first.finalReleaseLedgerId,
      alreadyApplied: true,
    });
    const account = await resource.db.query.creditAccounts.findFirst({
      where: eq(creditAccounts.userId, fixture.user.id),
    });
    const reservation = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, fixture.reservation.id),
    });
    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, fixture.user.id),
    });
    const settlementEvents = await resource.db.query.eventOutbox.findMany({
      where: and(
        eq(eventOutbox.scopeId, fixture.workflow.id),
        eq(eventOutbox.eventType, 'credit.settled'),
      ),
    });
    expect(account).toMatchObject({ balance: '8.00', frozen: '0.00' });
    expect(reservation).toMatchObject({
      settledAmount: '2.00',
      releasedAmount: '0.00',
      status: 'settled',
    });
    const workflow = await resource.db.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, fixture.workflow.id),
    });
    expect(workflow?.status).toBe('succeeded');
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.type === 'release')).toHaveLength(0);
    expect(settlementEvents).toHaveLength(1);
    expect(settlementEvents[0]?.payload).toMatchObject({
      amount: '2.00',
      reservation_id: fixture.reservation.id,
      task_id: fixture.task.id,
      task_attempt_id: fixture.attempt.id,
      ledger_id: first.ledgerId,
      action: 'consumed',
    });
  });

  it('releases the full task estimate for a confirmed not-dispatched failure', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'failed',
      attemptStatus: 'failed',
      dispatchState: 'not_dispatched',
    });

    await expect(service.execute(payload(fixture))).resolves.toMatchObject({ action: 'released' });

    const account = await resource.db.query.creditAccounts.findFirst({
      where: eq(creditAccounts.userId, fixture.user.id),
    });
    const reservation = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, fixture.reservation.id),
    });
    expect(account).toMatchObject({ balance: '10.00', frozen: '0.00' });
    expect(reservation).toMatchObject({ releasedAmount: '2.00', status: 'released' });
    const workflow = await resource.db.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, fixture.workflow.id),
    });
    expect(workflow?.status).toBe('failed');
  });

  it('charges the frozen public credit price when Provider internal cost is zero', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      providerCost: '0.00',
    });

    await expect(service.execute(payload(fixture))).resolves.toMatchObject({
      action: 'consumed',
    });

    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, fixture.user.id),
    });
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.type === 'consume')[0]?.amount).toBe('-2.00');
    expect(ledger.filter((entry) => entry.type === 'release')).toHaveLength(0);
  });

  it('completes a successful zero-priced task without a zero-value ledger mutation', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      estimate: '2.00',
      taskEstimate: '0.00',
      providerCost: '0.00',
    });

    const result = await service.execute(payload(fixture));

    expect(result).toMatchObject({ action: 'consumed', ledgerId: null, alreadyApplied: false });
    const task = await resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.task.id) });
    const reservation = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, fixture.reservation.id),
    });
    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, fixture.user.id),
    });
    const events = await resource.db.query.eventOutbox.findMany({
      where: and(
        eq(eventOutbox.scopeId, fixture.workflow.id),
        eq(eventOutbox.eventType, 'credit.released'),
      ),
    });

    expect(task?.costActual).toBe('0.00');
    expect(reservation).toMatchObject({ releasedAmount: '2.00', status: 'released' });
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ amount: '2.00', action: 'released' });
  });

  it('completes a failed zero-priced task without a zero-value ledger mutation', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'failed',
      attemptStatus: 'failed',
      dispatchState: 'not_dispatched',
      estimate: '2.00',
      taskEstimate: '0.00',
      providerCost: '0.00',
    });

    const result = await service.execute(payload(fixture));

    expect(result).toMatchObject({ action: 'released', ledgerId: null, alreadyApplied: false });
    const task = await resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.task.id) });
    const reservation = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, fixture.reservation.id),
    });
    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, fixture.user.id),
    });
    expect(task?.costActual).toBe('0.00');
    expect(reservation).toMatchObject({ settledAmount: '0.00', releasedAmount: '2.00' });
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(0);
    expect(ledger.filter((entry) => entry.type === 'release')).toHaveLength(1);
    expect(ledger.find((entry) => entry.type === 'release')?.amount).toBe('2.00');
  });

  it('does not replace a five-credit SKU price with a one-cent Provider cost', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      estimate: '5.00',
      taskEstimate: '5.00',
      providerCost: '0.01',
    });

    await expect(service.execute(payload(fixture))).resolves.toMatchObject({
      action: 'consumed',
    });

    const account = await resource.db.query.creditAccounts.findFirst({
      where: eq(creditAccounts.userId, fixture.user.id),
    });
    const reservation = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, fixture.reservation.id),
    });
    const task = await resource.db.query.tasks.findFirst({
      where: eq(tasks.id, fixture.task.id),
    });
    expect(account).toMatchObject({ balance: '5.00', frozen: '0.00' });
    expect(reservation).toMatchObject({
      settledAmount: '5.00',
      releasedAmount: '0.00',
      status: 'settled',
    });
    expect(task?.costActual).toBe('5.00');
  });

  it('holds partial-task remainder until every workflow task is financially accounted', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      estimate: '4.00',
      taskEstimate: '2.00',
      providerCost: '1.50',
    });
    const [secondTask] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: fixture.workflow.id,
        type: 'image.generate',
        status: 'running',
        costEstimate: '2.00',
        idempotencyKey: `s04-worker-second-task:${fixture.user.id}`,
        dagNodeId: 'image-2',
        dagJson: {},
        paramsSnapshot: {},
      })
      .returning();
    if (!secondTask) throw new Error('Failed to create second settlement task');

    const firstResult = await service.execute(payload(fixture));
    expect(firstResult.finalReleaseLedgerId).toBeNull();
    const partial = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, fixture.reservation.id),
    });
    expect(partial).toMatchObject({
      settledAmount: '2.00',
      releasedAmount: '0.00',
      status: 'partially_settled',
    });

    await resource.db
      .update(tasks)
      .set({ status: 'failed', endedAt: new Date() })
      .where(eq(tasks.id, secondTask.id));
    const [secondAttempt] = await resource.db
      .insert(taskAttempts)
      .values({
        taskId: secondTask.id,
        attemptNo: 1,
        status: 'failed',
        dispatchState: 'not_dispatched',
        provider: 's04-test-provider',
        endedAt: new Date(),
      })
      .returning();
    if (!secondAttempt) throw new Error('Failed to create second settlement attempt');
    const secondPayload: Extract<QueuePayload, { job_type: 'settlement.execute' }> = {
      schema_version: 1,
      job_type: 'settlement.execute',
      trace_id: fixture.workflow.id,
      workflow_run_id: fixture.workflow.id,
      task_id: secondTask.id,
      task_attempt_id: secondAttempt.id,
      reservation_id: fixture.reservation.id,
      artifact_ids: [],
      idempotency_key: `settle:task_attempt:${secondAttempt.id}`,
    };

    const final = await service.execute(secondPayload);
    expect(final.finalReleaseLedgerId).toBeNull();
    const settled = await resource.db.query.creditReservations.findFirst({
      where: eq(creditReservations.id, fixture.reservation.id),
    });
    const account = await resource.db.query.creditAccounts.findFirst({
      where: eq(creditAccounts.userId, fixture.user.id),
    });
    expect(settled).toMatchObject({
      settledAmount: '2.00',
      releasedAmount: '2.00',
      status: 'settled',
    });
    expect(account).toMatchObject({ balance: '8.00', frozen: '0.00' });
  });

  it('allows a successful task to consume after an earlier failed task started releasing', async () => {
    const failed = await createSettlementFixture({
      taskStatus: 'failed',
      attemptStatus: 'failed',
      dispatchState: 'accepted',
      estimate: '4.00',
      taskEstimate: '2.00',
    });
    const [successfulTask] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: failed.workflow.id,
        type: 'image.generate',
        status: 'succeeded',
        costEstimate: '2.00',
        idempotencyKey: `s04-worker-late-success-task:${failed.user.id}`,
        dagNodeId: 'image-2',
        dagJson: {},
        paramsSnapshot: {},
        endedAt: new Date(),
      })
      .returning();
    if (!successfulTask) throw new Error('Failed to create late successful task');
    const [successfulAttempt] = await resource.db
      .insert(taskAttempts)
      .values({
        taskId: successfulTask.id,
        attemptNo: 1,
        status: 'succeeded',
        dispatchState: 'accepted',
        provider: 's04-test-provider',
        providerReportedCost: '2.00',
        endedAt: new Date(),
      })
      .returning();
    if (!successfulAttempt) throw new Error('Failed to create late successful attempt');

    await service.execute(payload(failed));
    expect(
      await resource.db.query.creditReservations.findFirst({
        where: eq(creditReservations.id, failed.reservation.id),
      }),
    ).toMatchObject({ releasedAmount: '2.00', settledAmount: '0.00', status: 'releasing' });

    await service.execute({
      schema_version: 1,
      job_type: 'settlement.execute',
      trace_id: failed.workflow.id,
      workflow_run_id: failed.workflow.id,
      task_id: successfulTask.id,
      task_attempt_id: successfulAttempt.id,
      reservation_id: failed.reservation.id,
      provider_reported_cost: '2.00',
      artifact_ids: [],
      idempotency_key: `settle:task_attempt:${successfulAttempt.id}`,
    });

    const [reservation, workflow, account] = await Promise.all([
      resource.db.query.creditReservations.findFirst({
        where: eq(creditReservations.id, failed.reservation.id),
      }),
      resource.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, failed.workflow.id) }),
      resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, failed.user.id),
      }),
    ]);
    expect(reservation).toMatchObject({
      releasedAmount: '2.00',
      settledAmount: '2.00',
      status: 'settled',
    });
    expect(workflow?.status).toBe('failed');
    expect(account).toMatchObject({ balance: '8.00', frozen: '0.00' });
  });

  it('keeps outcome-unknown attempts frozen and writes no settlement ledger', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'running',
      attemptStatus: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
    });

    await expect(service.execute(payload(fixture))).rejects.toMatchObject({
      code: 'SETTLEMENT_PROTECTED',
    });

    const account = await resource.db.query.creditAccounts.findFirst({
      where: eq(creditAccounts.userId, fixture.user.id),
    });
    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, fixture.user.id),
    });
    expect(account).toMatchObject({ balance: '8.00', frozen: '2.00' });
    expect(ledger.filter((entry) => ['consume', 'release'].includes(entry.type))).toHaveLength(0);
  });

  it('requires every generated artifact to be visible and content-safety approved', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      providerCost: '2.00',
    });
    const [artifact] = await resource.db
      .insert(artifacts)
      .values({
        taskId: fixture.task.id,
        userId: fixture.user.id,
        type: 'image',
        storageKey: `s04-test/${fixture.user.id}/image.png`,
        metaJson: {},
        paramsSnapshot: {},
        sourceAction: 'generate',
        originDomain: 'creative',
        producerMode: 'canvas',
        mutationOwner: 'canvas',
        visibility: 'quarantined',
      })
      .returning();
    if (!artifact) throw new Error('Failed to create settlement artifact');
    const [evaluationModel] = await resource.db
      .insert(models)
      .values({
        provider: 's04-test-provider',
        modelId: `s04-evaluator-${fixture.user.id}`,
        version: '1',
        capabilityContractJson: {},
        pricingJson: {},
        quotaJson: {},
        status: 'poc_passed',
      })
      .returning({ id: models.id });
    if (!evaluationModel) throw new Error('Failed to create settlement evaluator model');
    trackedModels.add(evaluationModel.id);
    await resource.db.insert(artifactEvaluations).values({
      artifactId: artifact.id,
      taskId: fixture.task.id,
      taskAttemptId: fixture.attempt.id,
      modelSnapshotId: evaluationModel.id,
      operationKey: `s04-evaluation:${artifact.id}`,
      evaluatorType: 'content_safety',
      evaluatorVersion: 's04-test-v1',
      evidenceSnapshot: {},
      findingsJson: {},
      confidence: '1.0000',
      status: 'pass',
    });

    await expect(service.execute(payload(fixture, [artifact.id]))).rejects.toMatchObject({
      code: 'SETTLEMENT_PROTECTED',
    });
    await resource.db
      .update(artifacts)
      .set({ visibility: 'private' })
      .where(eq(artifacts.id, artifact.id));
    await expect(service.execute(payload(fixture, [artifact.id]))).resolves.toMatchObject({
      action: 'consumed',
    });
  });

  it('writes task success and settlement intent atomically', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'running',
      attemptStatus: 'succeeded',
      dispatchState: 'not_dispatched',
    });
    const states = new WorkflowStateRepository(resource.db);

    await states.advanceTask({
      taskId: fixture.task.id,
      workflowRunId: fixture.workflow.id,
      userId: fixture.user.id,
      from: 'running',
      to: 'succeeded',
      now: new Date(),
      settlement: {
        taskAttemptId: fixture.attempt.id,
        reservationId: fixture.reservation.id,
        artifactIds: [],
      },
    });

    const task = await resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.task.id) });
    const intent = await resource.db.query.queueDispatchIntents.findFirst({
      where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
    });
    expect(task?.status).toBe('succeeded');
    expect(intent).toMatchObject({
      queueName: 'settlement',
      jobId: fixture.attempt.id,
      status: 'pending',
    });
    expect(intent?.payload).toMatchObject({
      job_type: 'settlement.execute',
      idempotency_key: `settle:task_attempt:${fixture.attempt.id}`,
    });
  });

  it('refunds an approved appeal once without exceeding the original consume', async () => {
    const fixture = await createSettlementFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      providerCost: '2.00',
    });
    await service.execute(payload(fixture));
    const consume = await resource.db.query.creditLedger.findFirst({
      where: and(eq(creditLedger.userId, fixture.user.id), eq(creditLedger.type, 'consume')),
    });
    if (!consume) throw new Error('Settlement did not create a consume ledger');
    const [appeal] = await resource.db
      .insert(appeals)
      .values({
        ledgerId: consume.id,
        userId: fixture.user.id,
        reason: 'S04 integration refund',
      })
      .returning();
    if (!appeal) throw new Error('Failed to create refund appeal');

    await expect(
      refundAppeal(resource.db, {
        userId: fixture.user.id,
        appealId: appeal.id,
        reviewerId: fixture.user.id,
        amount: '2.01',
        idempotencyKey: `s04-refund-too-large:${appeal.id}`,
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_STATE_INVALID' });

    const input = {
      userId: fixture.user.id,
      appealId: appeal.id,
      reviewerId: fixture.user.id,
      amount: '2.00' as const,
      idempotencyKey: `s04-refund:${appeal.id}`,
    };
    const first = await refundAppeal(resource.db, input);
    const replay = await refundAppeal(resource.db, input);
    expect(first).toMatchObject({ balanceAfter: '10.00', alreadyApplied: false });
    expect(replay).toMatchObject({ ledgerId: first.ledgerId, alreadyApplied: true });

    const refunds = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.appealId, appeal.id),
    });
    const storedAppeal = await resource.db.query.appeals.findFirst({
      where: eq(appeals.id, appeal.id),
    });
    expect(refunds).toHaveLength(1);
    expect(storedAppeal).toMatchObject({ status: 'refunded', refundAmount: '2.00' });
  });
});
