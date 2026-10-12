import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adminAuditLogs,
  artifactEvaluations,
  artifacts,
  chatSessions,
  contentReviewCases,
  createDatabaseClient,
  creditAccounts,
  creditLedger,
  creditReservations,
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
import { LocalPrivateStorage } from '@ecom-forge/storage';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import type { WorkerConfig } from '../src/config/worker-config.js';
import { ContentReviewDeadlineSweeper } from '../src/image/content-review-deadline.sweeper.js';
import { ImagePublicationService } from '../src/image/image-publication.service.js';
import { WorkerWriteFence } from '../src/lifecycle/processing-fence.js';
import { integrationWorkerConfig, testDatabaseUrl } from './s05-integration.fixture.js';

const resource = createDatabaseClient({ databaseUrl: testDatabaseUrl, maxConnections: 10 });

describe('S12 post-moderation publication integration', () => {
  let storageRoot: string;
  let fixture: Awaited<ReturnType<typeof createPublicationFixture>> | undefined;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'ecom-forge-s12-publication-'));
    fixture = await createPublicationFixture(storageRoot);
  });

  afterEach(async () => {
    if (fixture) await cleanupFixture(fixture);
    fixture = undefined;
    await rm(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await resource.client.end();
  });

  it('serializes concurrent passes and opens the complete output set exactly once', async () => {
    if (!fixture) throw new Error('Missing S12 publication fixture');
    const activeFixture = fixture;
    const service = new ImagePublicationService(
      resource.db,
      config(storageRoot),
      new WorkerWriteFence(),
    );
    const publish = (index: number) => {
      const item = activeFixture.outputs[index];
      if (!item) throw new Error('Missing publication fixture output');
      return service.publish({
        artifactId: item.artifact.id,
        evaluationId: item.evaluation.id,
        moderationTaskId: item.moderationTask.id,
        moderationAttemptId: item.moderationAttempt.id,
        workflowRunId: activeFixture.workflow.id,
        userId: activeFixture.user.id,
      });
    };

    await Promise.all([publish(0), publish(1)]);

    const published = await resource.db.query.artifacts.findMany({
      where: eq(artifacts.taskId, activeFixture.generationTask.id),
    });
    expect(published).toHaveLength(2);
    expect(published.every((artifact) => artifact.visibility === 'private')).toBe(true);
    expect(published.every((artifact) => Boolean(artifact.publishedStorageKey))).toBe(true);
    expect(published.every((artifact) => Boolean(artifact.thumbnailKey))).toBe(true);
    expect(published.every((artifact) => artifact.publicationRevision === 2)).toBe(true);
    const storage = new LocalPrivateStorage(storageRoot);
    await storage.initialize();
    for (const artifact of published) {
      if (!artifact.thumbnailKey) throw new Error('Published artifact thumbnail is missing');
      const thumbnail = await storage.read(artifact.thumbnailKey);
      await expect(sharp(thumbnail).metadata()).resolves.toMatchObject({ format: 'webp' });
    }

    expect(
      await resource.db.query.tasks.findFirst({
        where: eq(tasks.id, activeFixture.generationTask.id),
      }),
    ).toMatchObject({ status: 'succeeded' });
    const moderationTasks = await resource.db.query.tasks.findMany({
      where: inArray(
        tasks.id,
        activeFixture.outputs.map((item) => item.moderationTask.id),
      ),
    });
    expect(moderationTasks.every((task) => task.status === 'succeeded')).toBe(true);

    const settlementIntents = await resource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, activeFixture.generationAttempt.id),
    });
    expect(settlementIntents).toHaveLength(1);
    expect(settlementIntents[0]).toMatchObject({ queueName: 'settlement' });

    const artifactEventsBeforeReplay = await resource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, activeFixture.workflow.id),
    });
    expect(
      artifactEventsBeforeReplay.filter((event) => event.eventType === 'artifact.created'),
    ).toHaveLength(2);

    await Promise.all([publish(0), publish(1)]);
    const artifactEventsAfterReplay = await resource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, activeFixture.workflow.id),
    });
    expect(
      artifactEventsAfterReplay.filter((event) => event.eventType === 'artifact.created'),
    ).toHaveLength(2);
    expect(
      await resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, activeFixture.generationAttempt.id),
      }),
    ).toHaveLength(1);
  });

  it('expires one concurrent manual-review winner and releases frozen credits exactly once', async () => {
    if (!fixture) throw new Error('Missing S12 publication fixture');
    const reviewed = fixture.outputs[0];
    if (!reviewed) throw new Error('Missing S12 reviewed output');
    const deadlineAt = new Date(Date.now() - 1_000);
    await resource.db
      .update(artifactEvaluations)
      .set({
        status: 'unknown',
        confidence: null,
        findingsJson: { decision: 'unknown', error_code: 'provider_timeout' },
      })
      .where(eq(artifactEvaluations.id, reviewed.evaluation.id));
    await resource.db
      .update(taskAttempts)
      .set({ status: 'outcome_unknown', dispatchState: 'outcome_unknown', endedAt: new Date() })
      .where(eq(taskAttempts.id, reviewed.moderationAttempt.id));
    await resource.db
      .update(tasks)
      .set({ status: 'waiting_manual_review' })
      .where(eq(tasks.id, reviewed.moderationTask.id));
    const [review] = await resource.db
      .insert(contentReviewCases)
      .values({
        artifactId: reviewed.artifact.id,
        evaluationId: reviewed.evaluation.id,
        deadlineAt,
      })
      .returning();
    if (!review) throw new Error('Failed to create S12 content review');

    const sweeper = new ContentReviewDeadlineSweeper(
      resource.db,
      config(storageRoot),
      new WorkerWriteFence(),
    );
    const results = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(results.reduce((total, count) => total + count, 0)).toBe(1);

    expect(
      await resource.db.query.contentReviewCases.findFirst({
        where: eq(contentReviewCases.id, review.id),
      }),
    ).toMatchObject({ status: 'expired', revision: 2 });
    expect(
      await resource.db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, fixture.workflow.id),
      }),
    ).toMatchObject({ status: 'failed' });
    expect(
      await resource.db.query.creditReservations.findFirst({
        where: eq(creditReservations.id, fixture.reservation.id),
      }),
    ).toMatchObject({ status: 'released', releasedAmount: '2.00' });
    expect(
      await resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.user.id),
      }),
    ).toMatchObject({ balance: '10.00', frozen: '0.00' });
    expect(
      await resource.db.query.creditLedger.findMany({
        where: eq(creditLedger.reservationId, fixture.reservation.id),
      }),
    ).toHaveLength(2);
    expect(
      await resource.db.query.adminAuditLogs.findMany({
        where: eq(adminAuditLogs.targetId, review.id),
      }),
    ).toHaveLength(1);
  });
});

async function createPublicationFixture(storageRoot: string) {
  const suffix = randomUUID();
  const [user] = await resource.db
    .insert(users)
    .values({
      email: `s12-publication-${suffix}@example.test`,
      displayName: 'S12 publication user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create S12 publication user');
  await resource.db.insert(creditAccounts).values({
    userId: user.id,
    balance: '8.00',
    frozen: '2.00',
    version: 2,
  });
  await resource.db.insert(creditLedger).values({
    userId: user.id,
    type: 'grant',
    amount: '10.00',
    idempotencyKey: `s12-publication-grant-${suffix}`,
    accountVersion: 1,
    balanceAfter: '10.00',
    frozenAfter: '0.00',
    metadata: { test_run_id: suffix },
  });
  const [session] = await resource.db
    .insert(chatSessions)
    .values({ userId: user.id, title: 'S12 publication session' })
    .returning();
  if (!session) throw new Error('Failed to create S12 publication session');
  const [quote] = await resource.db
    .insert(runQuotes)
    .values({
      userId: user.id,
      source: 'chat',
      status: 'submitted',
      promptPreview: {},
      estimatedCallCount: 1,
      estimatedTotalCredits: '2.00',
      idempotencyKey: `s12-publication-quote-${suffix}`,
      inputSignature: `s12-publication-signature-${suffix}`,
      confirmationSnapshot: {},
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
      confirmedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    .returning();
  if (!quote) throw new Error('Failed to create S12 publication quote');
  const [reservation] = await resource.db
    .insert(creditReservations)
    .values({
      userId: user.id,
      estimatedAmount: '2.00',
      status: 'frozen',
      idempotencyKey: `s12-publication-reservation-${suffix}`,
    })
    .returning();
  if (!reservation) throw new Error('Failed to create S12 publication reservation');
  await resource.db.insert(creditLedger).values({
    userId: user.id,
    type: 'reservation_freeze',
    amount: '-2.00',
    reservationId: reservation.id,
    idempotencyKey: `freeze:reservation:${reservation.id}`,
    accountVersion: 2,
    balanceAfter: '8.00',
    frozenAfter: '2.00',
    metadata: { test_run_id: suffix },
  });
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId: user.id,
      triggerMode: 'chat',
      runQuoteId: quote.id,
      reservationId: reservation.id,
      status: 'running',
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
    })
    .returning();
  if (!workflow) throw new Error('Failed to create S12 publication workflow');
  await Promise.all([
    resource.db
      .update(runQuotes)
      .set({ workflowRunId: workflow.id })
      .where(eq(runQuotes.id, quote.id)),
    resource.db
      .update(creditReservations)
      .set({ workflowRunId: workflow.id })
      .where(eq(creditReservations.id, reservation.id)),
  ]);
  const [model] = await resource.db
    .insert(models)
    .values({
      provider: 'fake',
      modelId: `s12-moderation-${suffix}`,
      version: '1',
      capabilityContractJson: { capabilities: ['moderation.image'] },
      pricingJson: {},
      quotaJson: {},
      status: 'poc_passed',
    })
    .returning();
  if (!model) throw new Error('Failed to create S12 moderation model');
  const [generationTask] = await resource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow.id,
      type: 'image.generate',
      status: 'running',
      costEstimate: '2.00',
      idempotencyKey: `s12-publication-generation-${suffix}`,
      dagNodeId: 'image-generate',
      dagJson: {},
      paramsSnapshot: {},
    })
    .returning();
  if (!generationTask) throw new Error('Failed to create S12 generation task');
  const [generationAttempt] = await resource.db
    .insert(taskAttempts)
    .values({
      taskId: generationTask.id,
      attemptNo: 1,
      status: 'succeeded',
      dispatchState: 'accepted',
      provider: 'fake',
      providerReportedCost: '0.20',
      endedAt: new Date(),
    })
    .returning();
  if (!generationAttempt) throw new Error('Failed to create S12 generation attempt');

  const storage = new LocalPrivateStorage(storageRoot);
  await storage.initialize();
  const outputs = [];
  for (let index = 0; index < 2; index += 1) {
    const bytes = await sharp({
      create: {
        width: 12,
        height: 8,
        channels: 4,
        background: index === 0 ? '#ef4444' : '#22c55e',
      },
    })
      .png()
      .toBuffer();
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const storageKey = `s12/${suffix}/artifacts/output-${index}.png`;
    await storage.writeExclusive(storageKey, bytes);
    const [moderationTask] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: workflow.id,
        parentTaskId: generationTask.id,
        type: 'moderation.image',
        status: 'running',
        modelId: model.id,
        modelVersion: model.version,
        costEstimate: '0.00',
        idempotencyKey: `s12-publication-moderation-${suffix}-${index}`,
        dagNodeId: `moderation-${index}`,
        dagJson: {},
        paramsSnapshot: {},
      })
      .returning();
    if (!moderationTask) throw new Error('Failed to create S12 moderation task');
    const [moderationAttempt] = await resource.db
      .insert(taskAttempts)
      .values({
        taskId: moderationTask.id,
        attemptNo: 1,
        status: 'accepted',
        dispatchState: 'accepted',
        provider: 'fake',
        acceptedAt: new Date(),
      })
      .returning();
    if (!moderationAttempt) throw new Error('Failed to create S12 moderation attempt');
    const [artifact] = await resource.db
      .insert(artifacts)
      .values({
        taskId: generationTask.id,
        userId: user.id,
        type: 'image',
        storageKey,
        contentHash,
        metaJson: { output_index: index, media_type: 'image/png', width: 12, height: 8 },
        paramsSnapshot: {},
        sourceAction: 'generate',
        originDomain: 'creative',
        producerMode: 'chat',
        producerSessionId: session.id,
        mutationOwner: 'chat_session',
        visibility: 'quarantined',
      })
      .returning();
    if (!artifact) throw new Error('Failed to create S12 artifact');
    const [evaluation] = await resource.db
      .insert(artifactEvaluations)
      .values({
        artifactId: artifact.id,
        taskId: moderationTask.id,
        taskAttemptId: moderationAttempt.id,
        modelSnapshotId: model.id,
        evaluatorType: 'content_safety',
        evaluatorVersion: 'content-safety@1',
        operationKey: createHash('sha256').update(`${suffix}:${index}`).digest('hex'),
        evidenceSnapshot: {},
        findingsJson: { decision: 'pass' },
        confidence: '1.0000',
        status: 'pass',
      })
      .returning();
    if (!evaluation) throw new Error('Failed to create S12 artifact evaluation');
    outputs.push({ artifact, evaluation, moderationTask, moderationAttempt });
  }
  return {
    user,
    session,
    quote,
    reservation,
    workflow,
    model,
    generationTask,
    generationAttempt,
    outputs,
  };
}

async function cleanupFixture(fixture: Awaited<ReturnType<typeof createPublicationFixture>>) {
  await resource.db.delete(eventOutbox).where(eq(eventOutbox.scopeId, fixture.workflow.id));
  const reviewIds = await resource.db.query.contentReviewCases.findMany({
    where: inArray(
      contentReviewCases.artifactId,
      fixture.outputs.map((item) => item.artifact.id),
    ),
    columns: { id: true },
  });
  if (reviewIds.length > 0) {
    await resource.db.delete(adminAuditLogs).where(
      inArray(
        adminAuditLogs.targetId,
        reviewIds.map((item) => item.id),
      ),
    );
    await resource.db.delete(contentReviewCases).where(
      inArray(
        contentReviewCases.id,
        reviewIds.map((item) => item.id),
      ),
    );
  }
  await resource.db
    .delete(queueDispatchIntents)
    .where(
      inArray(queueDispatchIntents.aggregateId, [
        fixture.generationAttempt.id,
        fixture.generationTask.id,
        ...fixture.outputs.flatMap((item) => [item.moderationTask.id, item.moderationAttempt.id]),
      ]),
    );
  await resource.db.delete(artifactEvaluations).where(
    inArray(
      artifactEvaluations.artifactId,
      fixture.outputs.map((item) => item.artifact.id),
    ),
  );
  await resource.db.delete(artifacts).where(
    inArray(
      artifacts.id,
      fixture.outputs.map((item) => item.artifact.id),
    ),
  );
  await resource.db
    .delete(taskAttempts)
    .where(
      inArray(taskAttempts.id, [
        fixture.generationAttempt.id,
        ...fixture.outputs.map((item) => item.moderationAttempt.id),
      ]),
    );
  await resource.db.delete(tasks).where(
    inArray(
      tasks.id,
      fixture.outputs.map((item) => item.moderationTask.id),
    ),
  );
  await resource.db.delete(tasks).where(eq(tasks.id, fixture.generationTask.id));
  await resource.db
    .update(runQuotes)
    .set({ workflowRunId: null })
    .where(eq(runQuotes.id, fixture.quote.id));
  await resource.db
    .update(creditReservations)
    .set({ workflowRunId: null })
    .where(eq(creditReservations.id, fixture.reservation.id));
  await resource.db.delete(creditLedger).where(eq(creditLedger.userId, fixture.user.id));
  await resource.db.delete(workflowRuns).where(eq(workflowRuns.id, fixture.workflow.id));
  await resource.db
    .delete(creditReservations)
    .where(eq(creditReservations.id, fixture.reservation.id));
  await resource.db.delete(runQuotes).where(eq(runQuotes.id, fixture.quote.id));
  await resource.db.delete(models).where(eq(models.id, fixture.model.id));
  await resource.db.delete(chatSessions).where(eq(chatSessions.id, fixture.session.id));
  await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, fixture.user.id));
  await resource.db.delete(users).where(eq(users.id, fixture.user.id));
}

function config(storageRoot: string): WorkerConfig {
  return { ...integrationWorkerConfig, localUploadRoot: storageRoot };
}
