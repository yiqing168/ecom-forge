import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { eq, models, providerCircuitStates, type Database } from '@ecom-forge/db';

import { AppModule } from '../src/app.module.js';
import {
  ProviderModelConflictError,
  ProviderModelService,
} from '../src/modules/provider-model/provider-model.service.js';
import {
  ProviderCircuitConflictError,
  ProviderCircuitControlService,
} from '../src/modules/provider-model/provider-circuit-control.service.js';
import { DATABASE } from '../src/shared/database/database.module.js';

function manifest(modelId: string) {
  return {
    provider: 'fake' as const,
    model_id: modelId,
    version: '1',
    capability_contract: {
      schema_version: 1 as const,
      capabilities: ['image.generate' as const],
      aspect_ratios: ['1:1'],
      resolutions: ['1024x1024'],
      max_outputs: 4,
      max_reference_images: 0,
    },
    pricing: {
      schema_version: 1 as const,
      currency: 'CNY' as const,
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
      schema_version: 1 as const,
      rpm: 60,
      concurrency: 2,
      hourly_budget_cny: '10.00',
      daily_budget_cny: '100.00',
      poll_initial_delay_ms: 1_000,
      poll_interval_ms: 1_000,
      max_poll_count: 10,
      terminal_timeout_ms: 60_000,
      circuit_sample_size: 10,
      circuit_failure_rate: '0.50',
      circuit_unknown_rate: '0.20',
      circuit_open_ms: 30_000,
    },
  };
}

describe('S07 Provider model control service', () => {
  let app: INestApplication;
  let database: Database;
  let service: ProviderModelService;
  const trackedModels: string[] = [];
  const trackedCircuits: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    database = moduleRef.get<Database>(DATABASE);
    service = new ProviderModelService(database);
    await app.init();
  });

  afterEach(async () => {
    for (const id of trackedCircuits.splice(0)) {
      await database.delete(providerCircuitStates).where(eq(providerCircuitStates.id, id));
    }
    for (const id of trackedModels.splice(0)) {
      await database.delete(models).where(eq(models.id, id));
    }
  });

  afterAll(async () => app.close());

  it('registers an immutable free-test snapshot and reuses an exact replay', async () => {
    const input = manifest(`fake-control-${randomUUID()}`);
    const concurrent = await Promise.all([service.register(input), service.register(input)]);
    const created = concurrent.find((result) => !result.reused);
    if (!created) throw new Error('Concurrent registration did not create a model snapshot');
    trackedModels.push(created.model.id);
    expect(concurrent.filter((result) => !result.reused)).toHaveLength(1);
    expect(new Set(concurrent.map((result) => result.model.id))).toEqual(
      new Set([created.model.id]),
    );
    expect(created).toMatchObject({ reused: false, model: { status: 'free_test_only' } });
    await expect(service.register(input)).resolves.toMatchObject({
      reused: true,
      model: { id: created.model.id },
    });
    await expect(
      service.register({
        ...input,
        pricing: { ...input.pricing, provider_unit_cost_cny: '0.20' },
      }),
    ).rejects.toBeInstanceOf(ProviderModelConflictError);
  });

  it('uses expected-status CAS and permits only frozen model transitions', async () => {
    const created = await service.register(manifest(`fake-approval-${randomUUID()}`));
    trackedModels.push(created.model.id);
    const approved = await service.approve({
      model_id: created.model.id,
      expected_status: 'free_test_only',
      target_status: 'poc_passed',
      evidence_digest: 'e'.repeat(64),
      operator_id: 'bootstrap-cli-test',
      reason: 'Approved by the controlled S07 integration fixture',
    });
    expect(approved).toMatchObject({
      model: {
        status: 'poc_passed',
        statusEvidenceDigest: 'e'.repeat(64),
        statusOperatorId: 'bootstrap-cli-test',
        statusReason: 'Approved by the controlled S07 integration fixture',
      },
    });
    expect(approved.model.statusChangedAt).toBeInstanceOf(Date);
    await expect(
      service.approve({
        model_id: created.model.id,
        expected_status: 'free_test_only',
        target_status: 'poc_failed',
        evidence_digest: 'e'.repeat(64),
        operator_id: 'bootstrap-cli-test',
        reason: 'A stale approval must be rejected by status CAS',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_STATUS_CONFLICT' });
  });

  it('allows exactly one concurrent status decision from the same expected status', async () => {
    const created = await service.register(manifest(`fake-concurrent-approval-${randomUUID()}`));
    trackedModels.push(created.model.id);
    const base = {
      model_id: created.model.id,
      expected_status: 'free_test_only',
      evidence_digest: 'a'.repeat(64),
      operator_id: 'bootstrap-cli-test',
      reason: 'Concurrent decisions must be serialized by expected-status CAS',
    };

    const decisions = await Promise.allSettled([
      service.approve({ ...base, target_status: 'poc_passed' }),
      service.approve({ ...base, target_status: 'poc_failed' }),
    ]);

    expect(decisions.filter((decision) => decision.status === 'fulfilled')).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === 'rejected')).toHaveLength(1);
    await expect(
      database.query.models.findFirst({ where: eq(models.id, created.model.id) }),
    ).resolves.toMatchObject({
      status:
        decisions[0]?.status === 'fulfilled'
          ? decisions[0].value.model.status
          : decisions[1]?.status === 'fulfilled'
            ? decisions[1].value.model.status
            : undefined,
    });
  });

  it('recovers an open circuit with expected revision and rejects a concurrent replay', async () => {
    const [created] = await database
      .insert(providerCircuitStates)
      .values({
        scopeType: 'provider',
        scopeKey: `provider:ops-${randomUUID()}`,
        provider: 'ops-fixture',
        status: 'open',
        revision: 4,
        reasonCode: 'failure_rate',
        sampleCount: 10,
        failureCount: 8,
        openedAt: new Date(),
        probeAfter: new Date(Date.now() + 60_000),
      })
      .returning();
    if (!created) throw new Error('Circuit fixture was not created');
    trackedCircuits.push(created.id);
    const circuits = new ProviderCircuitControlService(database);
    const input = {
      scope_key: created.scopeKey,
      expected_revision: 4,
      operator_id: 'bootstrap-cli-test',
      reason: 'Provider incident was manually verified as resolved',
    };

    const decisions = await Promise.allSettled([circuits.recover(input), circuits.recover(input)]);
    expect(decisions.filter((decision) => decision.status === 'fulfilled')).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === 'rejected')).toHaveLength(1);
    expect(
      decisions.some(
        (decision) =>
          decision.status === 'rejected' && decision.reason instanceof ProviderCircuitConflictError,
      ),
    ).toBe(true);
    await expect(
      database.query.providerCircuitStates.findFirst({
        where: eq(providerCircuitStates.id, created.id),
      }),
    ).resolves.toMatchObject({
      status: 'closed',
      revision: 5,
      reasonCode: null,
      sampleCount: 0,
      failureCount: 0,
      unknownCount: 0,
    });
  });

  it('recovers a stranded half-open circuit through the same controlled CAS', async () => {
    const [created] = await database
      .insert(providerCircuitStates)
      .values({
        scopeType: 'provider',
        scopeKey: `provider:ops-half-open-${randomUUID()}`,
        provider: 'ops-fixture',
        status: 'half_open',
        revision: 7,
        reasonCode: 'failure_rate',
        sampleCount: 10,
        failureCount: 8,
        openedAt: new Date(),
        probeAfter: new Date(Date.now() - 60_000),
        probeOwner: randomUUID(),
      })
      .returning();
    if (!created) throw new Error('Half-open circuit fixture was not created');
    trackedCircuits.push(created.id);

    const result = await new ProviderCircuitControlService(database).recover({
      scope_key: created.scopeKey,
      expected_revision: 7,
      operator_id: 'bootstrap-cli-test',
      reason: 'The stranded probe was reviewed before controlled recovery',
    });

    expect(result.circuit).toMatchObject({
      status: 'closed',
      revision: 8,
      reasonCode: null,
      probeOwner: null,
      sampleCount: 0,
      failureCount: 0,
      unknownCount: 0,
    });
  });

  it('rejects controlled recovery while a half-open probe lease is still active', async () => {
    const [created] = await database
      .insert(providerCircuitStates)
      .values({
        scopeType: 'provider',
        scopeKey: `provider:ops-active-probe-${randomUUID()}`,
        provider: 'ops-fixture',
        status: 'half_open',
        revision: 9,
        reasonCode: 'failure_rate',
        probeAfter: new Date(Date.now() + 60_000),
        probeOwner: randomUUID(),
      })
      .returning();
    if (!created) throw new Error('Active probe fixture was not created');
    trackedCircuits.push(created.id);

    await expect(
      new ProviderCircuitControlService(database).recover({
        scope_key: created.scopeKey,
        expected_revision: 9,
        operator_id: 'bootstrap-cli-test',
        reason: 'An active probe must not be bypassed by controlled recovery',
      }),
    ).rejects.toBeInstanceOf(ProviderCircuitConflictError);
    await expect(
      database.query.providerCircuitStates.findFirst({
        where: eq(providerCircuitStates.id, created.id),
      }),
    ).resolves.toMatchObject({
      status: 'half_open',
      revision: 9,
      probeOwner: created.probeOwner,
    });
  });
});
