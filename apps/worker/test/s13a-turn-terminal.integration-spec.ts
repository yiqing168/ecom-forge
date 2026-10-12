import { randomUUID } from 'node:crypto';

import {
  agentTraces,
  agentTurns,
  and,
  chatMessages,
  chatSessions,
  creditAccounts,
  creditLedger,
  creditReservations,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  runQuotes,
  taskAttempts,
  tasks,
  users,
  workflowRuns,
  artifacts,
  artifactEvaluations,
  models,
} from '@ecom-forge/db';
import type { QueuePayload } from '@ecom-forge/queue';
import { AGENT_IMAGE_FAILURES, subtractMoney } from '@ecom-forge/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { SettlementService } from '../src/processors/settlement-processor.js';
import { AgentTurnTerminalRepository } from '../src/agent/agent-turn-terminal.repository.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';

const testUrl = new URL(databaseUrl);
if (!/_test(?:_|$)/.test(testUrl.pathname.replace(/^\//, '').toLowerCase())) {
  throw new Error('S13A turn terminal tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 10 });
const service = new SettlementService(resource.db);
const turnTerminal = new AgentTurnTerminalRepository(resource.db);
const trackedUsers = new Set<string>();

interface Fixture {
  userId: string;
  sessionId: string;
  turnId: string;
  workflowRunId: string;
  reservationId: string;
  taskId: string;
  attemptId: string;
  artifactIds: string[];
}

async function createFixture(input: {
  taskStatus: 'succeeded' | 'failed';
  attemptStatus: 'succeeded' | 'failed';
  dispatchState: 'accepted' | 'not_dispatched';
  withArtifacts: boolean;
}): Promise<Fixture> {
  const userId = randomUUID();
  trackedUsers.add(userId);
  await resource.db.insert(users).values({
    id: userId,
    email: `s13a-terminal-${userId}@example.test`,
    displayName: 'S13A terminal test user',
    emailVerifiedAt: new Date(),
  });
  await resource.db.insert(creditAccounts).values({
    userId,
    balance: subtractMoney('10.00', '5.00'),
    frozen: '5.00',
    version: 2,
  });
  await resource.db.insert(creditLedger).values([
    {
      userId,
      type: 'grant',
      amount: '10.00',
      idempotencyKey: `s13a-grant:${userId}`,
      accountVersion: 1,
      balanceAfter: '10.00',
      frozenAfter: '0.00',
      metadata: { test_run_id: userId },
    },
    {
      userId,
      type: 'reservation_freeze',
      amount: '-5.00',
      idempotencyKey: `s13a-freeze:${userId}`,
      accountVersion: 2,
      balanceAfter: '5.00',
      frozenAfter: '5.00',
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
      estimatedTotalCredits: '5.00',
      idempotencyKey: `s13a-quote:${userId}`,
      inputSignature: `s13a-signature:${userId}`,
      confirmationSnapshot: {},
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
      confirmedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    .returning();
  const [reservation] = await resource.db
    .insert(creditReservations)
    .values({
      userId,
      estimatedAmount: '5.00',
      status: 'frozen',
      idempotencyKey: `s13a-reservation:${userId}`,
    })
    .returning();
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId,
      triggerMode: 'chat',
      runQuoteId: quote!.id,
      reservationId: reservation!.id,
      status: 'running',
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
    })
    .returning();
  await resource.db
    .update(runQuotes)
    .set({ workflowRunId: workflow!.id })
    .where(eq(runQuotes.id, quote!.id));
  await resource.db
    .update(creditReservations)
    .set({ workflowRunId: workflow!.id })
    .where(eq(creditReservations.id, reservation!.id));
  const [task] = await resource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow!.id,
      type: 'image.generate',
      status: input.taskStatus,
      costEstimate: '5.00',
      idempotencyKey: `s13a-task:${userId}`,
      dagNodeId: 'image-1',
      dagJson: {},
      paramsSnapshot: {},
      ...(input.taskStatus === 'succeeded' ? { endedAt: new Date() } : {}),
    })
    .returning();
  const [attempt] = await resource.db
    .insert(taskAttempts)
    .values({
      taskId: task!.id,
      attemptNo: 1,
      status: input.attemptStatus,
      dispatchState: input.dispatchState,
      provider: 's13a-test-provider',
      endedAt: new Date(),
    })
    .returning();
  const [session] = await resource.db
    .insert(chatSessions)
    .values({ userId, title: 'S13A terminal session' })
    .returning();
  const [turn] = await resource.db
    .insert(agentTurns)
    .values({
      sessionId: session!.id,
      userId,
      status: 'waiting_provider_confirmation',
      runQuoteId: quote!.id,
      workflowRunId: workflow!.id,
    })
    .returning();
  await resource.db.insert(agentTraces).values({
    turnId: turn!.id,
    sessionId: session!.id,
    userId,
    brainModelId: 's13a-test-brain',
    status: 'running',
  });
  const artifactIds: string[] = [];
  if (input.withArtifacts) {
    const [evaluationModel] = await resource.db
      .insert(models)
      .values({
        provider: 's13a-test-provider',
        modelId: `s13a-moderation-${userId}`,
        version: '1',
        capabilityContractJson: {},
        pricingJson: {},
        quotaJson: {},
        status: 'poc_passed',
      })
      .returning({ id: models.id });
    const [artifact] = await resource.db
      .insert(artifacts)
      .values({
        taskId: task!.id,
        userId,
        type: 'image',
        storageKey: `s13a-terminal/${userId}.png`,
        metaJson: {},
        paramsSnapshot: {},
        sourceAction: 'generate',
        originDomain: 'creative',
        producerMode: 'chat',
        producerSessionId: session!.id,
        mutationOwner: 'chat_session',
        visibility: 'private',
        contentHash: `a${userId.replace(/-/g, '')}`.slice(0, 64),
      })
      .returning({ id: artifacts.id });
    artifactIds.push(artifact!.id);
    await resource.db.insert(artifactEvaluations).values({
      artifactId: artifact!.id,
      evaluatorType: 'content_safety',
      evaluatorVersion: 'test@1',
      evidenceSnapshot: {},
      findingsJson: {},
      confidence: '1.0000',
      status: 'pass',
      taskId: task!.id,
      taskAttemptId: attempt!.id,
      modelSnapshotId: evaluationModel!.id,
      operationKey: `s13a-evaluation:${userId}`,
    });
  }
  return {
    userId,
    sessionId: session!.id,
    turnId: turn!.id,
    workflowRunId: workflow!.id,
    reservationId: reservation!.id,
    taskId: task!.id,
    attemptId: attempt!.id,
    artifactIds,
  };
}

function settlementPayload(
  fixture: Fixture,
): Extract<QueuePayload, { job_type: 'settlement.execute' }> {
  return {
    schema_version: 1,
    job_type: 'settlement.execute',
    trace_id: fixture.workflowRunId,
    workflow_run_id: fixture.workflowRunId,
    reservation_id: fixture.reservationId,
    task_id: fixture.taskId,
    task_attempt_id: fixture.attemptId,
    artifact_ids: fixture.artifactIds,
    idempotency_key: `settle:task_attempt:${fixture.attemptId}`,
  };
}

async function cleanup(): Promise<void> {
  for (const userId of trackedUsers) {
    const turns = await resource.db.query.agentTurns.findMany({
      where: eq(agentTurns.userId, userId),
      columns: { id: true, sessionId: true },
    });
    for (const turn of turns) {
      await resource.db.delete(agentTraces).where(eq(agentTraces.turnId, turn.id));
      await resource.db.delete(chatMessages).where(eq(chatMessages.turnId, turn.id));
      await resource.db.delete(eventOutbox).where(eq(eventOutbox.scopeId, turn.id));
    }
    if (turns.length > 0) {
      await resource.db.delete(agentTurns).where(
        inArray(
          agentTurns.id,
          turns.map((t) => t.id),
        ),
      );
    }
    const runs = await resource.db.query.workflowRuns.findMany({
      where: eq(workflowRuns.userId, userId),
      columns: { id: true },
    });
    const runIds = runs.map((run) => run.id);
    const userTasks = await resource.db.query.tasks.findMany({
      where: inArray(tasks.workflowRunId, runIds),
      columns: { id: true },
    });
    const taskIds = userTasks.map((task) => task.id);
    for (const artifact of await resource.db.query.artifacts.findMany({
      where: eq(artifacts.userId, userId),
      columns: { id: true },
    })) {
      await resource.db
        .delete(artifactEvaluations)
        .where(eq(artifactEvaluations.artifactId, artifact.id));
    }
    await resource.db.delete(artifacts).where(eq(artifacts.userId, userId));
    await resource.db.delete(creditLedger).where(eq(creditLedger.userId, userId));
    if (taskIds.length > 0) {
      await resource.db.delete(taskAttempts).where(inArray(taskAttempts.taskId, taskIds));
      await resource.db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
    if (runIds.length > 0) {
      await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, runIds));
    }
    await resource.db
      .update(creditReservations)
      .set({ workflowRunId: null })
      .where(eq(creditReservations.userId, userId));
    await resource.db
      .update(runQuotes)
      .set({ workflowRunId: null })
      .where(eq(runQuotes.userId, userId));
    await resource.db.delete(workflowRuns).where(eq(workflowRuns.userId, userId));
    await resource.db.delete(creditReservations).where(eq(creditReservations.userId, userId));
    const staleModelIds = await resource.db
      .select({ id: models.id })
      .from(models)
      .where(eq(models.provider, 's13a-test-provider'));
    if (staleModelIds.length > 0) {
      await resource.db.delete(artifactEvaluations).where(
        inArray(
          artifactEvaluations.modelSnapshotId,
          staleModelIds.map((row) => row.id),
        ),
      );
    }
    await resource.db.delete(models).where(eq(models.provider, 's13a-test-provider'));
    await resource.db.delete(creditLedger).where(eq(creditLedger.userId, userId));
    await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
    await resource.db.delete(runQuotes).where(eq(runQuotes.userId, userId));
    await resource.db.delete(chatSessions).where(eq(chatSessions.userId, userId));
    await resource.db.delete(users).where(eq(users.id, userId));
  }
  trackedUsers.clear();
}

afterEach(cleanup);
afterAll(async () => {
  await resource.client.end();
});

describe('S13A settlement finalizes the agent turn', () => {
  it('completes a waiting turn when the workflow succeeds and settles the frozen price', async () => {
    const fixture = await createFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      withArtifacts: true,
    });
    await service.execute(settlementPayload(fixture));

    const [turn] = await resource.db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, fixture.turnId));
    expect(turn?.status).toBe('done');
    expect(turn?.endedAt).not.toBeNull();
    const [trace] = await resource.db
      .select()
      .from(agentTraces)
      .where(eq(agentTraces.turnId, fixture.turnId));
    expect(trace?.status).toBe('succeeded');

    const replies = await resource.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.turnId, fixture.turnId), eq(chatMessages.role, 'assistant')));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toContain('已生成 1 张图片');
    expect(replies[0]?.attachments).toEqual([
      {
        kind: 'artifact',
        object_id: fixture.artifactIds[0],
        role: 'other',
        position: 0,
      },
    ]);

    const turnEvents = await resource.db
      .select({ eventType: eventOutbox.eventType })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.scopeType, 'turn'), eq(eventOutbox.scopeId, fixture.turnId)))
      .orderBy(eventOutbox.eventSeq);
    const types = turnEvents.map((event) => event.eventType);
    expect(types).toContain('turn.message_delta');
    expect(types).toContain('turn.status_changed');
    expect(types).toContain('turn.completed');
    expect(types).not.toContain('turn.failed');

    const [reservation] = await resource.db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.workflowRunId, fixture.workflowRunId));
    expect(reservation?.status).toBe('settled');
    expect(reservation?.settledAmount).toBe('5.00');
    expect(reservation?.releasedAmount).toBe('0.00');
  });

  it('fails a waiting turn and releases the full freeze when the image task fails', async () => {
    const fixture = await createFixture({
      taskStatus: 'failed',
      attemptStatus: 'failed',
      dispatchState: 'not_dispatched',
      withArtifacts: false,
    });
    await service.execute(settlementPayload(fixture));

    const [turn] = await resource.db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.id, fixture.turnId));
    expect(turn?.status).toBe('failed');
    const replies = await resource.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.turnId, fixture.turnId));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toContain('积分已全额退回');

    const turnEvents = await resource.db
      .select({ eventType: eventOutbox.eventType, payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.scopeType, 'turn'), eq(eventOutbox.scopeId, fixture.turnId)));
    expect(turnEvents.map((event) => event.eventType)).toContain('turn.failed');
    const failedPayload = turnEvents.find((event) => event.eventType === 'turn.failed')?.payload as
      Record<string, unknown> | undefined;
    expect(failedPayload).toMatchObject({
      turn_id: fixture.turnId,
      ...AGENT_IMAGE_FAILURES.failed,
      user_status: 'failed',
    });
    expect(typeof failedPayload?.agent_trace_id).toBe('string');

    const [reservation] = await resource.db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.workflowRunId, fixture.workflowRunId));
    expect(reservation?.status).toBe('released');
    expect(reservation?.releasedAmount).toBe('5.00');
    expect(reservation?.settledAmount).toBe('0.00');
  });

  it('keeps published images in a partially successful terminal response', async () => {
    const fixture = await createFixture({
      taskStatus: 'failed',
      attemptStatus: 'failed',
      dispatchState: 'accepted',
      withArtifacts: true,
    });

    await resource.db.transaction((transaction) =>
      turnTerminal.completeForWorkflowOutcome(transaction, {
        workflowRunId: fixture.workflowRunId,
        outcome: 'failed',
      }),
    );

    const replies = await resource.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.turnId, fixture.turnId), eq(chatMessages.role, 'assistant')));
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toContain('已生成 1 张图片');
    expect(replies[0]?.content).toContain('未完成部分的积分已退回');
    expect(replies[0]?.content).not.toContain('全额退回');
    expect(replies[0]?.attachments).toEqual([
      {
        kind: 'artifact',
        object_id: fixture.artifactIds[0],
        role: 'other',
        position: 0,
      },
    ]);

    const [completedEvent] = await resource.db
      .select({ payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.scopeType, 'turn'),
          eq(eventOutbox.scopeId, fixture.turnId),
          eq(eventOutbox.eventType, 'turn.completed'),
        ),
      );
    expect(completedEvent?.payload).toMatchObject({
      message_id: replies[0]?.id,
      user_status: 'completed',
    });
    const [turn] = await resource.db
      .select({ status: agentTurns.status })
      .from(agentTurns)
      .where(eq(agentTurns.id, fixture.turnId));
    expect(turn?.status).toBe('done');
  });

  it('does not duplicate terminal messages when settlement replays', async () => {
    const fixture = await createFixture({
      taskStatus: 'succeeded',
      attemptStatus: 'succeeded',
      dispatchState: 'accepted',
      withArtifacts: true,
    });
    await service.execute(settlementPayload(fixture));
    const second = await service.execute(settlementPayload(fixture));
    expect(second.alreadyApplied).toBe(true);

    const replies = await resource.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(eq(chatMessages.turnId, fixture.turnId), eq(chatMessages.role, 'assistant')));
    expect(replies).toHaveLength(1);
    const completedEvents = await resource.db
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.scopeType, 'turn'),
          eq(eventOutbox.scopeId, fixture.turnId),
          eq(eventOutbox.eventType, 'turn.completed'),
        ),
      );
    expect(completedEvents).toHaveLength(1);
  });
});
