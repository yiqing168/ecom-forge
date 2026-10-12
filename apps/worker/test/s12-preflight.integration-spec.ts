import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adminPrincipals,
  agentTurns,
  chatSessions,
  contentSafetyPreflights,
  createDatabaseClient,
  eq,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  providerChannels,
  providerCircuitStates,
  providerCredentialVersions,
  runQuotes,
  users,
  isIsolatedTranscriptDatabasePath,
} from '@ecom-forge/db';
import {
  MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION,
  type ModerationOutcome,
} from '@ecom-forge/provider';
import type { CandidatePlan } from '@ecom-forge/compiler';
import { canonicalSha256 } from '@ecom-forge/shared';

import type { ClaimedAgentTurn } from '../src/agent/agent-turn.types.js';
import {
  ContentSafetyPreflightService,
  type ModerationDispatcher,
} from '../src/agent/content-safety-preflight.service.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
if (process.env.NODE_ENV === 'production') {
  throw new Error('S12 preflight integration tests must not run against a production environment');
}
if (!isIsolatedTranscriptDatabasePath(new URL(databaseUrl).pathname)) {
  throw new Error('S12 preflight integration tests refuse a database without a _test boundary');
}
const resource = createDatabaseClient({ databaseUrl, maxConnections: 10 });

describe('S12 content safety preflight integration', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  it('runs text moderation once and replays the same passed operation', async () => {
    let calls = 0;
    const service = serviceFor(async (input) => {
      calls += 1;
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return passOutcome();
    });
    const run = () => service.execute(fixture.claimed, candidate());

    await expect(run()).resolves.toMatchObject({
      status: 'passed',
    });
    await expect(run()).resolves.toMatchObject({
      status: 'passed',
    });
    expect(calls).toBe(1);
    const rows = await resource.db.query.contentSafetyPreflights.findMany({
      where: eq(contentSafetyPreflights.turnId, fixture.turnId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'passed', dispatchState: 'accepted' });
  });

  it('accepts moderation evidence created by unified model configuration', async () => {
    await resource.db
      .update(modelPocRuns)
      .set({ probeSuiteVersion: MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION })
      .where(eq(modelPocRuns.modelSnapshotId, fixture.modelId));
    const service = serviceFor(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return passOutcome();
    });

    await expect(service.execute(fixture.claimed, candidate())).resolves.toMatchObject({
      status: 'passed',
    });
  });

  it('blocks before any money-side aggregate is created', async () => {
    const service = serviceFor(async (input) => {
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return {
        decision: 'blocked',
        policy_version: 'content-safety@1',
        confidence: '1.00',
        reason_codes: ['illegal_goods'],
      };
    });
    const run = () => service.execute(fixture.claimed, candidate());

    await expect(run()).resolves.toEqual({
      status: 'blocked',
      reasonCodes: ['illegal_goods'],
    });
    const row = await resource.db.query.contentSafetyPreflights.findFirst({
      where: eq(contentSafetyPreflights.turnId, fixture.turnId),
    });
    expect(row).toMatchObject({ status: 'blocked', actualCostCny: '0.01' });
    const aggregates = await resource.db.query.runQuotes.findMany({
      where: eq(runQuotes.userId, fixture.userId),
    });
    expect(aggregates).toEqual([]);
  });

  it('keeps an unknown provider result terminal and does not auto-resubmit', async () => {
    let calls = 0;
    const service = serviceFor(async (input) => {
      calls += 1;
      expect(await input.markPotentiallyDispatched()).toBe(true);
      return {
        decision: 'unknown',
        policy_version: 'content-safety@1',
        error_code: 'provider_timeout',
      };
    });
    const run = () => service.execute(fixture.claimed, candidate());

    await expect(run()).resolves.toEqual({
      status: 'outcome_unknown',
    });
    await expect(run()).resolves.toEqual({
      status: 'outcome_unknown',
    });
    expect(calls).toBe(1);
    const row = await resource.db.query.contentSafetyPreflights.findFirst({
      where: eq(contentSafetyPreflights.turnId, fixture.turnId),
    });
    expect(row).toMatchObject({ status: 'outcome_unknown', dispatchState: 'outcome_unknown' });
  });

  it('lets one concurrent worker claim the operation and allows the loser to resume', async () => {
    let calls = 0;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = serviceFor(async (input) => {
      calls += 1;
      expect(await input.markPotentiallyDispatched()).toBe(true);
      await started;
      return passOutcome();
    });
    const run = () => service.execute(fixture.claimed, candidate());
    const first = run();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = run();
    const pending = await second;
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') throw new Error('Expected a pending safety check');
    expect(pending.retryAt).toBeInstanceOf(Date);
    release();
    await expect(first).resolves.toMatchObject({ status: 'passed' });
    expect(calls).toBe(1);
    await expect(run()).resolves.toMatchObject({
      status: 'passed',
    });
    expect(calls).toBe(1);
  });

  it('retries the same operation only after a proven unsent queued CAS', async () => {
    let calls = 0;
    const service = serviceFor(() => {
      calls += 1;
      return Promise.resolve({ decision: 'not_dispatched' });
    });
    await expect(service.execute(fixture.claimed, candidate())).resolves.toEqual({
      status: 'not_dispatched',
    });
    const first = await resource.db.query.contentSafetyPreflights.findFirst({
      where: eq(contentSafetyPreflights.turnId, fixture.turnId),
    });
    expect(first).toMatchObject({
      status: 'queued',
      dispatchState: 'not_dispatched',
      processingOwner: null,
      processingLeaseExpiresAt: null,
    });
    await expect(service.execute(fixture.claimed, candidate())).resolves.toEqual({
      status: 'not_dispatched',
    });
    const rows = await resource.db.query.contentSafetyPreflights.findMany({
      where: eq(contentSafetyPreflights.turnId, fixture.turnId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operationKey).toBe(first?.operationKey);
    expect(calls).toBe(2);
  });

  it('does not turn a throw after the possibly-sent marker into an unsent retry', async () => {
    let calls = 0;
    const service = serviceFor(async (input) => {
      calls += 1;
      expect(await input.markPotentiallyDispatched()).toBe(true);
      throw new Error('simulated transport loss after send');
    });
    await expect(service.execute(fixture.claimed, candidate())).resolves.toMatchObject({
      status: 'pending',
    });
    expect(
      await resource.db.query.contentSafetyPreflights.findFirst({
        where: eq(contentSafetyPreflights.turnId, fixture.turnId),
      }),
    ).toMatchObject({ status: 'running', dispatchState: 'outcome_unknown' });
    const pending = await service.execute(fixture.claimed, candidate());
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') throw new Error('Expected a pending safety check');
    expect(pending.retryAt).toBeInstanceOf(Date);
    expect(calls).toBe(1);
    await resource.db
      .update(contentSafetyPreflights)
      .set({ processingLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(contentSafetyPreflights.turnId, fixture.turnId));
    await expect(service.execute(fixture.claimed, candidate())).resolves.toEqual({
      status: 'outcome_unknown',
    });
    expect(calls).toBe(1);
    expect(
      await resource.db.query.runQuotes.findMany({ where: eq(runQuotes.userId, fixture.userId) }),
    ).toEqual([]);
  });

  afterAll(async () => {
    await resource.client.end();
  });

  function candidate(): CandidatePlan {
    return {
      schema_version: 1,
      intent: { kind: 'creative_generate', confidence: 1 },
      skill_id: 's12-preflight@1.0.0',
      source: 'chat',
      nodes: [
        {
          candidate_key: 'main',
          capability: 'image.generate',
          capability_version: 1,
          depends_on: [],
          input_bindings: [],
          params: { goal_summary: 'ordinary product image' },
          expected_output: 'image',
        },
      ],
    };
  }

  function serviceFor(dispatch: ModerationDispatcher): ContentSafetyPreflightService {
    return new ContentSafetyPreflightService(resource.db, dispatch, 5_000, 'test');
  }

  afterEach(async () => {
    await resource.db
      .delete(contentSafetyPreflights)
      .where(eq(contentSafetyPreflights.turnId, fixture.turnId));
    await resource.db
      .update(moderationRuntimeStates)
      .set({ activeModelSnapshotId: null })
      .where(eq(moderationRuntimeStates.capability, 'moderation.text'));
    await resource.db.delete(modelPocRuns).where(eq(modelPocRuns.modelSnapshotId, fixture.modelId));
    // `provider_circuit_states` references `models`; it must be drained before the snapshot row.
    await resource.db
      .delete(providerCircuitStates)
      .where(eq(providerCircuitStates.modelId, fixture.modelId));
    await resource.db.delete(models).where(eq(models.id, fixture.modelId));
    await resource.db
      .update(providerChannels)
      .set({ activeCredentialVersionId: null })
      .where(eq(providerChannels.id, fixture.channelId));
    await resource.db
      .delete(providerCredentialVersions)
      .where(eq(providerCredentialVersions.id, fixture.credentialId));
    await resource.db.delete(providerChannels).where(eq(providerChannels.id, fixture.channelId));
    await resource.db.delete(adminPrincipals).where(eq(adminPrincipals.id, fixture.adminId));
    await resource.db.delete(agentTurns).where(eq(agentTurns.id, fixture.turnId));
    await resource.db.delete(chatSessions).where(eq(chatSessions.id, fixture.sessionId));
    await resource.db.delete(users).where(eq(users.id, fixture.userId));
  });
});

async function createFixture() {
  const suffix = randomUUID();
  const [user] = await resource.db
    .insert(users)
    .values({ email: `s12-preflight-${suffix}@example.test`, displayName: 'S12 test user' })
    .returning({ id: users.id });
  if (!user) throw new Error('S12 user fixture failed');
  const [session] = await resource.db
    .insert(chatSessions)
    .values({ userId: user.id, title: 'S12 test session' })
    .returning({ id: chatSessions.id });
  if (!session) throw new Error('S12 session fixture failed');
  const [turn] = await resource.db
    .insert(agentTurns)
    .values({ sessionId: session.id, userId: user.id })
    .returning({ id: agentTurns.id });
  if (!turn) throw new Error('S12 turn fixture failed');
  const [admin] = await resource.db
    .insert(adminPrincipals)
    .values({
      identifierHash: `s12-${suffix}`,
      identifierKeyId: 'test-key',
      identifierHint: 's12-test',
      displayName: 'S12 test admin',
      status: 'active',
    })
    .returning({ id: adminPrincipals.id });
  if (!admin) throw new Error('S12 admin fixture failed');
  const [channel] = await resource.db
    .insert(providerChannels)
    .values({
      provider: 'fake',
      adapterKey: 'fake-provider-v1',
      displayName: 'S12 fake moderation',
      baseUrl: `https://s12-${suffix}.invalid`,
      endpointProfileKey: 'local',
      status: 'active',
    })
    .returning();
  if (!channel) throw new Error('S12 channel fixture failed');
  const [credential] = await resource.db
    .insert(providerCredentialVersions)
    .values({
      providerChannelId: channel.id,
      versionNo: 1,
      secretCiphertext: 'fixture',
      secretNonce: 'fixture',
      secretAuthTag: 'fixture',
      secretKeyId: 'fixture',
      keyHint: 'fixture',
      status: 'active',
      validationEvidenceDigest: canonicalSha256({ credential: suffix }),
    })
    .returning();
  if (!credential) throw new Error('S12 credential fixture failed');
  await resource.db
    .update(providerChannels)
    .set({ activeCredentialVersionId: credential.id })
    .where(eq(providerChannels.id, channel.id));
  const [model] = await resource.db
    .insert(models)
    .values({
      provider: 'fake',
      providerChannelId: channel.id,
      modelId: `s12-moderation-${suffix}`,
      version: '1',
      capabilityContractJson: {
        schema_version: 1,
        capabilities: ['moderation.text'],
        aspect_ratios: [],
        resolutions: [],
        max_outputs: 1,
        max_reference_images: 0,
      },
      pricingJson: {
        schema_version: 1,
        currency: 'CNY',
        provider_unit_cost_cny: '0.01',
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
      quotaJson: {
        schema_version: 1,
        rpm: 60,
        concurrency: 4,
        hourly_budget_cny: '10.00',
        daily_budget_cny: '100.00',
        poll_initial_delay_ms: 10,
        poll_interval_ms: 10,
        max_poll_count: 1,
        terminal_timeout_ms: 1_000,
        circuit_sample_size: 10,
        circuit_failure_rate: '0.50',
        circuit_unknown_rate: '0.50',
        circuit_open_ms: 1_000,
      },
      status: 'poc_passed',
      statusEvidenceDigest: canonicalSha256({ model: suffix }),
    })
    .returning();
  if (!model) throw new Error('S12 model fixture failed');
  await resource.db.insert(modelPocRuns).values({
    modelSnapshotId: model.id,
    providerChannelId: channel.id,
    credentialVersionId: credential.id,
    probeSuiteVersion: 'moderation-poc@1',
    requestedSpecKeysJson: ['moderation.text'],
    requestedSpecKeysDigest: canonicalSha256(['moderation.text']),
    status: 'passed',
    attemptNo: 1,
    evidenceDigest: model.statusEvidenceDigest!,
    requestedByAdminId: admin.id,
  });
  const runtime = await resource.db.query.moderationRuntimeStates.findFirst({
    where: eq(moderationRuntimeStates.capability, 'moderation.text'),
  });
  if (!runtime) throw new Error('S12 runtime fixture failed');
  await resource.db
    .update(moderationRuntimeStates)
    .set({ activeModelSnapshotId: model.id, runtimeRevision: runtime.runtimeRevision + 1 })
    .where(eq(moderationRuntimeStates.capability, 'moderation.text'));

  const claimed = {
    turnId: turn.id,
    sessionId: session.id,
    traceId: randomUUID(),
    userMessageId: randomUUID(),
    userId: user.id,
    continuationNo: 1,
    revision: 1,
    owner: randomUUID(),
    message: 'Create an ordinary product image',
    attachments: [],
    sessionSummaryVersion: 0,
    selection: {} as ClaimedAgentTurn['selection'],
    selectionHash: canonicalSha256({ selection: suffix }),
    requiredGenerationCapabilities: ['image.generate'],
    executionAuthorization: {} as ClaimedAgentTurn['executionAuthorization'],
    executionAuthorizationHash: canonicalSha256({ auth: suffix }),
    modelSelection: {} as NonNullable<ClaimedAgentTurn['modelSelection']>,
    modelSelectionHash: canonicalSha256({ model: suffix }),
    generationPreferences: {} as NonNullable<ClaimedAgentTurn['generationPreferences']>,
    generationPreferencesHash: canonicalSha256({ preferences: suffix }),
    loopState: {} as ClaimedAgentTurn['loopState'],
    observations: [],
    inputTokenTotal: 0,
    outputTokenTotal: 0,
    contextInitialized: true,
    isFirstSessionTurn: true,
    loadedResourceSnapshotIds: [],
    publicTextRejections: 0,
    consecutiveBrainDeliveryFailures: 0,
    lastBrainCallOutcomeUnknown: false,
    lastBrainCallBudgetExceeded: false,
    modelSnapshot: {} as ClaimedAgentTurn['modelSnapshot'],
  } satisfies ClaimedAgentTurn;
  return {
    claimed,
    turnId: turn.id,
    userId: user.id,
    modelId: model.id,
    channelId: channel.id,
    credentialId: credential.id,
    adminId: admin.id,
    sessionId: session.id,
  };
}

function passOutcome(): ModerationOutcome {
  return { decision: 'pass', policy_version: 'content-safety@1', confidence: '1.00' };
}
