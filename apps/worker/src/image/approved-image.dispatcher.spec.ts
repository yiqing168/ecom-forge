import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
  type ProviderImageExecutionOutcome,
} from '@ecom-forge/provider';
import { canonicalSha256 } from '@ecom-forge/shared';
import { SecretEnvelope } from '@ecom-forge/shared/secret-envelope';

import { WorkerWriteFence } from '../lifecycle/processing-fence.js';
import { ProviderCircuitRepository } from '../provider/provider-circuit.repository.js';
import { ProviderQuotaUnavailableError } from '../provider/redis-provider-quota.gate.js';
import {
  ApprovedImageDispatcher,
  admitImageProviderCall,
  settleByDeadline,
} from './approved-image.dispatcher.js';

afterEach(() => vi.restoreAllMocks());

describe('approved image dispatch boundaries', () => {
  it('does not let an unselected 4K tier or ratio block a valid 1K request', async () => {
    const fixture = dispatchFixture('1k', 1_048_576);
    await fixture.dispatcher.dispatch(fixture.input);
    expect(fixture.input.markPotentiallyDispatched).toHaveBeenCalledTimes(1);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    const request = fixture.fetchImpl.mock.calls[0]?.[1];
    if (typeof request?.body !== 'string') throw new Error('Expected image generation JSON');
    expect(JSON.parse(request.body)).toMatchObject({ size: '1024x1024', quality: 'high' });
  });

  it('rejects the selected tier above the host pixel bound before any transport', async () => {
    const fixture = dispatchFixture('4k', 1_048_576);
    expect(await fixture.dispatcher.dispatch(fixture.input)).toMatchObject({
      kind: 'not_dispatched',
      retryable: false,
    });
    expect(fixture.input.markPotentiallyDispatched).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it('admits a 4K tier with same-operation 1K baseline evidence without calling it a 4K probe', async () => {
    const fixture = dispatchFixture('4k', 100_000_000);
    await fixture.dispatcher.dispatch(fixture.input);
    expect(fixture.input.markPotentiallyDispatched).toHaveBeenCalledTimes(1);
    expect(fixture.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fixture.poc.requestedSpecKeysJson).toEqual(['generate-1k']);
  });

  it.each([{ keys: [] }, { keys: ['edit-1k'] }])(
    'rejects missing or wrong-operation PoC coverage: %j',
    async ({ keys }) => {
      const fixture = dispatchFixture('4k', 100_000_000);
      fixture.poc.requestedSpecKeysJson = keys;
      expect(await fixture.dispatcher.dispatch(fixture.input)).toMatchObject({
        kind: 'not_dispatched',
        retryable: false,
      });
      expect(fixture.input.markPotentiallyDispatched).not.toHaveBeenCalled();
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('marks only a proven temporary quota control-plane failure as retryable', async () => {
    const fixture = dispatchFixture('1k', 100_000_000);
    fixture.redis.eval.mockRejectedValue(new Error('temporary Redis connection failure'));
    expect(await fixture.dispatcher.dispatch(fixture.input)).toMatchObject({
      kind: 'not_dispatched',
      retryable: true,
    });
    expect(fixture.input.markPotentiallyDispatched).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
});

function dispatchFixture(tier: '1k' | '4k', maxPixels: number) {
  const modelId = randomUUID();
  const channelId = randomUUID();
  const credentialId = randomUUID();
  const evidence = 'a'.repeat(64);
  const keyring = `test:${Buffer.alloc(32, 1).toString('base64url')}`;
  const secret = new SecretEnvelope(keyring).encrypt('test-only-image-credential');
  const specs = (['1k', '4k'] as const).map((resolution) => ({
    kind: 'image',
    spec_key: `generate-${resolution}`,
    operation: 'image.generate',
    mode: 'standard',
    resolution_tier: resolution,
    aspect_ratios: ['1:1', '3:4'],
    max_outputs: 1,
    max_reference_images: 0,
    transparent_background: false,
    output_formats: ['png'],
  }));
  const capability = {
    schema_version: 2,
    contract_kind: 'media',
    media_kind: 'image',
    capabilities: ['image.generate'],
    specs,
  };
  const pricing = {
    schema_version: 2,
    contract_kind: 'media_rate_card',
    currency: 'CNY',
    rate_cards: specs.map((spec) => ({
      rate_key: `rate-${spec.spec_key}`,
      spec_key: spec.spec_key,
      billing_unit: 'image',
      unit_cost_cny: '0.10',
    })),
    overhead_cny: { tool: '0', storage: '0', traffic: '0', agent_brain: '0' },
    failure_rate: '0',
    unknown_rate: '0',
    refund_rate: '0',
    risk_reserve_rate: '0',
    gross_margin_target: '0.2',
    credit_cny_anchor: '1',
  };
  const quota = {
    schema_version: 1,
    rpm: 60,
    concurrency: 9,
    hourly_budget_cny: '100',
    daily_budget_cny: '1000',
    poll_initial_delay_ms: 1000,
    poll_interval_ms: 1000,
    max_poll_count: 1,
    terminal_timeout_ms: 60_000,
    circuit_sample_size: 20,
    circuit_failure_rate: '0.5',
    circuit_unknown_rate: '0.25',
    circuit_open_ms: 60_000,
  };
  const modelRow = {
    id: modelId,
    providerChannelId: channelId,
    provider: 'openai',
    modelId: 'image-test',
    version: '1',
    status: 'poc_passed',
    statusEvidenceDigest: evidence,
    protocolFamily: 'openai',
    apiVariant: 'openai_images',
    capabilityContractJson: capability,
    pricingJson: pricing,
    quotaJson: quota,
  };
  const poc = { requestedSpecKeysJson: ['generate-1k'] };
  const database = {
    query: {
      models: { findFirst: vi.fn().mockResolvedValue(modelRow) },
      providerCredentialVersions: {
        findFirst: vi.fn().mockResolvedValue({
          providerChannelId: channelId,
          status: 'active',
          validationEvidenceDigest: evidence,
          secretKeyId: secret.keyId,
          secretCiphertext: secret.ciphertext,
          secretNonce: secret.nonce,
          secretAuthTag: secret.authTag,
        }),
      },
      providerChannels: {
        findFirst: vi.fn().mockResolvedValue({
          id: channelId,
          revision: 1,
          status: 'active',
          provider: 'openai',
          adapterKey: VERCEL_AI_AGENT_ADAPTER_KEY,
          endpointProfileKey: VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
          region: null,
          activeCredentialVersionId: credentialId,
          baseUrl: 'https://image.test.invalid',
        }),
      },
      modelPocRuns: { findFirst: vi.fn().mockResolvedValue(poc) },
    },
  };
  vi.spyOn(ProviderCircuitRepository.prototype, 'assertCanSubmit').mockResolvedValue({});
  vi.spyOn(ProviderCircuitRepository.prototype, 'recordImageOutcome').mockResolvedValue(undefined);
  const redis = { eval: vi.fn().mockResolvedValue(1) };
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } }),
    );
  const config = {
    appEnv: 'test',
    redisPrefix: 'test',
    localUploadRoot: '.workbuddy/unused',
    storageMaxImagePixels: maxPixels,
    storageMaxImageBytes: 20 * 1024 * 1024,
    providerRelayOrigins: ['https://image.test.invalid'],
    providerImageOutputOrigins: ['https://image.test.invalid'],
    providerCredentialEncryptionKeys: keyring,
    imageProviderRequestTimeoutMs: 60_000,
  };
  const dispatcher = new ApprovedImageDispatcher(
    database as never,
    redis as never,
    config as never,
    new WorkerWriteFence(),
    fetchImpl,
  );
  const input = {
    taskId: randomUUID(),
    workflowRunId: randomUUID(),
    userId: randomUUID(),
    attemptId: randomUUID(),
    traceId: randomUUID(),
    markPotentiallyDispatched: vi.fn().mockResolvedValue(true),
    paramsSnapshot: {
      schema_version: 1,
      source: 'chat',
      operation: 'image.generate',
      goal_summary: 'A cup',
      aspect_ratio: '1:1',
      resolution_tier: tier,
      output_count: 1,
      output_count_source: 'user_explicit',
      input_bindings: [],
      operation_key: evidence,
      depends_on: [],
      model_snapshot: {
        id: modelId,
        version: '1',
        status_evidence_digest: evidence,
        capability_contract_digest: canonicalSha256(capability),
        pricing_digest: canonicalSha256(pricing),
        quota_digest: canonicalSha256(quota),
      },
      model_selection: {
        schema_version: 1,
        catalog_revision: 1,
        catalog_release_id: randomUUID(),
        catalog_release_digest: evidence,
        image: {
          catalog_entry_id: randomUUID(),
          catalog_entry_revision: 1,
          version_no: 1,
          model_snapshot_id: modelId,
          selected_spec_key: `generate-${tier}`,
          runtime: {
            provider_channel_id: channelId,
            provider_channel_revision: 1,
            adapter_key: VERCEL_AI_AGENT_ADAPTER_KEY,
            endpoint_profile_key: VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
            region: null,
            credential_version_id: credentialId,
          },
          billing_sku: {},
        },
        moderation: {},
      },
      storage_snapshot: {
        schema_version: 1,
        purpose: 'private_assets',
        runtime_revision: 1,
        channel_id: randomUUID(),
        channel_revision: 1,
        adapter_key: 'local-private-v1',
        endpoint_profile_key: 'local',
        region: null,
        credential_version_id: randomUUID(),
        validation_evidence_digest: evidence,
      },
    },
  };
  return { dispatcher, input, fetchImpl, redis, poc };
}

const model = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'openai',
  version: 'gpt-image-test',
  quota: { rpm: 60, concurrency: 9 },
} as Parameters<Parameters<typeof admitImageProviderCall>[0]['circuits']['assertCanSubmit']>[0];

describe('image Provider admission', () => {
  it('keeps a timed-out transport attached until it settles', async () => {
    let settleTransport: ((outcome: ProviderImageExecutionOutcome) => void) | undefined;
    const transport = new Promise<ProviderImageExecutionOutcome>((resolve) => {
      settleTransport = resolve;
    });
    const controller = new AbortController();

    const execution = await settleByDeadline(
      transport,
      controller,
      new Date(Date.now() + 5),
      'a'.repeat(64),
    );

    expect(execution.timedOut).toBe(true);
    expect(execution.outcome).toMatchObject({
      kind: 'outcome_unknown',
      error_code: 'provider_timeout',
    });
    expect(controller.signal.aborted).toBe(true);

    settleTransport?.({
      kind: 'not_dispatched',
      error_code: 'provider_cancelled',
      retryable: false,
      request_digest: 'a'.repeat(64),
    });
    await expect(execution.transport).resolves.toMatchObject({ kind: 'not_dispatched' });
  });

  it('waits for quota before claiming the circuit and gives transport a fresh deadline', async () => {
    let now = 1_000;
    const calls: string[] = [];
    const quotaDeadlines: number[] = [];
    const quotaPermit = { concurrencyKey: 'quota-key', concurrencyToken: 'quota-token' };
    const quota = {
      reserve: vi
        .fn()
        .mockImplementationOnce((_model, context: { deadlineAt: Date }) => {
          quotaDeadlines.push(context.deadlineAt.getTime());
          calls.push('quota-full');
          return Promise.reject(new ProviderQuotaUnavailableError('PROVIDER_QUOTA_EXCEEDED'));
        })
        .mockImplementationOnce((_model, context: { deadlineAt: Date }) => {
          quotaDeadlines.push(context.deadlineAt.getTime());
          calls.push('quota-acquired');
          return Promise.resolve(quotaPermit);
        }),
      release: vi.fn(() => Promise.resolve(undefined)),
    };
    const circuits = {
      assertCanSubmit: vi.fn(() => {
        calls.push('circuit');
        return Promise.resolve({ probeToken: 'probe-token' });
      }),
    };

    const result = await admitImageProviderCall({
      quota,
      circuits,
      model,
      requestTimeoutMs: 10_000,
      signal: new AbortController().signal,
      now: () => now,
      wait: (delayMs) => {
        calls.push(`wait-${delayMs}`);
        now += delayMs;
        return Promise.resolve();
      },
    });

    expect(calls).toEqual(['quota-full', 'wait-250', 'quota-acquired', 'circuit']);
    expect(quotaDeadlines).toEqual([11_000, 11_250]);
    expect(result).toMatchObject({ quotaPermit, circuitPermit: { probeToken: 'probe-token' } });
    expect(result.providerDeadlineAt.getTime()).toBe(11_250);
    expect(quota.release).not.toHaveBeenCalled();
  });

  it('releases an acquired quota slot when the circuit rejects submission', async () => {
    const quotaPermit = { concurrencyKey: 'quota-key', concurrencyToken: 'quota-token' };
    const quota = {
      reserve: vi.fn(() => Promise.resolve(quotaPermit)),
      release: vi.fn(() => Promise.resolve(undefined)),
    };
    const circuitError = new Error('circuit-open');
    const circuits = { assertCanSubmit: vi.fn(() => Promise.reject(circuitError)) };

    await expect(
      admitImageProviderCall({
        quota,
        circuits,
        model,
        requestTimeoutMs: 10_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(circuitError);
    expect(quota.release).toHaveBeenCalledWith(model, quotaPermit);
  });
});
