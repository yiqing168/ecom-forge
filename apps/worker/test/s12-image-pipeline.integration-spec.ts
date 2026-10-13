import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adminPrincipals,
  agentTurns,
  artifacts,
  chatMessages,
  chatSessions,
  createDatabaseClient,
  creditAccounts,
  creditLedger,
  creditReservations,
  eq,
  eventOutbox,
  inArray,
  models,
  providerCallbackEvents,
  queueDispatchIntents,
  runQuotes,
  storageChannels,
  storageCredentialVersions,
  storageValidationRuns,
  taskAttempts,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import {
  consumeReservationInTransaction,
  freezeReservationInTransaction,
} from '@ecom-forge/credit';
import { ProviderImageOutputLease, type ProviderImageExecutionOutcome } from '@ecom-forge/provider';
import { AGENT_IMAGE_FAILURES, canonicalSha256 } from '@ecom-forge/shared';
import { LocalPrivateStorage } from '@ecom-forge/storage';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { ImageOutputIngestService } from '../src/image/image-output-ingest.service.js';
import { ImagePipelineService } from '../src/image/image-pipeline.service.js';
import type { ImageDispatcher } from '../src/image/approved-image.dispatcher.js';
import { WorkerWriteFence } from '../src/lifecycle/processing-fence.js';
import { ProviderCallbackService } from '../src/provider/provider-callback.service.js';
import { OutcomeUnknownReleaseSweeper } from '../src/provider/outcome-unknown-release.sweeper.js';
import { integrationWorkerConfig, testDatabaseUrl } from './s05-integration.fixture.js';

const resource = createDatabaseClient({ databaseUrl: testDatabaseUrl, maxConnections: 10 });

describe('S12 image generation pipeline integration', () => {
  let storageRoot: string;
  let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'ecom-forge-s12-image-'));
    fixture = await createFixture();
  });

  afterEach(async () => {
    if (fixture) await cleanupFixture(fixture);
    fixture = undefined;
    await rm(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await resource.client.end();
  });

  it('ingests a bounded Provider output into quarantine and queues post-moderation once', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const bytes = await sharp({
      create: { width: 16, height: 12, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const dispatch = vi.fn<ImageDispatcher>(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return succeededOutcome(bytes, contentHash);
    });
    const service = pipeline(storageRoot, dispatch);

    await expect(service.execute(fixture.payload)).resolves.toBe('handled');
    await expect(service.execute(fixture.payload)).resolves.toBe('handled');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const [attempt, artifact, moderationTask, intents] = await Promise.all([
      resource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, fixture.generationTaskId),
      }),
      resource.db.query.artifacts.findFirst({
        where: eq(artifacts.taskId, fixture.generationTaskId),
      }),
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.moderationTaskId) }),
      resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, fixture.moderationTaskId),
      }),
    ]);
    expect(attempt).toMatchObject({
      status: 'succeeded',
      dispatchState: 'accepted',
      providerReportedCost: '0.20',
    });
    expect(artifact).toMatchObject({
      visibility: 'quarantined',
      contentHash,
      storageChannelId: fixture.storageChannelId,
    });
    expect(moderationTask?.status).toBe('queued');
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      queueName: 'moderation',
      payloadVersion: 4,
      status: 'pending',
      payload: {
        schema_version: 4,
        job_type: 'moderation.execute',
        task_id: fixture.moderationTaskId,
      },
    });
    if (!artifact) throw new Error('Expected quarantined artifact');
    const stored = await new LocalPrivateStorage(storageRoot).read(artifact.storageKey);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(contentHash);
  });

  it('keeps an ambiguous Provider dispatch waiting and never submits it again', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const diagnostic = {
      phase: 'response_headers' as const,
      elapsed_ms: 139_045,
      total_elapsed_ms: 139_045,
      aborted: false,
      deadline_exceeded: false,
      network_code: 'UND_ERR_SOCKET' as const,
    };
    const telemetry = { info: vi.fn(), error: vi.fn() };
    const dispatch = vi.fn<ImageDispatcher>(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return {
        kind: 'outcome_unknown',
        provider_request_id: 'provider-request-unknown',
        error_code: 'provider_timeout',
        request_digest: canonicalSha256({ task: input.taskId }),
        unknown_at: new Date(),
        transport_diagnostic: diagnostic,
      };
    });
    const service = pipeline(storageRoot, dispatch, new WorkerWriteFence(), telemetry);

    await expect(service.execute(fixture.payload)).resolves.toBe('handled');
    await expect(service.execute(fixture.payload)).resolves.toBe('handled');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [task, attempt, outputRows] = await Promise.all([
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.generationTaskId) }),
      resource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, fixture.generationTaskId),
      }),
      resource.db.query.artifacts.findMany({
        where: eq(artifacts.taskId, fixture.generationTaskId),
      }),
    ]);
    expect(task).toMatchObject({
      status: 'waiting_manual_review',
      errorCode: 'provider_timeout',
    });
    expect(attempt).toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
      providerRequestId: 'provider-request-unknown',
      rawErrorSummary: { transport_diagnostic: diagnostic },
    });
    expect(telemetry.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'image_provider_dispatch_started',
        task_id: fixture.generationTaskId,
      }),
    );
    expect(telemetry.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'image_provider_dispatch_completed',
        task_id: fixture.generationTaskId,
        attempt_id: attempt?.id,
        provider_request_id: 'provider-request-unknown',
        transport_diagnostic: diagnostic,
        automatic_retry_allowed: false,
      }),
    );
    expect(outputRows).toEqual([]);
  });

  it('ignores success and failure callbacks across unknown release without charging or publishing', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    await resource.db
      .update(agentTurns)
      .set({ status: 'waiting_provider_confirmation' })
      .where(eq(agentTurns.id, fixture.turnId));
    const dispatch = vi.fn<ImageDispatcher>(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return {
        kind: 'outcome_unknown',
        provider_request_id: 'provider-request-release-once',
        error_code: 'provider_timeout',
        request_digest: canonicalSha256({ task: input.taskId }),
        unknown_at: new Date(),
      };
    });
    await pipeline(storageRoot, dispatch).execute(fixture.payload);
    const attempt = await resource.db.query.taskAttempts.findFirst({
      where: eq(taskAttempts.taskId, fixture.generationTaskId),
    });
    if (!attempt?.endedAt) throw new Error('Unknown attempt must have an end timestamp');
    const currentFixture = fixture;
    const deliverCallback = async (kind: 'succeeded' | 'failed', receivedAt: Date) => {
      const [event] = await resource.db
        .insert(providerCallbackEvents)
        .values({
          provider: 'fake',
          dedupKey: randomUUID(),
          providerRequestId: 'provider-request-release-once',
          normalizedPayloadJson: {
            kind,
            signature_key_id: 'test-webhook-v1',
            event_id: randomUUID(),
            provider_request_id: 'provider-request-release-once',
            receipt_summary: { provider_status: kind },
            ...(kind === 'succeeded'
              ? {
                  completed_at: receivedAt.toISOString(),
                  outputs: [{ provider_output_id: randomUUID(), media_type: 'image' }],
                  cost_summary: { currency: 'CNY', amount: '0.20', provider_units: '1' },
                }
              : { error_code: 'provider_internal_error', failed_at: receivedAt.toISOString() }),
          },
          rawSummaryJson: { schema_version: 1 },
          signatureKeyId: 'test-v1',
          bodyDigest: randomUUID(),
          receivedAt,
        })
        .returning();
      if (!event) throw new Error('Unknown callback event was not created');
      currentFixture.callbackEventIds.push(event.id);
      await expect(
        new ProviderCallbackService(resource.db, () => receivedAt).process({
          schema_version: 1,
          job_type: 'provider.callback.process',
          trace_id: randomUUID(),
          provider_callback_event_id: event.id,
          processing_no: 1,
        }),
      ).resolves.toEqual({ action: 'dead_letter' });
      await expect(
        resource.db.query.providerCallbackEvents.findFirst({
          where: eq(providerCallbackEvents.id, event.id),
        }),
      ).resolves.toMatchObject({
        status: 'dead_letter',
        errorCode: 'PROVIDER_CALLBACK_LATE_UNKNOWN',
        taskAttemptId: attempt.id,
      });
    };

    const sweeper = new OutcomeUnknownReleaseSweeper(
      resource.db,
      integrationWorkerConfig,
      new WorkerWriteFence(),
    );
    const deadline = integrationWorkerConfig.outcomeUnknownReleaseDeadlineMs;
    await deliverCallback('succeeded', new Date(attempt.endedAt.getTime() + 5 * 60 * 1_000));
    await deliverCallback('failed', new Date(attempt.endedAt.getTime() + 10 * 60 * 1_000));
    const [beforeReleaseAccount, beforeReleaseLedger, beforeReleaseArtifacts] = await Promise.all([
      resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.userId),
      }),
      resource.db.query.creditLedger.findMany({
        where: eq(creditLedger.userId, fixture.userId),
      }),
      resource.db.query.artifacts.findMany({
        where: eq(artifacts.taskId, fixture.generationTaskId),
      }),
    ]);
    expect(beforeReleaseAccount).toMatchObject({ balance: '8.00', frozen: '2.00' });
    expect(beforeReleaseLedger.filter((entry) => entry.type === 'consume')).toHaveLength(0);
    expect(beforeReleaseArtifacts).toHaveLength(0);
    await expect(sweeper.sweep(new Date(attempt.endedAt.getTime() + deadline - 1))).resolves.toBe(
      0,
    );
    const released = await Promise.all([
      sweeper.sweep(new Date(attempt.endedAt.getTime() + deadline)),
      sweeper.sweep(new Date(attempt.endedAt.getTime() + deadline)),
    ]);
    expect(released.sort()).toEqual([0, 1]);
    await expect(sweeper.sweep(new Date(attempt.endedAt.getTime() + deadline + 1))).resolves.toBe(
      0,
    );
    await deliverCallback('succeeded', new Date(attempt.endedAt.getTime() + deadline + 1));

    const [
      account,
      reservation,
      generationTask,
      moderationTask,
      workflow,
      persistedAttempt,
      ledger,
      outputRows,
    ] = await Promise.all([
      resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.userId),
      }),
      resource.db.query.creditReservations.findFirst({
        where: eq(creditReservations.id, fixture.reservationId),
      }),
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.generationTaskId) }),
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.moderationTaskId) }),
      resource.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, fixture.workflowId) }),
      resource.db.query.taskAttempts.findFirst({ where: eq(taskAttempts.id, attempt.id) }),
      resource.db.query.creditLedger.findMany({
        where: eq(creditLedger.userId, fixture.userId),
      }),
      resource.db.query.artifacts.findMany({
        where: eq(artifacts.taskId, fixture.generationTaskId),
      }),
    ]);
    expect(account).toMatchObject({ balance: '10.00', frozen: '0.00', version: 3 });
    expect(reservation).toMatchObject({
      settledAmount: '0.00',
      releasedAmount: '2.00',
      status: 'released',
    });
    expect(generationTask).toMatchObject({ status: 'failed', costActual: '0.00' });
    expect(moderationTask).toMatchObject({ status: 'blocked' });
    expect(workflow).toMatchObject({ status: 'failed' });
    expect(persistedAttempt).toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
      providerRequestId: 'provider-request-release-once',
    });
    expect(ledger.filter((entry) => entry.type === 'release')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(0);
    expect(outputRows).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(ledger.find((entry) => entry.type === 'release')).toMatchObject({
      amount: '2.00',
      taskId: fixture.generationTaskId,
    });
    const failures = await resource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, fixture.turnId),
    });
    expect(failures.filter((event) => event.eventType === 'turn.failed')).toHaveLength(1);
    expect(failures.find((event) => event.eventType === 'turn.failed')?.payload).toMatchObject(
      AGENT_IMAGE_FAILURES.unknownReleased,
    );
    const replies = await resource.db.query.chatMessages.findMany({
      where: eq(chatMessages.turnId, fixture.turnId),
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toBe(AGENT_IMAGE_FAILURES.unknownReleased.summary);
  });

  it('releases only the unknown task amount after another task has settled', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    await resource.db
      .update(tasks)
      .set({ costEstimate: '1.00' })
      .where(eq(tasks.id, fixture.generationTaskId));
    const [settledTask] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: fixture.workflowId,
        type: 'image.generate',
        status: 'succeeded',
        costEstimate: '1.00',
        costActual: '1.00',
        idempotencyKey: `s12-image-settled-${randomUUID()}`,
        dagNodeId: 'image-settled',
        dagJson: {},
        paramsSnapshot: { output_count: 1 },
        endedAt: new Date(),
      })
      .returning();
    if (!settledTask) throw new Error('Failed to create settled sibling task');
    fixture.extraTaskIds.push(settledTask.id);
    const [settledAttempt] = await resource.db
      .insert(taskAttempts)
      .values({
        taskId: settledTask.id,
        attemptNo: 1,
        status: 'succeeded',
        dispatchState: 'accepted',
        provider: 'fake',
        endedAt: new Date(),
      })
      .returning();
    if (!settledAttempt) throw new Error('Failed to create settled sibling attempt');
    await resource.db.transaction((transaction) =>
      consumeReservationInTransaction(transaction, {
        userId: fixture!.userId,
        reservationId: fixture!.reservationId,
        taskAttemptId: settledAttempt.id,
        amount: '1.00',
        idempotencyKey: `s12-image-consume-${settledAttempt.id}`,
      }),
    );

    const dispatch = vi.fn<ImageDispatcher>(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return {
        kind: 'outcome_unknown',
        error_code: 'provider_timeout',
        request_digest: canonicalSha256({ task: input.taskId }),
        unknown_at: new Date(),
      };
    });
    await pipeline(storageRoot, dispatch).execute(fixture.payload);
    const unknownAttempt = await resource.db.query.taskAttempts.findFirst({
      where: eq(taskAttempts.taskId, fixture.generationTaskId),
    });
    if (!unknownAttempt?.endedAt) throw new Error('Unknown attempt must have an end timestamp');
    const sweeper = new OutcomeUnknownReleaseSweeper(
      resource.db,
      integrationWorkerConfig,
      new WorkerWriteFence(),
    );
    await expect(
      sweeper.sweep(
        new Date(
          unknownAttempt.endedAt.getTime() +
            integrationWorkerConfig.outcomeUnknownReleaseDeadlineMs,
        ),
      ),
    ).resolves.toBe(1);

    const [account, reservation, ledger] = await Promise.all([
      resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, fixture.userId),
      }),
      resource.db.query.creditReservations.findFirst({
        where: eq(creditReservations.id, fixture.reservationId),
      }),
      resource.db.query.creditLedger.findMany({
        where: eq(creditLedger.userId, fixture.userId),
      }),
    ]);
    expect(account).toMatchObject({ balance: '9.00', frozen: '0.00', version: 4 });
    expect(reservation).toMatchObject({
      settledAmount: '1.00',
      releasedAmount: '1.00',
      status: 'settled',
    });
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.type === 'release')).toHaveLength(1);
    expect(ledger.find((entry) => entry.type === 'release')).toMatchObject({
      amount: '1.00',
      taskId: fixture.generationTaskId,
    });
  });

  it('does not block a queued child in another workflow that reuses the old parent id', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const [foreignWorkflow] = await resource.db
      .insert(workflowRuns)
      .values({
        userId: fixture.userId,
        triggerMode: 'chat',
        status: 'running',
        planSnapshot: {},
        skillSnapshot: {},
        pricingSnapshot: {},
      })
      .returning();
    if (!foreignWorkflow) throw new Error('Failed to create foreign workflow');
    fixture.extraWorkflowIds.push(foreignWorkflow.id);

    const [foreignChild] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: foreignWorkflow.id,
        parentTaskId: fixture.generationTaskId,
        type: 'moderation.image',
        status: 'queued',
        costEstimate: '0.00',
        idempotencyKey: `s12-image-cross-workflow-child-${randomUUID()}`,
        dagNodeId: 'cross-workflow-child',
        dagJson: {},
        paramsSnapshot: {},
      })
      .returning();
    if (!foreignChild) throw new Error('Failed to create foreign child task');
    fixture.extraTaskIds.push(foreignChild.id);

    const dispatch = vi.fn<ImageDispatcher>(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return {
        kind: 'outcome_unknown',
        error_code: 'provider_timeout',
        request_digest: canonicalSha256({ task: input.taskId }),
        unknown_at: new Date(),
      };
    });
    await pipeline(storageRoot, dispatch).execute(fixture.payload);
    const unknownAttempt = await resource.db.query.taskAttempts.findFirst({
      where: eq(taskAttempts.taskId, fixture.generationTaskId),
    });
    if (!unknownAttempt?.endedAt) throw new Error('Unknown attempt must have an end timestamp');

    const sweeper = new OutcomeUnknownReleaseSweeper(
      resource.db,
      integrationWorkerConfig,
      new WorkerWriteFence(),
    );
    await expect(
      sweeper.sweep(
        new Date(
          unknownAttempt.endedAt.getTime() +
            integrationWorkerConfig.outcomeUnknownReleaseDeadlineMs,
        ),
      ),
    ).resolves.toBe(1);

    const [originalChild, persistedForeignChild, persistedForeignWorkflow] = await Promise.all([
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.moderationTaskId) }),
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, foreignChild.id) }),
      resource.db.query.workflowRuns.findFirst({ where: eq(workflowRuns.id, foreignWorkflow.id) }),
    ]);
    expect(originalChild?.status).toBe('blocked');
    expect(persistedForeignChild).toMatchObject({ status: 'queued' });
    expect(persistedForeignWorkflow).toMatchObject({ status: 'running' });
  });

  it('classifies a dispatcher exception before the transport boundary as not dispatched', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const dispatch = vi.fn<ImageDispatcher>(() => {
      throw new Error('INVALID_PROVIDER_INPUT');
    });
    const service = pipeline(storageRoot, dispatch);

    await expect(service.execute(fixture.payload)).resolves.toBe('handled');

    const [generationTask, attempt, moderationTask] = await Promise.all([
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.generationTaskId) }),
      resource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, fixture.generationTaskId),
      }),
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.moderationTaskId) }),
    ]);
    expect(generationTask).toMatchObject({
      status: 'failed',
      errorCode: 'IMAGE_PROVIDER_PREPARATION_FAILED',
    });
    expect(attempt).toMatchObject({ status: 'failed', dispatchState: 'not_dispatched' });
    expect(moderationTask).toMatchObject({
      status: 'cancelled',
      errorCode: 'UPSTREAM_TASK_FAILED',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('retries a transient pre-dispatch failure once without allocating a new attempt', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const bytes = await sharp({
      create: { width: 16, height: 12, channels: 4, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const dispatch = vi
      .fn<ImageDispatcher>()
      .mockResolvedValueOnce({
        kind: 'not_dispatched',
        error_code: 'provider_unavailable',
        retryable: true,
        request_digest: 'a'.repeat(64),
      })
      .mockImplementation(async (input) => {
        expect(await input.markPotentiallyDispatched()).toBe(true);
        return succeededOutcome(bytes, createHash('sha256').update(bytes).digest('hex'));
      });
    const service = pipeline(storageRoot, dispatch);
    await Promise.all([service.execute(fixture.payload), service.execute(fixture.payload)]);
    await service.execute(fixture.payload);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const attempts = await resource.db.query.taskAttempts.findMany({
      where: eq(taskAttempts.taskId, fixture.generationTaskId),
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'succeeded', attemptNo: 1 });
    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, fixture.userId),
    });
    expect(ledger.filter((entry) => entry.type === 'reservation_freeze')).toHaveLength(1);
  });

  it.each([
    'provider_request_invalid',
    'provider_auth_failed',
    'provider_quota_exhausted',
  ] as const)(
    'never retries permanent %s even if an adapter marks it retryable',
    async (errorCode) => {
      if (!fixture) throw new Error('Missing S12 image fixture');
      const dispatch = vi.fn<ImageDispatcher>().mockResolvedValue({
        kind: 'not_dispatched',
        error_code: errorCode,
        retryable: true,
        request_digest: 'a'.repeat(64),
      });
      await pipeline(storageRoot, dispatch).execute(fixture.payload);
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not retry a not-dispatched receipt after the persisted transport fence', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const dispatch = vi.fn<ImageDispatcher>(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return {
        kind: 'not_dispatched',
        error_code: 'provider_unavailable',
        retryable: true,
        request_digest: 'a'.repeat(64),
      };
    });
    const service = pipeline(storageRoot, dispatch);
    await service.execute(fixture.payload);
    await service.execute(fixture.payload);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const attempt = await resource.db.query.taskAttempts.findFirst({
      where: eq(taskAttempts.taskId, fixture.generationTaskId),
    });
    expect(attempt).toMatchObject({ status: 'outcome_unknown', dispatchState: 'outcome_unknown' });
  });

  it('stops a retry when the workflow is cancelled before redispatch', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const current = fixture;
    const dispatch = vi.fn<ImageDispatcher>(async () => {
      await resource.db
        .update(workflowRuns)
        .set({ status: 'cancelled' })
        .where(eq(workflowRuns.id, current.workflowId));
      return {
        kind: 'not_dispatched',
        error_code: 'provider_unavailable',
        retryable: true,
        request_digest: 'a'.repeat(64),
      };
    });
    await pipeline(storageRoot, dispatch).execute(fixture.payload);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('interrupts retry backoff when the Worker write fence closes', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const fence = new WorkerWriteFence();
    const dispatch = vi.fn<ImageDispatcher>(() => {
      setTimeout(() => fence.disableWrites(), 25);
      return Promise.resolve({
        kind: 'not_dispatched',
        error_code: 'provider_unavailable',
        retryable: true,
        request_digest: 'a'.repeat(64),
      });
    });
    await pipeline(storageRoot, dispatch, fence).execute(fixture.payload);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fence.isWriteAllowed()).toBe(false);
  });

  it('classifies a dispatcher exception after the transport boundary as outcome unknown', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const dispatch = vi.fn<ImageDispatcher>(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      throw new Error('TRANSPORT_RESPONSE_LOST');
    });
    const service = pipeline(storageRoot, dispatch);

    await expect(service.execute(fixture.payload)).resolves.toBe('handled');

    const [generationTask, attempt] = await Promise.all([
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.generationTaskId) }),
      resource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, fixture.generationTaskId),
      }),
    ]);
    expect(generationTask).toMatchObject({
      status: 'waiting_manual_review',
      errorCode: 'IMAGE_PROVIDER_DISPATCH_UNKNOWN',
    });
    expect(attempt).toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
    });
  });

  it('cancels pending post-moderation when the Provider was not dispatched', async () => {
    if (!fixture) throw new Error('Missing S12 image fixture');
    const current = fixture;
    const dispatch = vi.fn<ImageDispatcher>(() =>
      Promise.resolve({
        kind: 'not_dispatched',
        error_code: 'provider_unavailable',
        retryable: true,
        request_digest: canonicalSha256({ fixture: current.generationTaskId }),
      }),
    );
    const service = pipeline(storageRoot, dispatch);

    await expect(service.execute(fixture.payload)).resolves.toBe('handled');

    const [generationTask, moderationTask] = await Promise.all([
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.generationTaskId) }),
      resource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.moderationTaskId) }),
    ]);
    expect(generationTask).toMatchObject({
      status: 'failed',
      errorCode: 'provider_unavailable',
    });
    expect(moderationTask).toMatchObject({
      status: 'cancelled',
      errorCode: 'UPSTREAM_TASK_FAILED',
    });
    expect(dispatch).toHaveBeenCalledTimes(4);
    const attempts = await resource.db.query.taskAttempts.findMany({
      where: eq(taskAttempts.taskId, fixture.generationTaskId),
    });
    expect(attempts).toHaveLength(1);
    expect(new Set(dispatch.mock.calls.map(([input]) => input.attemptId)).size).toBe(1);
    expect(
      new Set(
        dispatch.mock.calls.map(
          ([input]) => (input.paramsSnapshot as { operation_key: string }).operation_key,
        ),
      ).size,
    ).toBe(1);
    await service.execute(fixture.payload);
    expect(dispatch).toHaveBeenCalledTimes(4);
  });
});

function pipeline(
  storageRoot: string,
  dispatch: ImageDispatcher,
  writeFence = new WorkerWriteFence(),
  telemetry?: ConstructorParameters<typeof ImagePipelineService>[4],
) {
  const config = { ...integrationWorkerConfig, localUploadRoot: storageRoot };
  return new ImagePipelineService(
    resource.db,
    dispatch,
    new ImageOutputIngestService(resource.db, config, writeFence),
    writeFence,
    telemetry,
  );
}

function succeededOutcome(
  bytes: Uint8Array,
  contentHash: string,
  width = 16,
  height = 12,
): ProviderImageExecutionOutcome {
  const requestId = randomUUID();
  return {
    kind: 'succeeded',
    provider_request_id: `provider-request-${requestId}`,
    receipt_summary: { request_id_hint: requestId.slice(0, 12), provider_status: 'succeeded' },
    accepted_at: new Date(),
    completed_at: new Date(),
    outputs: [
      new ProviderImageOutputLease(
        {
          provider_output_id: `provider-output-${requestId}`,
          media_type: 'image/png',
          byte_length: bytes.byteLength,
          width,
          height,
          content_hash: contentHash,
        },
        bytes,
      ),
    ],
    cost_summary: { currency: 'CNY', amount: '0.20', provider_units: '1' },
  };
}

async function createFixture() {
  const suffix = randomUUID();
  const evidenceDigest = canonicalSha256({ storage: suffix });
  const operationKey = canonicalSha256({ operation: suffix });
  const [admin] = await resource.db
    .insert(adminPrincipals)
    .values({
      identifierHash: `s12-image-${suffix}`,
      identifierKeyId: 'test-key',
      identifierHint: 's12-image',
      displayName: 'S12 image admin',
      status: 'active',
    })
    .returning();
  if (!admin) throw new Error('Failed to create S12 image admin');
  const [channel] = await resource.db
    .insert(storageChannels)
    .values({
      purpose: 'private_assets',
      adapterKey: 'local-private-v1',
      endpointProfileKey: 'local',
      bucket: `s12-image-${suffix}`,
      rootPrefix: `s12/${suffix}`,
      status: 'draft',
      createdByAdminId: admin.id,
    })
    .returning();
  if (!channel) throw new Error('Failed to create S12 storage channel');
  const [credential] = await resource.db
    .insert(storageCredentialVersions)
    .values({
      storageChannelId: channel.id,
      versionNo: 1,
      secretBundleCiphertext: 'fixture',
      secretNonce: 'fixture',
      secretAuthTag: 'fixture',
      secretKeyId: 'fixture',
      keyHint: 'fixture',
      status: 'active',
      validationEvidenceDigest: evidenceDigest,
      verifiedAt: new Date(),
      activatedAt: new Date(),
    })
    .returning();
  if (!credential) throw new Error('Failed to create S12 storage credential');
  await resource.db
    .update(storageChannels)
    .set({ status: 'active', activeCredentialVersionId: credential.id })
    .where(eq(storageChannels.id, channel.id));
  const [validation] = await resource.db
    .insert(storageValidationRuns)
    .values({
      storageChannelId: channel.id,
      credentialVersionId: credential.id,
      probeContractVersion: 'local-private@1',
      status: 'passed',
      evidenceDigest,
      probePrefixDigest: canonicalSha256({ prefix: suffix }),
      requestedByAdminId: admin.id,
      completedAt: new Date(),
    })
    .returning();
  if (!validation) throw new Error('Failed to create S12 storage validation');

  const [user] = await resource.db
    .insert(users)
    .values({ email: `s12-image-${suffix}@example.test`, displayName: 'S12 image user' })
    .returning();
  if (!user) throw new Error('Failed to create S12 image user');
  await resource.db.insert(creditAccounts).values({
    userId: user.id,
    balance: '10.00',
    frozen: '0.00',
    version: 1,
  });
  await resource.db.insert(creditLedger).values({
    userId: user.id,
    type: 'grant',
    amount: '10.00',
    idempotencyKey: `s12-image-grant-${suffix}`,
    accountVersion: 1,
    balanceAfter: '10.00',
    frozenAfter: '0.00',
    metadata: { test_run_id: suffix },
  });
  const [session] = await resource.db
    .insert(chatSessions)
    .values({ userId: user.id, title: 'S12 image pipeline' })
    .returning();
  if (!session) throw new Error('Failed to create S12 image session');
  const [quote] = await resource.db
    .insert(runQuotes)
    .values({
      userId: user.id,
      source: 'chat',
      status: 'submitted',
      promptPreview: {},
      estimatedCallCount: 1,
      estimatedTotalCredits: '2.00',
      idempotencyKey: `s12-image-quote-${suffix}`,
      inputSignature: operationKey,
      confirmationSnapshot: {},
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
      confirmedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    })
    .returning();
  if (!quote) throw new Error('Failed to create S12 image quote');
  const [reservation] = await resource.db
    .insert(creditReservations)
    .values({
      userId: user.id,
      estimatedAmount: '2.00',
      idempotencyKey: `s12-image-reservation-${suffix}`,
    })
    .returning();
  if (!reservation) throw new Error('Failed to create S12 image reservation');
  await resource.db.transaction((transaction) =>
    freezeReservationInTransaction(transaction, {
      userId: user.id,
      reservationId: reservation.id,
      amount: '2.00',
      idempotencyKey: `s12-image-freeze-${suffix}`,
    }),
  );
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId: user.id,
      triggerMode: 'chat',
      runQuoteId: quote.id,
      reservationId: reservation.id,
      status: 'queued',
      planSnapshot: { canonical_plan: { intent: { kind: 'commerce_generate' } } },
      skillSnapshot: {},
      pricingSnapshot: {},
    })
    .returning();
  if (!workflow) throw new Error('Failed to create S12 image workflow');
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
  const [turn] = await resource.db
    .insert(agentTurns)
    .values({ sessionId: session.id, userId: user.id, workflowRunId: workflow.id, status: 'done' })
    .returning();
  if (!turn) throw new Error('Failed to create S12 image turn');

  const [generationModel, moderationModel] = await resource.db
    .insert(models)
    .values([
      {
        provider: 'fake',
        modelId: `s12-image-generation-${suffix}`,
        version: '1',
        capabilityContractJson: { capabilities: ['image.generate'] },
        pricingJson: {},
        quotaJson: {},
        status: 'poc_passed',
      },
      {
        provider: 'fake',
        modelId: `s12-image-moderation-${suffix}`,
        version: '1',
        capabilityContractJson: { capabilities: ['moderation.image'] },
        pricingJson: {},
        quotaJson: {},
        status: 'poc_passed',
      },
    ])
    .returning();
  if (!generationModel || !moderationModel) throw new Error('Failed to create S12 models');
  const storageSnapshot = {
    schema_version: 1 as const,
    purpose: 'private_assets' as const,
    runtime_revision: 1,
    channel_id: channel.id,
    channel_revision: channel.revision,
    adapter_key: 'local-private-v1' as const,
    endpoint_profile_key: 'local' as const,
    region: null,
    credential_version_id: credential.id,
    validation_evidence_digest: evidenceDigest,
  };
  const [generationTask] = await resource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow.id,
      type: 'image.generate',
      status: 'queued',
      modelId: generationModel.id,
      modelVersion: generationModel.version,
      costEstimate: '2.00',
      idempotencyKey: `s12-image-generation-${suffix}`,
      dagNodeId: 'image-generate',
      dagJson: {},
      paramsSnapshot: {
        schema_version: 1,
        source: 'chat',
        operation: 'image.generate',
        goal_summary: 'Generate one product image',
        aspect_ratio: '1:1',
        resolution_tier: '1k',
        output_count: 1,
        output_count_source: 'user_explicit',
        model_snapshot: { id: generationModel.id },
        model_selection: { image: { model_snapshot_id: generationModel.id } },
        input_bindings: [],
        operation_key: operationKey,
        depends_on: [],
        storage_snapshot: storageSnapshot,
      },
    })
    .returning();
  if (!generationTask) throw new Error('Failed to create S12 generation task');
  const [moderationTask] = await resource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow.id,
      parentTaskId: generationTask.id,
      type: 'moderation.image',
      status: 'pending',
      modelId: moderationModel.id,
      modelVersion: moderationModel.version,
      costEstimate: '0.00',
      idempotencyKey: `s12-image-moderation-${suffix}`,
      dagNodeId: 'moderation-0',
      dagJson: {},
      paramsSnapshot: {
        schema_version: 1,
        source: 'chat',
        generation_task_key: 'image-generate',
        generation_operation_key: operationKey,
        output_index: 0,
        moderation_route: {
          capability: 'moderation.image',
          runtime_revision: 1,
          model_snapshot_id: moderationModel.id,
          credential_version_id: credential.id,
          policy_version: 'content-safety@1',
          evidence_digest: evidenceDigest,
          pricing_digest: canonicalSha256({ pricing: suffix }),
          risk_adjusted_cost_cny: '0.01',
        },
        storage_snapshot: storageSnapshot,
      },
    })
    .returning();
  if (!moderationTask) throw new Error('Failed to create S12 moderation task');
  return {
    adminId: admin.id,
    storageChannelId: channel.id,
    storageCredentialId: credential.id,
    storageValidationId: validation.id,
    userId: user.id,
    sessionId: session.id,
    quoteId: quote.id,
    reservationId: reservation.id,
    workflowId: workflow.id,
    turnId: turn.id,
    modelIds: [generationModel.id, moderationModel.id],
    generationTaskId: generationTask.id,
    moderationTaskId: moderationTask.id,
    extraTaskIds: [] as string[],
    extraWorkflowIds: [] as string[],
    callbackEventIds: [] as string[],
    payload: {
      schema_version: 1 as const,
      job_type: 'task.execute' as const,
      trace_id: randomUUID(),
      task_id: generationTask.id,
      workflow_run_id: workflow.id,
      user_id: user.id,
    },
  };
}

async function cleanupFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const taskIds = [fixture.generationTaskId, fixture.moderationTaskId, ...fixture.extraTaskIds];
  if (fixture.callbackEventIds.length > 0) {
    await resource.db
      .delete(providerCallbackEvents)
      .where(inArray(providerCallbackEvents.id, fixture.callbackEventIds));
  }
  await resource.db
    .delete(eventOutbox)
    .where(inArray(eventOutbox.scopeId, [fixture.workflowId, fixture.turnId]));
  await resource.db.delete(creditLedger).where(eq(creditLedger.userId, fixture.userId));
  await resource.db
    .delete(queueDispatchIntents)
    .where(inArray(queueDispatchIntents.aggregateId, taskIds));
  await resource.db.delete(artifacts).where(eq(artifacts.taskId, fixture.generationTaskId));
  await resource.db.delete(taskAttempts).where(inArray(taskAttempts.taskId, taskIds));
  await resource.db.delete(tasks).where(inArray(tasks.id, taskIds));
  await resource.db.delete(chatMessages).where(eq(chatMessages.turnId, fixture.turnId));
  await resource.db.delete(agentTurns).where(eq(agentTurns.id, fixture.turnId));
  await resource.db
    .update(runQuotes)
    .set({ workflowRunId: null })
    .where(eq(runQuotes.id, fixture.quoteId));
  await resource.db
    .update(creditReservations)
    .set({ workflowRunId: null })
    .where(eq(creditReservations.id, fixture.reservationId));
  await resource.db
    .delete(workflowRuns)
    .where(inArray(workflowRuns.id, [fixture.workflowId, ...fixture.extraWorkflowIds]));
  await resource.db
    .delete(creditReservations)
    .where(eq(creditReservations.id, fixture.reservationId));
  await resource.db.delete(runQuotes).where(eq(runQuotes.id, fixture.quoteId));
  await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, fixture.userId));
  await resource.db.delete(models).where(inArray(models.id, fixture.modelIds));
  await resource.db.delete(chatSessions).where(eq(chatSessions.id, fixture.sessionId));
  await resource.db.delete(users).where(eq(users.id, fixture.userId));
  await resource.db
    .update(storageChannels)
    .set({ activeCredentialVersionId: null })
    .where(eq(storageChannels.id, fixture.storageChannelId));
  await resource.db
    .delete(storageValidationRuns)
    .where(eq(storageValidationRuns.id, fixture.storageValidationId));
  await resource.db
    .delete(storageCredentialVersions)
    .where(eq(storageCredentialVersions.id, fixture.storageCredentialId));
  await resource.db.delete(storageChannels).where(eq(storageChannels.id, fixture.storageChannelId));
  await resource.db.delete(adminPrincipals).where(eq(adminPrincipals.id, fixture.adminId));
}
