import { randomUUID } from 'node:crypto';

import { Queue } from 'bullmq';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  creditReservations,
  eq,
  eventOutbox,
  inArray,
  models,
  providerCallbackEvents,
  providerCircuitStates,
  queueDispatchIntents,
  runQuotes,
  taskAttempts,
  tasks,
  workflowRuns,
} from '@ecom-forge/db';
import {
  FakeProviderAdapter,
  ProviderGateway,
  ProviderOutcomeRecordingError,
  ProviderRegistry,
  type ModelSnapshot,
  type ProviderAdapter,
  type ProviderCallContext,
} from '@ecom-forge/provider';
import {
  createBullMqConnection,
  parseQueuePayload,
  QueueIntentRepository,
} from '@ecom-forge/queue';

import { loadWorkerConfig } from '../src/config/worker-config.js';
import { TaskAttemptRepository } from '../src/database/attempt.repository.js';
import { ActiveWorkTracker, WorkerWriteFence } from '../src/lifecycle/processing-fence.js';
import { ProviderProcessorWorkers } from '../src/processors/provider-processors.js';
import { BullMqQueuePublisher } from '../src/queue/queue-publisher.js';
import { QueueReconciler } from '../src/queue/reconciler.js';
import { ProviderAttemptService } from '../src/provider/provider-attempt.service.js';
import {
  ProviderCallbackSequenceError,
  ProviderCallbackService,
} from '../src/provider/provider-callback.service.js';
import {
  ProviderCircuitOpenError,
  ProviderCircuitRepository,
} from '../src/provider/provider-circuit.repository.js';
import {
  ProviderQuotaUnavailableError,
  RedisProviderQuotaGate,
} from '../src/provider/redis-provider-quota.gate.js';
import {
  cleanupTrackedResources,
  closeIntegrationInfrastructure,
  createWorkflowFixture,
  databaseResource,
  integrationWorkerConfig,
  redis,
  testDatabaseUrl,
  testRedisPrefix,
  testRedisUrl,
  track,
} from './s05-integration.fixture.js';

function snapshot(id: string): ModelSnapshot {
  return {
    id,
    provider: 'fake',
    model_id: 'fake-image-v1',
    version: id,
    status: 'free_test_only',
    capability_contract: {
      schema_version: 1,
      capabilities: ['image.generate', 'image.edit'],
      aspect_ratios: ['1:1'],
      resolutions: ['1024x1024'],
      max_outputs: 4,
      max_reference_images: 4,
    },
    pricing: {
      schema_version: 1,
      currency: 'CNY',
      provider_unit_cost_cny: '0.10',
      tool_cost_cny: '0.00',
      storage_cost_cny: '0.00',
      traffic_cost_cny: '0.00',
      agent_brain_cost_cny: '0.00',
      failure_rate: '0.00',
      unknown_rate: '0.00',
      refund_rate: '0.00',
      risk_reserve_rate: '0.00',
      gross_margin_target: '0.50',
      credit_cny_anchor: '0.05',
    },
    quota: {
      schema_version: 1,
      rpm: 60,
      concurrency: 2,
      hourly_budget_cny: '10.00',
      daily_budget_cny: '100.00',
      poll_initial_delay_ms: 1,
      poll_interval_ms: 1,
      max_poll_count: 3,
      terminal_timeout_ms: 60_000,
      circuit_sample_size: 10,
      circuit_failure_rate: '0.50',
      circuit_unknown_rate: '0.20',
      circuit_open_ms: 30_000,
    },
  };
}

function fakeAdapterFor(
  model: { modelId: string; version: string },
  scenario: ConstructorParameters<typeof FakeProviderAdapter>[0] = 'succeeded',
): FakeProviderAdapter {
  return new FakeProviderAdapter(scenario, () => new Date(), undefined, {
    modelId: model.modelId,
    version: model.version,
  });
}

function context(deadlineAt = new Date(Date.now() + 10_000)): ProviderCallContext {
  return {
    idempotencyKey: randomUUID(),
    requestDigest: 'b'.repeat(64),
    traceId: randomUUID(),
    deadlineAt,
    signal: new AbortController().signal,
  };
}

function providerInput() {
  return {
    prompt: 'integration-only prompt',
    aspect_ratio: '1:1',
    resolution: '1024x1024',
    output_count: 1,
  };
}

function gateway(adapter: ProviderAdapter, now?: () => Date): ProviderGateway {
  return new ProviderGateway(new ProviderRegistry([adapter]), {
    mode: 'test',
    circuitGate: { assertCanSubmit: () => Promise.resolve() },
    quotaGate: { reserve: () => Promise.resolve() },
    ...(now ? { now } : {}),
  });
}

async function createCallbackEvent(input: { providerRequestId: string; receivedAt?: Date }) {
  const [event] = await databaseResource.db
    .insert(providerCallbackEvents)
    .values({
      provider: 'fake',
      dedupKey: randomUUID(),
      providerRequestId: input.providerRequestId,
      normalizedPayloadJson: {
        kind: 'succeeded',
        signature_key_id: 'test-webhook-v1',
        event_id: randomUUID(),
        provider_request_id: input.providerRequestId,
        receipt_summary: { provider_status: 'succeeded' },
        completed_at: new Date().toISOString(),
        outputs: [
          {
            provider_output_id: randomUUID(),
            media_type: 'image',
          },
        ],
        cost_summary: { currency: 'CNY', amount: '0.10', provider_units: '1' },
      },
      rawSummaryJson: { schema_version: 1 },
      signatureKeyId: 'test-v1',
      bodyDigest: randomUUID(),
      receivedAt: input.receivedAt,
    })
    .returning();
  if (!event) throw new Error('Callback fixture was not created');
  track('callbacks', event.id);
  return event;
}

async function createProviderFixture(
  input: { quota?: Partial<ModelSnapshot['quota']>; taskType?: string } = {},
) {
  const fixture = await createWorkflowFixture({ taskStatus: 'running' });
  if (!fixture.task) throw new Error('Task fixture is required');
  const model = snapshot(randomUUID());
  model.quota = { ...model.quota, ...input.quota };
  const [createdModel] = await databaseResource.db
    .insert(models)
    .values({
      id: model.id,
      provider: model.provider,
      modelId: model.model_id,
      version: model.version,
      capabilityContractJson: model.capability_contract,
      pricingJson: model.pricing,
      quotaJson: model.quota,
      status: model.status,
    })
    .returning();
  if (!createdModel) throw new Error('Provider model fixture was not created');
  track('models', createdModel.id);
  await databaseResource.db
    .insert(providerCircuitStates)
    .values([
      {
        scopeType: 'provider',
        scopeKey: `provider:${createdModel.provider}`,
        provider: createdModel.provider,
      },
      {
        scopeType: 'model',
        scopeKey: `model:${createdModel.id}`,
        provider: createdModel.provider,
        modelId: createdModel.id,
      },
    ])
    .onConflictDoNothing();
  const circuits = await databaseResource.db.query.providerCircuitStates.findMany({
    where: inArray(providerCircuitStates.scopeKey, [
      `provider:${createdModel.provider}`,
      `model:${createdModel.id}`,
    ]),
  });
  for (const circuit of circuits) track('circuits', circuit.id);
  await databaseResource.db
    .update(tasks)
    .set({
      type: input.taskType ?? 'image.generate',
      modelId: createdModel.id,
      modelVersion: createdModel.version,
    })
    .where(eq(tasks.id, fixture.task.id));
  const allocation = await new TaskAttemptRepository(databaseResource.db).allocate({
    taskId: fixture.task.id,
    provider: createdModel.provider,
    maxAttempts: 3,
  });
  track('attempts', allocation.attempt.id);
  return { ...fixture, model: createdModel, attempt: allocation.attempt };
}

async function attachReservation(fixture: Awaited<ReturnType<typeof createProviderFixture>>) {
  const suffix = randomUUID();
  const [quote] = await databaseResource.db
    .insert(runQuotes)
    .values({
      userId: fixture.user.id,
      source: 'chat',
      status: 'submitted',
      promptPreview: {},
      estimatedCallCount: 1,
      estimatedTotalCredits: '1.00',
      idempotencyKey: `s07-quote-${suffix}`,
      inputSignature: `s07-signature-${suffix}`,
      confirmationSnapshot: {},
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  if (!quote) throw new Error('Provider quote fixture was not created');
  track('quotes', quote.id);
  const [reservation] = await databaseResource.db
    .insert(creditReservations)
    .values({
      userId: fixture.user.id,
      estimatedAmount: '1.00',
      status: 'frozen',
      idempotencyKey: `s07-reservation-${suffix}`,
    })
    .returning();
  if (!reservation) throw new Error('Provider reservation fixture was not created');
  track('reservations', reservation.id);
  await databaseResource.db
    .update(workflowRuns)
    .set({ runQuoteId: quote.id, reservationId: reservation.id })
    .where(eq(workflowRuns.id, fixture.workflow.id));
  await databaseResource.db
    .update(runQuotes)
    .set({ workflowRunId: fixture.workflow.id })
    .where(eq(runQuotes.id, quote.id));
  await databaseResource.db
    .update(creditReservations)
    .set({ workflowRunId: fixture.workflow.id })
    .where(eq(creditReservations.id, reservation.id));
  return { ...fixture, quote, reservation };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Provider worker state');
}

describe('S07 Provider attempt orchestration', () => {
  afterEach(cleanupTrackedResources);
  afterAll(closeIntegrationInfrastructure);

  it('records one successful submit without a duplicate Provider call', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model);
    const service = new ProviderAttemptService(databaseResource.db, gateway(adapter));

    const result = await service.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });

    expect(result.action).toBe('recorded');
    expect(adapter.submitCount).toBe(1);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({
      status: 'succeeded',
      dispatchState: 'accepted',
      providerReportedCost: '0.10',
    });
  });

  it('publishes the task wake only after the terminal transaction commits', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model);
    const publish = vi.fn(async () => {
      const task = await databaseResource.db.query.tasks.findFirst({
        where: eq(tasks.id, fixture.task.id),
      });
      const events = await databaseResource.db.query.eventOutbox.findMany({
        where: eq(eventOutbox.scopeId, fixture.workflow.id),
      });
      expect(task?.status).toBe('succeeded');
      expect(events.some((row) => row.eventType === 'task.status_changed')).toBe(true);
    });
    const service = new ProviderAttemptService(
      databaseResource.db,
      gateway(adapter),
      () => new Date(),
      undefined,
      new ProviderCircuitRepository(databaseResource.db),
      { publish },
    );

    await service.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: 'workflow_run',
        scope_id: fixture.workflow.id,
      }),
    );
  });

  it('does not persist a Provider result after the worker write fence closes', async () => {
    const fixture = await createProviderFixture();
    let release!: (outcome: Awaited<ReturnType<ProviderAdapter['submit']>>) => void;
    const adapter: ProviderAdapter = {
      provider: 'fake',
      modelId: fixture.model.modelId,
      version: fixture.model.version,
      capabilities: ['image.generate'],
      submit: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const fence = new WorkerWriteFence();
    const service = new ProviderAttemptService(
      databaseResource.db,
      gateway(adapter),
      () => new Date(),
      fence,
    );
    const submission = service.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });
    await waitFor(async () => {
      const attempt = await databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      });
      return attempt?.status === 'dispatching';
    });

    fence.disableWrites();
    release({
      kind: 'succeeded',
      provider_request_id: `fenced-${randomUUID()}`,
      receipt_summary: { provider_status: 'succeeded' },
      accepted_at: new Date(),
      completed_at: new Date(),
      outputs: [
        {
          provider_output_id: randomUUID(),
          media_type: 'image',
          output_ref: 'fake://fenced/image',
        },
      ],
      cost_summary: { currency: 'CNY', amount: '0.10', provider_units: '1' },
    });

    await expect(submission).rejects.toThrow(/write fence is closed/);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({ status: 'dispatching', dispatchState: 'not_dispatched' });
  });

  it('allows only one Provider call while a duplicate submit is in progress', async () => {
    const fixture = await createProviderFixture();
    let submitCount = 0;
    let signalStarted: (() => void) | undefined;
    let releaseSubmit: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const adapter: ProviderAdapter = {
      provider: 'fake',
      modelId: fixture.model.modelId,
      version: fixture.model.version,
      capabilities: ['image.generate'],
      submit: () => {
        submitCount += 1;
        signalStarted?.();
        return released.then(() => ({
          kind: 'succeeded' as const,
          provider_request_id: `concurrent-${randomUUID()}`,
          receipt_summary: { provider_status: 'succeeded' },
          accepted_at: new Date(),
          completed_at: new Date(),
          outputs: [
            {
              provider_output_id: randomUUID(),
              media_type: 'image' as const,
              output_ref: 'fake://generated/concurrent',
            },
          ],
          cost_summary: { currency: 'CNY' as const, amount: '0.10', provider_units: '1' },
        }));
      },
    };
    const service = new ProviderAttemptService(databaseResource.db, gateway(adapter));
    const first = service.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });
    await started;

    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).resolves.toEqual({ action: 'already_in_progress', attemptId: fixture.attempt.id });
    releaseSubmit?.();
    await expect(first).resolves.toMatchObject({ action: 'recorded' });
    expect(submitCount).toBe(1);
  });

  it('persists a received outcome before surfacing circuit evidence failure', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model);
    const service = new ProviderAttemptService(
      databaseResource.db,
      new ProviderGateway(new ProviderRegistry([adapter]), {
        mode: 'test',
        circuitGate: {
          assertCanSubmit: () => Promise.resolve(),
          recordOutcome: () => Promise.reject(new Error('circuit storage unavailable')),
        },
        quotaGate: { reserve: () => Promise.resolve() },
      }),
    );

    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).rejects.toBeInstanceOf(ProviderOutcomeRecordingError);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({ status: 'succeeded', dispatchState: 'accepted' });
    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).resolves.toEqual({ action: 'already_terminal', attemptId: fixture.attempt.id });
    expect(adapter.submitCount).toBe(1);
  });

  it('recovers a crash after dispatching as unknown without calling submit', async () => {
    const fixture = await createProviderFixture({
      quota: { circuit_sample_size: 1, circuit_unknown_rate: '0.20' },
    });
    const repository = new TaskAttemptRepository(databaseResource.db);
    await repository.advance({
      attemptId: fixture.attempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'dispatching',
      dispatchState: 'not_dispatched',
      now: new Date(Date.now() - 60_000),
    });
    const adapter = fakeAdapterFor(fixture.model);
    const service = new ProviderAttemptService(databaseResource.db, gateway(adapter));

    await expect(
      service.recoverStaleDispatching({ before: new Date(Date.now() - 30_000), limit: 10 }),
    ).resolves.toBe(1);
    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).resolves.toEqual({ action: 'already_terminal', attemptId: fixture.attempt.id });
    expect(adapter.submitCount).toBe(0);
    const attempts = await databaseResource.db.query.taskAttempts.findMany({
      where: eq(taskAttempts.taskId, fixture.task.id),
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
      rawErrorSummary: { error_code: 'provider_timeout' },
    });
    const circuits = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        'provider:fake',
        `model:${fixture.model.id}`,
      ]),
    });
    for (const circuit of circuits) track('circuits', circuit.id);
    expect(circuits).toHaveLength(2);
    expect(circuits.every((circuit) => circuit.status === 'open')).toBe(true);
  });

  it('does not recover a slow image dispatch using the shorter generic timeout', async () => {
    const fixture = await createProviderFixture();
    const repository = new TaskAttemptRepository(databaseResource.db);
    await repository.advance({
      attemptId: fixture.attempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'dispatching',
      dispatchState: 'not_dispatched',
      now: new Date(Date.now() - 120_000),
    });
    const service = new ProviderAttemptService(
      databaseResource.db,
      gateway(fakeAdapterFor(fixture.model)),
    );

    await expect(
      service.recoverStaleDispatching({
        before: new Date(Date.now() - 60_000),
        imageBefore: new Date(Date.now() - 630_000),
        limit: 10,
      }),
    ).resolves.toBe(0);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({ status: 'dispatching', dispatchState: 'not_dispatched' });
  });

  it('keeps the generic cutoff for non-image dispatches', async () => {
    const fixture = await createProviderFixture({ taskType: 'moderation.text' });
    const repository = new TaskAttemptRepository(databaseResource.db);
    await repository.advance({
      attemptId: fixture.attempt.id,
      expectedStatus: 'created',
      expectedDispatchState: 'not_dispatched',
      status: 'dispatching',
      dispatchState: 'not_dispatched',
      now: new Date(Date.now() - 120_000),
    });
    const service = new ProviderAttemptService(
      databaseResource.db,
      gateway(fakeAdapterFor(fixture.model)),
    );

    await expect(
      service.recoverStaleDispatching({
        before: new Date(Date.now() - 60_000),
        imageBefore: new Date(Date.now() - 630_000),
        limit: 10,
      }),
    ).resolves.toBe(1);
  });

  it('provider-timeout preserves one unknown attempt without retrying the Provider call', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model, 'never');
    const now = new Date();
    const service = new ProviderAttemptService(
      databaseResource.db,
      gateway(adapter, () => now),
    );
    const timeoutContext = context(new Date(now.getTime() + 25));

    const result = await service.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: timeoutContext,
    });

    expect(result).toMatchObject({
      action: 'recorded',
      outcome: { kind: 'outcome_unknown', error_code: 'provider_timeout' },
    });
    expect(adapter.submitCount).toBe(1);
    const attempts = await databaseResource.db.query.taskAttempts.findMany({
      where: eq(taskAttempts.taskId, fixture.task.id),
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
    });
    const retryIntents = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
    });
    expect(retryIntents).toHaveLength(0);
  });

  it('recovers a poll crash with atomic unknown circuit evidence', async () => {
    const fixture = await createProviderFixture({
      quota: { circuit_sample_size: 1, circuit_unknown_rate: '0.20' },
    });
    const lastPolledAt = new Date(Date.now() - 60_000);
    await databaseResource.db
      .update(taskAttempts)
      .set({
        status: 'polling',
        dispatchState: 'accepted',
        providerRequestId: `poll-crash-${randomUUID()}`,
        acceptedAt: new Date(lastPolledAt.getTime() - 1_000),
        lastPolledAt,
        nextPollAt: null,
        pollCount: 1,
      })
      .where(eq(taskAttempts.id, fixture.attempt.id));
    const adapter = fakeAdapterFor(fixture.model);
    const service = new ProviderAttemptService(databaseResource.db, gateway(adapter));

    await expect(
      service.recoverStalePolling({ before: new Date(Date.now() - 30_000), limit: 10 }),
    ).resolves.toBe(1);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
      rawErrorSummary: { error_code: 'provider_timeout' },
    });
    const circuits = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        'provider:fake',
        `model:${fixture.model.id}`,
      ]),
    });
    for (const circuit of circuits) track('circuits', circuit.id);
    expect(circuits).toHaveLength(2);
    expect(circuits.every((circuit) => circuit.status === 'open')).toBe(true);
    expect(adapter.submitCount).toBe(0);
  });

  it('creates at most two new attempts after verified not-dispatched outcomes', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model, 'not_dispatched');
    const service = new ProviderAttemptService(databaseResource.db, gateway(adapter));

    for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
      const attempt = await databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.taskId, fixture.task.id),
        orderBy: (row, { desc }) => [desc(row.attemptNo)],
      });
      expect(attempt?.attemptNo).toBe(attemptNo);
      await service.submit({
        attemptId: attempt!.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      });
    }

    const attempts = await databaseResource.db.query.taskAttempts.findMany({
      where: eq(taskAttempts.taskId, fixture.task.id),
    });
    for (const attempt of attempts) track('attempts', attempt.id);
    const intents = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: inArray(
        queueDispatchIntents.aggregateId,
        attempts.map((attempt) => attempt.id),
      ),
    });
    for (const intent of intents) track('intents', intent.id);
    expect(adapter.submitCount).toBe(3);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.status === 'failed')).toBe(true);
    expect(intents).toHaveLength(2);
  });

  it('creates one stable poll intent and reaches a terminal result by polling', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model, 'accepted');
    const service = new ProviderAttemptService(databaseResource.db, gateway(adapter));
    const submitContext = context();

    await service.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: submitContext,
    });
    const [intent] = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
    });
    if (!intent) throw new Error('Poll intent was not created');
    track('intents', intent.id);
    expect(intent.payload).toMatchObject({ job_type: 'provider.poll', poll_no: 1 });

    await expect(
      service.poll(
        {
          ...(intent.payload as Parameters<ProviderAttemptService['poll']>[0]),
          poll_no: 2,
        },
        context(),
      ),
    ).rejects.toThrow(/ahead/);
    await service.poll(intent.payload as Parameters<ProviderAttemptService['poll']>[0], context());
    await expect(
      service.poll(intent.payload as Parameters<ProviderAttemptService['poll']>[0], context()),
    ).resolves.toEqual({ action: 'no_op' });
    expect(adapter.submitCount).toBe(1);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({ status: 'succeeded', pollCount: 1 });
  });

  it('records a terminal poll failure in the persisted circuit window atomically', async () => {
    const fixture = await createProviderFixture({
      quota: { circuit_sample_size: 1, circuit_failure_rate: '0.50' },
    });
    const adapter = fakeAdapterFor(fixture.model, 'accepted');
    const circuits = new ProviderCircuitRepository(databaseResource.db);
    const service = new ProviderAttemptService(
      databaseResource.db,
      new ProviderGateway(new ProviderRegistry([adapter]), {
        mode: 'test',
        circuitGate: circuits,
        quotaGate: { reserve: () => Promise.resolve() },
      }),
      () => new Date(),
      undefined,
      circuits,
    );
    await service.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });
    const [intent] = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
    });
    const pollPayload = intent ? parseQueuePayload(intent.payload) : undefined;
    if (!intent || pollPayload?.job_type !== 'provider.poll') {
      throw new Error('Provider poll intent was not created');
    }
    track('intents', intent.id);

    const failingPoll = new ProviderAttemptService(
      databaseResource.db,
      gateway(fakeAdapterFor(fixture.model, 'failed')),
      () => new Date(),
      undefined,
      circuits,
    );
    await failingPoll.poll(pollPayload, context());

    const rows = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        'provider:fake',
        `model:${fixture.model.id}`,
      ]),
    });
    for (const row of rows) track('circuits', row.id);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.status === 'open' && row.sampleCount === 1 && row.failureCount === 1),
    ).toBe(true);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({ status: 'failed', dispatchState: 'accepted' });
  });

  it('accepts a terminal failure without a request ID only when receipt evidence exists', async () => {
    const fixture = await createProviderFixture();
    const adapter: ProviderAdapter = {
      provider: fixture.model.provider,
      modelId: fixture.model.modelId,
      version: fixture.model.version,
      capabilities: ['image.generate'],
      submit: () =>
        Promise.resolve({
          kind: 'failed',
          error_code: 'provider_content_rejected',
          receipt_summary: { status_code_family: '4xx' },
          failed_at: new Date(),
        }),
    };
    const service = new ProviderAttemptService(databaseResource.db, gateway(adapter));

    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).resolves.toMatchObject({ action: 'recorded', outcome: { kind: 'failed' } });
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      dispatchState: 'accepted',
      providerRequestId: null,
      providerReceipt: { status_code_family: '4xx' },
    });
  });

  it('restores the same poll sequence when quota control is temporarily unavailable', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model, 'accepted');
    const acceptedService = new ProviderAttemptService(databaseResource.db, gateway(adapter));
    await acceptedService.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });
    const [intent] = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
    });
    const payload = intent ? parseQueuePayload(intent.payload) : undefined;
    if (!intent || payload?.job_type !== 'provider.poll') {
      throw new Error('Provider poll intent was not created');
    }
    track('intents', intent.id);
    const unavailableService = new ProviderAttemptService(
      databaseResource.db,
      new ProviderGateway(new ProviderRegistry([adapter]), {
        mode: 'test',
        circuitGate: { assertCanSubmit: () => Promise.resolve() },
        quotaGate: {
          reserve: () =>
            Promise.reject(new ProviderQuotaUnavailableError('PROVIDER_QUOTA_UNAVAILABLE')),
        },
      }),
    );

    const result = await unavailableService.poll(payload, context());
    expect(result).toMatchObject({ action: 'retry_scheduled' });
    const retryAt = result.action === 'retry_scheduled' ? result.retryAt : undefined;
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({
      status: 'accepted',
      dispatchState: 'accepted',
      pollCount: 0,
      nextPollAt: retryAt,
    });
    expect(adapter.submitCount).toBe(1);

    await expect(acceptedService.poll(payload, context())).resolves.toMatchObject({
      action: 'recorded',
      outcome: { kind: 'succeeded' },
    });
    const attempts = await databaseResource.db.query.taskAttempts.findMany({
      where: eq(taskAttempts.taskId, fixture.task.id),
    });
    for (const attempt of attempts) track('attempts', attempt.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'succeeded', pollCount: 1 });
    expect(adapter.submitCount).toBe(1);
  });

  it('delays and retries the same BullMQ poll job after a transient quota outage', async () => {
    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model, 'accepted');
    const acceptedService = new ProviderAttemptService(databaseResource.db, gateway(adapter));
    await acceptedService.submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });
    const [intent] = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
    });
    const payload = intent ? parseQueuePayload(intent.payload) : undefined;
    if (!intent || payload?.job_type !== 'provider.poll') {
      throw new Error('Provider poll intent was not created');
    }
    track('intents', intent.id);

    let reservations = 0;
    const quotaGate = {
      reserve: vi.fn(() => {
        reservations += 1;
        return reservations === 1
          ? Promise.reject(new ProviderQuotaUnavailableError('PROVIDER_QUOTA_UNAVAILABLE'))
          : Promise.resolve();
      }),
    };
    const config = loadWorkerConfig({
      APP_ENV: 'test',
      TEST_DATABASE_URL: testDatabaseUrl,
      TEST_REDIS_URL: testRedisUrl,
      TEST_REDIS_PREFIX: testRedisPrefix,
      LOCAL_UPLOAD_ROOT: './uploads',
      QUEUE_ENABLE_TEST_PROCESSOR: 'false',
      PROVIDER_MODE: 'fake',
      PROVIDER_PROCESSOR_MODE: 'fake_validation',
      PROVIDER_ADAPTER: 'fake',
    });
    const processors = new ProviderProcessorWorkers(
      databaseResource.db,
      redis,
      config,
      new ActiveWorkTracker(),
      new WorkerWriteFence(),
      undefined,
      adapter,
      undefined,
      quotaGate,
    );
    const queue = new Queue('provider-callback', {
      connection: createBullMqConnection(testRedisUrl),
      prefix: testRedisPrefix,
    });
    const jobId = randomUUID();
    try {
      await queue.add('provider.poll', payload, { jobId });
      await waitFor(async () => {
        const job = await queue.getJob(jobId);
        return (await job?.getState()) === 'completed';
      });

      const job = await queue.getJob(jobId);
      expect(job?.failedReason).toBeUndefined();
      expect(job?.attemptsMade).toBe(1);
      expect(quotaGate.reserve).toHaveBeenCalledTimes(2);
      await expect(
        databaseResource.db.query.taskAttempts.findFirst({
          where: eq(taskAttempts.id, fixture.attempt.id),
        }),
      ).resolves.toMatchObject({ status: 'succeeded', pollCount: 1 });
      const attempts = await databaseResource.db.query.taskAttempts.findMany({
        where: eq(taskAttempts.taskId, fixture.task.id),
      });
      for (const attempt of attempts) track('attempts', attempt.id);
      expect(attempts).toHaveLength(1);
      expect(adapter.submitCount).toBe(1);
    } finally {
      await processors.close(true);
      await queue.close();
    }
  });

  it('counts an asynchronous request once at terminal state instead of again at accepted', async () => {
    const fixture = await createProviderFixture();
    const circuits = new ProviderCircuitRepository(databaseResource.db);
    const model = snapshot(fixture.model.id);
    await circuits.recordOutcome(
      model,
      {
        kind: 'accepted',
        provider_request_id: `accepted-${randomUUID()}`,
        receipt_summary: { provider_status: 'accepted' },
        accepted_at: new Date(),
      },
      await circuits.assertCanSubmit(model),
    );
    let rows = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        'provider:fake',
        `model:${fixture.model.id}`,
      ]),
    });
    for (const row of rows) track('circuits', row.id);
    expect(rows.every((row) => row.sampleCount === 0)).toBe(true);

    await databaseResource.db.transaction((transaction) =>
      circuits.recordTerminalEvidenceInTransaction(transaction, model, {
        kind: 'failed',
        errorCode: 'provider_internal_error',
      }),
    );
    rows = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        'provider:fake',
        `model:${fixture.model.id}`,
      ]),
    });
    expect(rows.every((row) => row.sampleCount === 1 && row.failureCount === 1)).toBe(true);
  });

  it('processes concurrent duplicate callbacks exactly once', async () => {
    const fixture = await createProviderFixture();
    const providerRequestId = `fake-${randomUUID()}`;
    await databaseResource.db
      .update(taskAttempts)
      .set({
        status: 'accepted',
        dispatchState: 'accepted',
        providerRequestId,
        acceptedAt: new Date(),
      })
      .where(eq(taskAttempts.id, fixture.attempt.id));
    const event = await createCallbackEvent({ providerRequestId });
    const service = new ProviderCallbackService(databaseResource.db);
    const payload = {
      schema_version: 1 as const,
      job_type: 'provider.callback.process' as const,
      trace_id: randomUUID(),
      provider_callback_event_id: event.id,
      processing_no: 1,
    };

    const results = await Promise.all([service.process(payload), service.process(payload)]);

    expect(results.map((result) => result.action).sort()).toEqual(['no_op', 'processed']);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({ status: 'succeeded', providerReportedCost: '0.10' });
    await expect(
      databaseResource.db.query.providerCallbackEvents.findFirst({
        where: eq(providerCallbackEvents.id, event.id),
      }),
    ).resolves.toMatchObject({
      status: 'processed',
      taskAttemptId: fixture.attempt.id,
      processingCount: 1,
    });
    await expect(
      databaseResource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.task.id) }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    const terminalEvents = await databaseResource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, fixture.workflow.id),
    });
    expect(
      terminalEvents.filter(
        (row) =>
          row.eventType === 'task.status_changed' &&
          (row.payload as { to?: string }).to === 'succeeded',
      ),
    ).toHaveLength(1);
  });

  it('dead-letters a late callback after an unknown attempt expires without changing task or cost evidence', async () => {
    const fixture = await createProviderFixture();
    const providerRequestId = `late-unknown-${randomUUID()}`;
    await databaseResource.db
      .update(taskAttempts)
      .set({
        status: 'outcome_unknown',
        dispatchState: 'outcome_unknown',
        providerRequestId,
        endedAt: new Date(Date.now() - 31 * 60 * 1_000),
        rawErrorSummary: { error_code: 'provider_timeout' },
      })
      .where(eq(taskAttempts.id, fixture.attempt.id));
    await databaseResource.db
      .update(tasks)
      .set({ status: 'failed', errorCode: 'PROVIDER_OUTCOME_UNKNOWN_EXPIRED', costActual: '0.00' })
      .where(eq(tasks.id, fixture.task.id));
    const event = await createCallbackEvent({ providerRequestId });

    await expect(
      new ProviderCallbackService(databaseResource.db).process({
        schema_version: 1,
        job_type: 'provider.callback.process',
        trace_id: randomUUID(),
        provider_callback_event_id: event.id,
        processing_no: 1,
      }),
    ).resolves.toEqual({ action: 'dead_letter' });

    await expect(
      databaseResource.db.query.providerCallbackEvents.findFirst({
        where: eq(providerCallbackEvents.id, event.id),
      }),
    ).resolves.toMatchObject({
      status: 'dead_letter',
      errorCode: 'PROVIDER_CALLBACK_LATE_UNKNOWN',
      taskAttemptId: fixture.attempt.id,
    });
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({
      status: 'outcome_unknown',
      dispatchState: 'outcome_unknown',
      providerReportedCost: null,
    });
    await expect(
      databaseResource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.task.id) }),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN_EXPIRED',
      costActual: '0.00',
    });
    await expect(
      databaseResource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
      }),
    ).resolves.toHaveLength(0);
  });

  it('lets only one terminal writer win when callback and poll arrive concurrently', async () => {
    const fixture = await attachReservation(await createProviderFixture());
    const providerRequestId = `callback-poll-race-${randomUUID()}`;
    await databaseResource.db
      .update(taskAttempts)
      .set({
        status: 'polling',
        dispatchState: 'accepted',
        providerRequestId,
        acceptedAt: new Date(),
        pollCount: 1,
        lastPolledAt: new Date(),
      })
      .where(eq(taskAttempts.id, fixture.attempt.id));
    const event = await createCallbackEvent({ providerRequestId });
    const callbacks = new ProviderCallbackService(databaseResource.db);
    const pollService = new ProviderAttemptService(
      databaseResource.db,
      gateway(fakeAdapterFor(fixture.model, 'failed')),
    );
    const callbackPayload = {
      schema_version: 1 as const,
      job_type: 'provider.callback.process' as const,
      trace_id: randomUUID(),
      provider_callback_event_id: event.id,
      processing_no: 1,
    };
    const pollPayload = {
      schema_version: 1 as const,
      job_type: 'provider.poll' as const,
      trace_id: randomUUID(),
      task_attempt_id: fixture.attempt.id,
      poll_no: 2,
    };

    const race = await Promise.allSettled([
      callbacks.process(callbackPayload),
      pollService.poll(pollPayload, context()),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const attempt = await databaseResource.db.query.taskAttempts.findFirst({
      where: eq(taskAttempts.id, fixture.attempt.id),
    });
    expect(['succeeded', 'failed']).toContain(attempt?.status);
    const storedEvent = await databaseResource.db.query.providerCallbackEvents.findFirst({
      where: eq(providerCallbackEvents.id, event.id),
    });
    expect(['processed', 'dead_letter']).toContain(storedEvent?.status);
    expect(storedEvent?.status === 'processed').toBe(attempt?.status === 'succeeded');
    expect(attempt?.providerReportedCost === '0.10').toBe(attempt?.status === 'succeeded');
    const terminalEvents = await databaseResource.db.query.eventOutbox.findMany({
      where: eq(eventOutbox.scopeId, fixture.workflow.id),
    });
    expect(
      terminalEvents.filter(
        (row) =>
          row.eventType === 'task.status_changed' &&
          ['succeeded', 'failed'].includes((row.payload as { to?: string }).to ?? ''),
      ),
    ).toHaveLength(1);
    const settlementIntents = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, fixture.attempt.id),
    });
    expect(settlementIntents).toHaveLength(1);
    expect(settlementIntents[0]).toMatchObject({
      queueName: 'settlement',
      jobId: fixture.attempt.id,
      payload: {
        job_type: 'settlement.execute',
        task_attempt_id: fixture.attempt.id,
        reservation_id: fixture.reservation.id,
      },
    });
  });

  it('replays an early unmatched callback after accepted persistence without resubmitting', async () => {
    const fixture = await createProviderFixture();
    const providerRequestId = `fake-fixed-${randomUUID()}`;
    const event = await createCallbackEvent({ providerRequestId });
    const callbacks = new ProviderCallbackService(databaseResource.db);
    await expect(
      callbacks.process({
        schema_version: 1,
        job_type: 'provider.callback.process',
        trace_id: randomUUID(),
        provider_callback_event_id: event.id,
        processing_no: 1,
      }),
    ).resolves.toEqual({ action: 'unmatched_retryable' });

    let submitCount = 0;
    const adapter: ProviderAdapter = {
      provider: 'fake',
      modelId: fixture.model.modelId,
      version: fixture.model.version,
      capabilities: ['image.generate'],
      submit: () => {
        submitCount += 1;
        return Promise.resolve({
          kind: 'accepted',
          provider_request_id: providerRequestId,
          receipt_summary: { provider_status: 'accepted' },
          accepted_at: new Date(),
          poll_after_ms: 1_000,
        });
      },
    };
    await new ProviderAttemptService(databaseResource.db, gateway(adapter)).submit({
      attemptId: fixture.attempt.id,
      capability: 'image.generate',
      providerInput: providerInput(),
      context: context(),
    });
    expect(submitCount).toBe(1);
    const allIntents = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: inArray(queueDispatchIntents.aggregateId, [event.id, fixture.attempt.id]),
    });
    for (const intent of allIntents) track('intents', intent.id);
    const callbackIntents = allIntents.filter((intent) => intent.aggregateId === event.id);
    expect(callbackIntents).toHaveLength(1);
    expect(callbackIntents[0]?.payload).toMatchObject({ processing_no: 2 });
    await expect(
      callbacks.process(
        callbackIntents[0]!.payload as Parameters<ProviderCallbackService['process']>[0],
      ),
    ).resolves.toMatchObject({ action: 'processed', outcome: 'succeeded' });
    expect(submitCount).toBe(1);
  });

  it('fails closed on a future callback sequence and permanently dead-letters expired unmatched data', async () => {
    const event = await createCallbackEvent({
      providerRequestId: `missing-${randomUUID()}`,
      receivedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000),
    });
    const service = new ProviderCallbackService(databaseResource.db);
    await expect(
      service.process({
        schema_version: 1,
        job_type: 'provider.callback.process',
        trace_id: randomUUID(),
        provider_callback_event_id: event.id,
        processing_no: 2,
      }),
    ).rejects.toBeInstanceOf(ProviderCallbackSequenceError);
    await expect(
      service.process({
        schema_version: 1,
        job_type: 'provider.callback.process',
        trace_id: randomUUID(),
        provider_callback_event_id: event.id,
        processing_no: 1,
      }),
    ).resolves.toEqual({ action: 'dead_letter' });
    await expect(
      databaseResource.db.query.providerCallbackEvents.findFirst({
        where: eq(providerCallbackEvents.id, event.id),
      }),
    ).resolves.toMatchObject({
      status: 'dead_letter',
      errorCode: 'PROVIDER_CALLBACK_UNMATCHED_EXPIRED',
      nextProcessAt: null,
    });
  });

  it('sweeps unmatched callbacks within 24 hours and expires them after the match window', async () => {
    const receivedAt = new Date('2026-08-11T00:00:00.000Z');
    let now = receivedAt;
    const event = await createCallbackEvent({
      providerRequestId: `missing-${randomUUID()}`,
      receivedAt,
    });
    const service = new ProviderCallbackService(databaseResource.db, () => now);
    await service.process({
      schema_version: 1,
      job_type: 'provider.callback.process',
      trace_id: randomUUID(),
      provider_callback_event_id: event.id,
      processing_no: 1,
    });
    now = new Date(receivedAt.getTime() + 31_000);
    await expect(
      service.scheduleRetryableUnmatched({ limit: 10, traceId: randomUUID() }),
    ).resolves.toEqual({ scheduled: 1, expired: 0 });
    const intents = await databaseResource.db.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, event.id),
    });
    for (const intent of intents) track('intents', intent.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.payload).toMatchObject({ processing_no: 2 });

    now = new Date(receivedAt.getTime() + 24 * 60 * 60 * 1_000 + 1);
    await expect(
      service.scheduleRetryableUnmatched({ limit: 10, traceId: randomUUID() }),
    ).resolves.toEqual({ scheduled: 0, expired: 1 });
    await expect(
      databaseResource.db.query.providerCallbackEvents.findFirst({
        where: eq(providerCallbackEvents.id, event.id),
      }),
    ).resolves.toMatchObject({
      errorCode: 'PROVIDER_CALLBACK_UNMATCHED_EXPIRED',
      nextProcessAt: null,
    });
  });

  it('queue recovery rebuilds only live poll and callback intents without a submit job', async () => {
    const pollFixture = await createProviderFixture();
    const terminalFixture = await createProviderFixture();
    const providerRequestId = `recovery-${randomUUID()}`;
    const futurePollAt = new Date(Date.now() + 60_000);
    await databaseResource.db
      .update(taskAttempts)
      .set({
        status: 'accepted',
        dispatchState: 'accepted',
        providerRequestId,
        acceptedAt: new Date(),
        nextPollAt: futurePollAt,
        pollCount: 0,
      })
      .where(eq(taskAttempts.id, pollFixture.attempt.id));
    await databaseResource.db
      .update(taskAttempts)
      .set({
        status: 'succeeded',
        dispatchState: 'accepted',
        providerRequestId: `terminal-${randomUUID()}`,
        acceptedAt: new Date(),
        endedAt: new Date(),
        pollCount: 1,
      })
      .where(eq(taskAttempts.id, terminalFixture.attempt.id));

    const liveEvent = await createCallbackEvent({ providerRequestId });
    await databaseResource.db
      .update(providerCallbackEvents)
      .set({
        status: 'dead_letter',
        errorCode: 'PROVIDER_CALLBACK_UNMATCHED_RETRYABLE',
        processingCount: 1,
        nextProcessAt: new Date(Date.now() + 60_000),
      })
      .where(eq(providerCallbackEvents.id, liveEvent.id));
    const terminalEvent = await createCallbackEvent({
      providerRequestId: `terminal-event-${randomUUID()}`,
    });
    await databaseResource.db
      .update(providerCallbackEvents)
      .set({
        status: 'dead_letter',
        errorCode: 'PROVIDER_CALLBACK_UNMATCHED_EXPIRED',
        processingCount: 1,
        nextProcessAt: null,
      })
      .where(eq(providerCallbackEvents.id, terminalEvent.id));

    const intents = new QueueIntentRepository(databaseResource.db);
    async function dispatched(input: Parameters<QueueIntentRepository['create']>[0]) {
      const claimAt = new Date('1970-01-01T00:00:00.000Z');
      const intent = await intents.create({ ...input, nextAttemptAt: claimAt });
      track('intents', intent.id);
      const owner = randomUUID();
      const now = new Date();
      const claimed = await intents.claimPending({
        owner,
        now,
        leaseMs: 10_000,
        limit: 1,
      });
      expect(claimed.map((row) => row.id)).toContain(intent.id);
      await expect(
        intents.markDispatched({ id: intent.id, owner, now: new Date(now.getTime() + 1) }),
      ).resolves.toBe(true);
      return intent;
    }
    await dispatched({
      queueName: 'provider-callback',
      jobId: `poll-${pollFixture.attempt.id}`,
      aggregateType: 'task_attempt',
      aggregateId: pollFixture.attempt.id,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'provider.poll',
        trace_id: randomUUID(),
        task_attempt_id: pollFixture.attempt.id,
        poll_no: 1,
      },
    });
    await dispatched({
      queueName: 'provider-callback',
      jobId: `poll-${terminalFixture.attempt.id}`,
      aggregateType: 'task_attempt',
      aggregateId: terminalFixture.attempt.id,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'provider.poll',
        trace_id: randomUUID(),
        task_attempt_id: terminalFixture.attempt.id,
        poll_no: 1,
      },
    });
    await dispatched({
      queueName: 'provider-callback',
      jobId: `callback-${liveEvent.id}`,
      aggregateType: 'provider_callback_event',
      aggregateId: liveEvent.id,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'provider.callback.process',
        trace_id: randomUUID(),
        provider_callback_event_id: liveEvent.id,
        processing_no: 2,
      },
    });
    await dispatched({
      queueName: 'provider-callback',
      jobId: `callback-${terminalEvent.id}`,
      aggregateType: 'provider_callback_event',
      aggregateId: terminalEvent.id,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'provider.callback.process',
        trace_id: randomUUID(),
        provider_callback_event_id: terminalEvent.id,
        processing_no: 2,
      },
    });

    const publisher = new BullMqQueuePublisher(integrationWorkerConfig);
    const reconciler = new QueueReconciler(
      databaseResource.db,
      databaseResource.client,
      redis,
      intents,
      publisher,
      integrationWorkerConfig,
    );
    const providerQueue = new Queue('provider-callback', {
      connection: createBullMqConnection(testRedisUrl),
      prefix: testRedisPrefix,
    });
    const taskQueue = new Queue('task', {
      connection: createBullMqConnection(testRedisUrl),
      prefix: testRedisPrefix,
    });
    try {
      const summary = await reconciler.reconcile();
      expect(summary.rebuilt).toBeGreaterThanOrEqual(2);
      expect(summary.skippedTerminal).toBeGreaterThanOrEqual(2);
      const jobs = await providerQueue.getJobs(['waiting', 'delayed']);
      const expectedIds = [`callback-${liveEvent.id}`, `poll-${pollFixture.attempt.id}`].sort();
      const expectedJobs = jobs.filter((job) => expectedIds.includes(job.id ?? ''));
      expect(expectedJobs.map((job) => job.id).sort()).toEqual(expectedIds);
      expect(expectedJobs.every((job) => job.delay > 0)).toBe(true);
      const taskJobs = await taskQueue.getJobs(['waiting', 'delayed']);
      expect(taskJobs.some((job) => job.id === `submit-${pollFixture.attempt.id}`)).toBe(false);
    } finally {
      await publisher.close();
      await providerQueue.close();
      await taskQueue.close();
    }
  });

  it('opens the persisted circuit at snapshot thresholds and allows only one half-open probe', async () => {
    const fixture = await createProviderFixture();
    const model = snapshot(fixture.model.id);
    let now = new Date('2026-08-11T00:00:00.000Z');
    const circuits = new ProviderCircuitRepository(databaseResource.db, () => now);
    const permit = await circuits.assertCanSubmit(model);
    for (let index = 0; index < 10; index += 1) {
      await circuits.recordOutcome(
        model,
        {
          kind: 'not_dispatched',
          error_code: 'provider_unavailable',
          retryable: true,
          request_digest: 'c'.repeat(64),
        },
        permit,
      );
    }
    const rows = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        `provider:${model.provider}`,
        `model:${model.id}`,
      ]),
    });
    for (const row of rows) track('circuits', row.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'open')).toBe(true);
    await expect(circuits.assertCanSubmit(model)).rejects.toBeInstanceOf(ProviderCircuitOpenError);

    now = new Date(now.getTime() + model.quota.circuit_open_ms + 1);
    const probes = await Promise.allSettled([
      circuits.assertCanSubmit(model),
      circuits.assertCanSubmit(model),
    ]);
    expect(probes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(probes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const probe = probes.find((result) => result.status === 'fulfilled');
    if (!probe || probe.status !== 'fulfilled') throw new Error('Half-open probe was not claimed');
    await circuits.recordOutcome(
      model,
      {
        kind: 'accepted',
        provider_request_id: `probe-${randomUUID()}`,
        receipt_summary: { provider_status: 'accepted' },
        accepted_at: now,
      },
      probe.value,
    );
    const closed = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(
        providerCircuitStates.id,
        rows.map((row) => row.id),
      ),
    });
    expect(closed.every((row) => row.status === 'closed' && row.sampleCount === 0)).toBe(true);
  });

  it('recovers an abandoned half-open probe without admitting the recovery request', async () => {
    const fixture = await createProviderFixture();
    const model = snapshot(fixture.model.id);
    let now = new Date('2026-08-11T00:30:00.000Z');
    const circuits = new ProviderCircuitRepository(databaseResource.db, () => now);
    const initialPermit = await circuits.assertCanSubmit(model);
    for (let index = 0; index < model.quota.circuit_sample_size; index += 1) {
      await circuits.recordOutcome(
        model,
        {
          kind: 'not_dispatched',
          error_code: 'provider_unavailable',
          retryable: true,
          request_digest: 'd'.repeat(64),
        },
        initialPermit,
      );
    }
    const opened = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        `provider:${model.provider}`,
        `model:${model.id}`,
      ]),
    });
    for (const row of opened) track('circuits', row.id);

    now = new Date(now.getTime() + model.quota.circuit_open_ms + 1);
    const abandonedPermit = await circuits.assertCanSubmit(model);
    expect(abandonedPermit.probeToken).toEqual(expect.any(String));
    const claimed = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(
        providerCircuitStates.id,
        opened.map((row) => row.id),
      ),
    });
    expect(
      claimed.every(
        (row) => row.probeAfter?.getTime() === now.getTime() + model.quota.circuit_open_ms,
      ),
    ).toBe(true);
    await expect(circuits.assertCanSubmit(model)).rejects.toBeInstanceOf(ProviderCircuitOpenError);

    now = new Date(now.getTime() + model.quota.circuit_open_ms + 1);
    await expect(circuits.assertCanSubmit(model)).rejects.toMatchObject({
      reasonCode: 'half_open_probe_timeout',
    });
    const recovered = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(
        providerCircuitStates.id,
        opened.map((row) => row.id),
      ),
    });
    expect(
      recovered.every(
        (row) =>
          row.status === 'open' &&
          row.probeOwner === null &&
          row.reasonCode === 'half_open_probe_timeout' &&
          row.probeAfter?.getTime() === now.getTime() + model.quota.circuit_open_ms,
      ),
    ).toBe(true);

    now = new Date(now.getTime() + model.quota.circuit_open_ms + 1);
    const replacementDecisions = await Promise.allSettled([
      circuits.assertCanSubmit(model),
      circuits.assertCanSubmit(model),
    ]);
    expect(replacementDecisions.filter((decision) => decision.status === 'fulfilled')).toHaveLength(
      1,
    );
    const replacement = replacementDecisions.find((decision) => decision.status === 'fulfilled');
    if (!replacement || replacement.status !== 'fulfilled') {
      throw new Error('Replacement half-open probe was not claimed');
    }
    expect(replacement.value.probeToken).not.toBe(abandonedPermit.probeToken);

    await circuits.recordOutcome(
      model,
      {
        kind: 'accepted',
        provider_request_id: `late-probe-${randomUUID()}`,
        receipt_summary: { provider_status: 'accepted' },
        accepted_at: now,
      },
      abandonedPermit,
    );
    const stillOwned = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(
        providerCircuitStates.id,
        opened.map((row) => row.id),
      ),
    });
    expect(
      stillOwned.every(
        (row) => row.status === 'half_open' && row.probeOwner === replacement.value.probeToken,
      ),
    ).toBe(true);
  });

  it('releases a half-open probe when the attempt is no longer dispatchable', async () => {
    const fixture = await createProviderFixture();
    const model = snapshot(fixture.model.id);
    let now = new Date('2026-08-11T02:00:00.000Z');
    const circuits = new ProviderCircuitRepository(databaseResource.db, () => now);
    const initialPermit = await circuits.assertCanSubmit(model);
    for (let index = 0; index < model.quota.circuit_sample_size; index += 1) {
      await circuits.recordOutcome(
        model,
        {
          kind: 'not_dispatched',
          error_code: 'provider_unavailable',
          retryable: true,
          request_digest: 'r'.repeat(64),
        },
        initialPermit,
      );
    }
    const opened = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        `provider:${model.provider}`,
        `model:${model.id}`,
      ]),
    });
    for (const row of opened) track('circuits', row.id);

    now = new Date(now.getTime() + model.quota.circuit_open_ms + 1);
    const probe = await circuits.assertCanSubmit(model);
    expect(probe.probeToken).toEqual(expect.any(String));
    await circuits.releaseProbe(model, probe);

    const released = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(
        providerCircuitStates.id,
        opened.map((row) => row.id),
      ),
    });
    expect(
      released.every(
        (row) =>
          row.status === 'open' &&
          row.probeOwner === null &&
          row.probeAfter?.getTime() === now.getTime(),
      ),
    ).toBe(true);

    const replacement = await circuits.assertCanSubmit(model);
    expect(replacement.probeToken).toEqual(expect.any(String));
    expect(replacement.probeToken).not.toBe(probe.probeToken);
  });

  it('settles a half-open moderation probe from the real Gateway path', async () => {
    const fixture = await createProviderFixture();
    const model = snapshot(fixture.model.id);
    model.capability_contract.capabilities = ['moderation.text'];
    await databaseResource.db
      .update(models)
      .set({ capabilityContractJson: model.capability_contract })
      .where(eq(models.id, fixture.model.id));
    let now = new Date('2026-08-11T01:00:00.000Z');
    const circuits = new ProviderCircuitRepository(databaseResource.db, () => now);
    const initialPermit = await circuits.assertCanSubmit(model);
    for (let index = 0; index < model.quota.circuit_sample_size; index += 1) {
      await circuits.recordModerationOutcome(
        model,
        {
          decision: 'unknown',
          policy_version: 'integration-v1',
          error_code: 'provider_unavailable',
        },
        initialPermit,
      );
    }
    now = new Date(now.getTime() + model.quota.circuit_open_ms + 1);
    const providerGateway = new ProviderGateway(
      new ProviderRegistry([fakeAdapterFor(fixture.model)]),
      {
        mode: 'test',
        circuitGate: circuits,
        quotaGate: { reserve: () => Promise.resolve() },
        now: () => now,
      },
    );

    await expect(
      providerGateway.moderateText(
        model,
        { text: 'half-open moderation probe' },
        context(new Date(now.getTime() + 10_000)),
      ),
    ).resolves.toMatchObject({ decision: 'pass' });
    const rows = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        `provider:${model.provider}`,
        `model:${model.id}`,
      ]),
    });
    for (const row of rows) track('circuits', row.id);
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.status === 'closed' &&
          row.probeOwner === null &&
          row.sampleCount === 0 &&
          row.unknownCount === 0,
      ),
    ).toBe(true);
  });

  it('persists an hourly-budget circuit before failing the submit closed', async () => {
    const fixture = await createProviderFixture();
    const restricted = snapshot(fixture.model.id);
    restricted.quota.hourly_budget_cny = '0.10';
    await databaseResource.db
      .update(models)
      .set({ quotaJson: restricted.quota })
      .where(eq(models.id, fixture.model.id));
    const adapter = fakeAdapterFor(fixture.model);
    const service = new ProviderAttemptService(
      databaseResource.db,
      new ProviderGateway(new ProviderRegistry([adapter]), {
        mode: 'test',
        circuitGate: new ProviderCircuitRepository(databaseResource.db),
        quotaGate: { reserve: () => Promise.resolve() },
      }),
    );

    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).rejects.toMatchObject({ reasonCode: 'hourly_budget' });
    expect(adapter.submitCount).toBe(0);
    const circuits = await databaseResource.db.query.providerCircuitStates.findMany({
      where: inArray(providerCircuitStates.scopeKey, [
        'provider:fake',
        `model:${fixture.model.id}`,
      ]),
    });
    for (const circuit of circuits) track('circuits', circuit.id);
    expect(circuits.find((circuit) => circuit.scopeType === 'model')?.status).toBe('open');
    expect(circuits.find((circuit) => circuit.scopeType === 'provider')?.status).toBe('closed');
    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).resolves.toMatchObject({ action: 'already_terminal' });
    expect(adapter.submitCount).toBe(0);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({ status: 'failed', dispatchState: 'not_dispatched' });
    await expect(
      databaseResource.db.query.tasks.findFirst({ where: eq(tasks.id, fixture.task.id) }),
    ).resolves.toMatchObject({ status: 'blocked', errorCode: 'provider_unavailable' });
  });

  it('serializes concurrent hourly-budget checks before either Provider call escapes', async () => {
    const first = await createProviderFixture();
    const second = await createProviderFixture();
    const restricted = snapshot(first.model.id);
    restricted.quota.hourly_budget_cny = '0.20';
    await databaseResource.db
      .update(models)
      .set({ quotaJson: restricted.quota })
      .where(eq(models.id, first.model.id));
    await databaseResource.db
      .update(tasks)
      .set({ modelId: first.model.id, modelVersion: first.model.version })
      .where(eq(tasks.id, second.task.id));

    let waiting = 0;
    let openBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    const quotaGate = {
      reserve: async () => {
        waiting += 1;
        if (waiting === 2) openBarrier?.();
        await barrier;
      },
    };
    const adapter = fakeAdapterFor(first.model);
    const circuits = new ProviderCircuitRepository(databaseResource.db);
    const sharedGateway = new ProviderGateway(new ProviderRegistry([adapter]), {
      mode: 'test',
      circuitGate: circuits,
      quotaGate,
    });
    const firstService = new ProviderAttemptService(databaseResource.db, sharedGateway);
    const secondService = new ProviderAttemptService(databaseResource.db, sharedGateway);

    const results = await Promise.allSettled([
      firstService.submit({
        attemptId: first.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
      secondService.submit({
        attemptId: second.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(
      results.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof ProviderCircuitOpenError &&
          result.reason.reasonCode === 'hourly_budget',
      ),
    ).toBe(true);
    expect(adapter.submitCount).toBe(0);
    const attempts = await databaseResource.db.query.taskAttempts.findMany({
      where: inArray(taskAttempts.id, [first.attempt.id, second.attempt.id]),
    });
    expect(attempts).toHaveLength(2);
    expect(
      attempts.every(
        (attempt) => attempt.status === 'failed' && attempt.dispatchState === 'not_dispatched',
      ),
    ).toBe(true);
    const ownedTasks = await databaseResource.db.query.tasks.findMany({
      where: inArray(tasks.id, [first.task.id, second.task.id]),
    });
    expect(ownedTasks.every((task) => task.status === 'blocked')).toBe(true);
  });

  it('fails closed when Redis quota state cannot be verified', async () => {
    const gate = new RedisProviderQuotaGate(
      { eval: () => Promise.reject(new Error('redis unavailable')) } as never,
      's05-test-provider',
    );
    await expect(gate.reserve(snapshot(randomUUID()), context())).rejects.toBeInstanceOf(
      ProviderQuotaUnavailableError,
    );

    const fixture = await createProviderFixture();
    const adapter = fakeAdapterFor(fixture.model);
    const service = new ProviderAttemptService(
      databaseResource.db,
      new ProviderGateway(new ProviderRegistry([adapter]), {
        mode: 'test',
        circuitGate: { assertCanSubmit: () => Promise.resolve() },
        quotaGate: gate,
      }),
    );
    await expect(
      service.submit({
        attemptId: fixture.attempt.id,
        capability: 'image.generate',
        providerInput: providerInput(),
        context: context(),
      }),
    ).rejects.toBeInstanceOf(ProviderQuotaUnavailableError);
    await expect(
      databaseResource.db.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, fixture.attempt.id),
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      dispatchState: 'not_dispatched',
      rawErrorSummary: { error_code: 'provider_unavailable' },
    });
    expect(adapter.submitCount).toBe(0);
  });

  it('does not let an expired owner release a replacement concurrency lease', async () => {
    const model = snapshot(randomUUID());
    model.quota.concurrency = 1;
    const gate = new RedisProviderQuotaGate(redis, testRedisPrefix);
    const expiredOwner = await gate.reserve(model, context());
    if (!expiredOwner.concurrencyKey) throw new Error('Concurrency lease key was not returned');

    await redis.del(expiredOwner.concurrencyKey);
    const replacementOwner = await gate.reserve(model, context());
    await gate.release(model, expiredOwner);

    await expect(gate.reserve(model, context())).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA_EXCEEDED',
    });
    await gate.release(model, replacementOwner);
    const nextOwner = await gate.reserve(model, context());
    await gate.release(model, nextOwner);
  });

  it('keeps the concurrency lease beyond the actual call deadline', async () => {
    const model = snapshot(randomUUID());
    model.quota.terminal_timeout_ms = 1_000;
    const gate = new RedisProviderQuotaGate(redis, testRedisPrefix);
    const deadlineAt = new Date(Date.now() + 5 * 60_000);
    const permit = await gate.reserve(model, context(deadlineAt));
    if (!permit.concurrencyKey || !permit.concurrencyToken) {
      throw new Error('Concurrency lease ownership was not returned');
    }

    const leaseScore = await redis.zscore(permit.concurrencyKey, permit.concurrencyToken);
    expect(Number(leaseScore)).toBe(deadlineAt.getTime() + 60_000);
    await gate.release(model, permit);
  });

  it('does not let a shorter call reduce the lifetime of an existing long lease', async () => {
    const model = snapshot(randomUUID());
    model.quota.concurrency = 2;
    const now = Date.now();
    const gate = new RedisProviderQuotaGate(redis, testRedisPrefix, () => new Date(now));
    const longPermit = await gate.reserve(model, context(new Date(now + 5 * 60_000)));
    const shortPermit = await gate.reserve(model, context(new Date(now + 5_000)));
    if (!longPermit.concurrencyKey) throw new Error('Concurrency lease key was not returned');

    expect(await redis.pttl(longPermit.concurrencyKey)).toBeGreaterThan(5 * 60_000);
    await gate.release(model, longPermit);
    await gate.release(model, shortPermit);
  });

  it('keeps the per-minute request limit consumed after concurrency is released', async () => {
    const model = snapshot(randomUUID());
    model.quota.rpm = 1;
    const gate = new RedisProviderQuotaGate(redis, testRedisPrefix);
    const permit = await gate.reserve(model, context());
    await gate.release(model, permit);

    await expect(gate.reserve(model, context())).rejects.toMatchObject({
      code: 'PROVIDER_QUOTA_EXCEEDED',
    });
  });

  it('consumes an explicitly enabled fake validation task through BullMQ', async () => {
    const fixture = await createProviderFixture();
    await databaseResource.db
      .update(tasks)
      .set({
        type: 's07.fake.provider_validation',
        status: 'queued',
        startedAt: null,
        paramsSnapshot: {
          capability: 'image.generate',
          provider_input: providerInput(),
          request_digest: 'd'.repeat(64),
        },
      })
      .where(eq(tasks.id, fixture.task.id));
    const config = loadWorkerConfig({
      APP_ENV: 'test',
      TEST_DATABASE_URL: testDatabaseUrl,
      TEST_REDIS_URL: testRedisUrl,
      TEST_REDIS_PREFIX: testRedisPrefix,
      LOCAL_UPLOAD_ROOT: './uploads',
      QUEUE_ENABLE_TEST_PROCESSOR: 'false',
      PROVIDER_MODE: 'fake',
      PROVIDER_PROCESSOR_MODE: 'fake_validation',
      PROVIDER_ADAPTER: 'fake',
    });
    const processors = new ProviderProcessorWorkers(
      databaseResource.db,
      redis,
      config,
      new ActiveWorkTracker(),
      new WorkerWriteFence(),
      undefined,
      fakeAdapterFor(fixture.model),
    );
    const queue = new Queue('task', {
      connection: createBullMqConnection(testRedisUrl),
      prefix: testRedisPrefix,
    });
    try {
      await queue.add(
        'task.execute',
        {
          schema_version: 1,
          job_type: 'task.execute',
          trace_id: randomUUID(),
          task_id: fixture.task.id,
          workflow_run_id: fixture.workflow.id,
          user_id: fixture.user.id,
        },
        { jobId: randomUUID() },
      );
      await waitFor(async () => {
        const attempt = await databaseResource.db.query.taskAttempts.findFirst({
          where: eq(taskAttempts.id, fixture.attempt.id),
        });
        return attempt?.status === 'succeeded';
      });
      const task = await databaseResource.db.query.tasks.findFirst({
        where: eq(tasks.id, fixture.task.id),
      });
      expect(task?.status).toBe('succeeded');
      const circuits = await databaseResource.db.query.providerCircuitStates.findMany({
        where: inArray(providerCircuitStates.scopeKey, [
          'provider:fake',
          `model:${fixture.model.id}`,
        ]),
      });
      for (const circuit of circuits) track('circuits', circuit.id);
      expect(circuits).toHaveLength(2);
    } finally {
      await processors.close(true);
      await queue.close();
    }
  });
});
