import { createHmac, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  providerSubmitOutcomeSchema,
  type ModelSnapshot,
  type ProviderAdapter,
  type ProviderCallContext,
} from './contracts.js';
import { calculateCostReport } from './cost-report.js';
import { evaluateCircuitWindow, hourlyDispatchExposureExceeded } from './circuit-policy.js';
import { FakeProviderAdapter } from './fake-provider.adapter.js';
import {
  ProviderGateway,
  ProviderOutcomeRecordingError,
  ProviderRegistry,
  ProviderWebhookRegistry,
} from './gateway.js';

function model(status: ModelSnapshot['status'] = 'free_test_only'): ModelSnapshot {
  return {
    id: randomUUID(),
    provider: 'fake',
    model_id: 'fake-image-v1',
    version: '1',
    status,
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
      tool_cost_cny: '0.01',
      storage_cost_cny: '0.01',
      traffic_cost_cny: '0.01',
      agent_brain_cost_cny: '0.02',
      failure_rate: '0.10',
      unknown_rate: '0.05',
      refund_rate: '0.05',
      risk_reserve_rate: '0.10',
      gross_margin_target: '0.50',
      credit_cny_anchor: '0.05',
    },
    quota: {
      schema_version: 1,
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

function context(deadlineAt = new Date(Date.now() + 1_000)): ProviderCallContext {
  return {
    idempotencyKey: randomUUID(),
    requestDigest: 'a'.repeat(64),
    traceId: randomUUID(),
    deadlineAt,
    signal: new AbortController().signal,
  };
}

function imageInput() {
  return {
    prompt: 'test-only prompt',
    aspect_ratio: '1:1',
    resolution: '1024x1024',
    output_count: 1,
  };
}

function gateway(adapter: FakeProviderAdapter, mode: 'workflow' | 'poc' | 'test' = 'test') {
  return new ProviderGateway(new ProviderRegistry([adapter]), {
    mode,
    circuitGate: { assertCanSubmit: vi.fn().mockResolvedValue(undefined) },
    quotaGate: { reserve: vi.fn().mockResolvedValue(undefined) },
  });
}

describe('Provider Gateway', () => {
  it('executes the exact fake model and preserves a succeeded receipt', async () => {
    const adapter = new FakeProviderAdapter('succeeded');
    const outcome = await gateway(adapter).submit(
      model(),
      { capability: 'image.generate', input: imageInput() },
      context(),
    );
    expect(outcome.kind).toBe('succeeded');
    expect(adapter.submitCount).toBe(1);
  });

  it('replays one deterministic result for the same idempotency key', async () => {
    const adapter = new FakeProviderAdapter('succeeded');
    const providerGateway = gateway(adapter);
    const callContext = context();

    const first = await providerGateway.submit(
      model(),
      { capability: 'image.generate', input: imageInput() },
      callContext,
    );
    const replay = await providerGateway.submit(
      model(),
      { capability: 'image.generate', input: imageInput() },
      callContext,
    );

    expect(replay).toEqual(first);
    expect(adapter.submitCount).toBe(1);
  });

  it('preserves a received outcome when circuit evidence storage fails', async () => {
    const adapter = new FakeProviderAdapter('succeeded');
    const providerGateway = new ProviderGateway(new ProviderRegistry([adapter]), {
      mode: 'test',
      circuitGate: {
        assertCanSubmit: () => Promise.resolve(),
        recordOutcome: () => Promise.reject(new Error('circuit storage unavailable')),
      },
      quotaGate: { reserve: () => Promise.resolve() },
    });

    const failure = await providerGateway
      .submit(model(), { capability: 'image.generate', input: imageInput() }, context())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderOutcomeRecordingError);
    expect(failure).toMatchObject({ outcome: { kind: 'succeeded' } });
    expect(adapter.submitCount).toBe(1);
  });

  it.each(['outcome_unknown', 'throw'] as const)(
    'converges %s to outcome_unknown without a second submit',
    async (scenario) => {
      const adapter = new FakeProviderAdapter(scenario);
      const outcome = await gateway(adapter).submit(
        model(),
        { capability: 'image.generate', input: imageInput() },
        context(),
      );
      expect(outcome.kind).toBe('outcome_unknown');
      expect(adapter.submitCount).toBe(1);
    },
  );

  it('aborts the adapter at the deadline and holds concurrency until transport settles', async () => {
    let transportSignal: AbortSignal | undefined;
    let settleTransport: (() => void) | undefined;
    const adapter: ProviderAdapter = {
      provider: 'fake',
      modelId: 'fake-image-v1',
      version: '1',
      capabilities: ['image.generate'],
      submit: (_request, _model, callContext) => {
        transportSignal = callContext.signal;
        return new Promise((resolve) => {
          settleTransport = () =>
            resolve({
              kind: 'not_dispatched',
              error_code: 'provider_cancelled',
              retryable: false,
              request_digest: callContext.requestDigest,
            });
        });
      },
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const providerGateway = new ProviderGateway(new ProviderRegistry([adapter]), {
      mode: 'test',
      circuitGate: { assertCanSubmit: () => Promise.resolve() },
      quotaGate: { reserve: () => Promise.resolve(), release },
    });

    await expect(
      providerGateway.submit(
        model(),
        { capability: 'image.generate', input: imageInput() },
        context(new Date(Date.now() + 30)),
      ),
    ).resolves.toMatchObject({ kind: 'outcome_unknown', error_code: 'provider_timeout' });
    expect(transportSignal?.aborted).toBe(true);
    expect(release).not.toHaveBeenCalled();

    settleTransport?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it('fails closed when a workflow model is not PoC-approved', async () => {
    await expect(
      gateway(new FakeProviderAdapter(), 'workflow').submit(
        model('free_test_only'),
        { capability: 'image.generate', input: {} },
        context(),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_MODEL_NOT_APPROVED',
    });
  });

  it('rejects real providers in test mode before adapter lookup', async () => {
    await expect(
      gateway(new FakeProviderAdapter()).submit(
        { ...model(), provider: 'real-provider' },
        { capability: 'image.generate', input: {} },
        context(),
      ),
    ).rejects.toMatchObject({
      code: 'PROVIDER_TEST_ADAPTER_REQUIRED',
    });
  });

  it('rejects unknown fields and values outside the model capability snapshot', async () => {
    await expect(
      gateway(new FakeProviderAdapter()).submit(
        model(),
        {
          capability: 'image.generate',
          input: { ...imageInput(), output_count: 5, endpoint: 'https://untrusted.example' },
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INPUT_INVALID' });
  });

  it('validates image-edit references and image moderation through their dedicated schemas', async () => {
    const editModel = {
      ...model(),
      capability_contract: {
        ...model().capability_contract,
        capabilities: ['image.edit', 'moderation.image'] as const,
        max_reference_images: 1,
      },
    };
    const providerGateway = gateway(new FakeProviderAdapter('succeeded'));
    await expect(
      providerGateway.submit(
        editModel,
        {
          capability: 'image.edit',
          input: {
            ...imageInput(),
            reference_asset_ids: [randomUUID()],
          },
        },
        context(),
      ),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    await expect(
      providerGateway.submit(
        editModel,
        {
          capability: 'image.edit',
          input: {
            ...imageInput(),
            reference_asset_ids: [randomUUID(), randomUUID()],
          },
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INPUT_INVALID' });
    await expect(
      providerGateway.moderateImage(editModel, { asset_id: randomUUID() }, context()),
    ).resolves.toMatchObject({ decision: 'pass' });
  });

  it('rejects unknown fields in an immutable model snapshot', async () => {
    await expect(
      gateway(new FakeProviderAdapter()).submit(
        { ...model(), undocumented_endpoint: 'https://example.invalid' },
        { capability: 'image.generate', input: imageInput() },
        context(),
      ),
    ).rejects.toThrow();
  });

  it.each([
    ['accepted', 'accepted'],
    ['not_dispatched', 'not_dispatched'],
    ['failed', 'failed'],
  ] as const)('normalizes the fake %s submit outcome', async (scenario, kind) => {
    await expect(
      gateway(new FakeProviderAdapter(scenario)).submit(
        model(),
        { capability: 'image.generate', input: imageInput() },
        context(),
      ),
    ).resolves.toMatchObject({ kind });
  });

  it('requires accepted-request evidence when a failed outcome omits the request ID', () => {
    const failedAt = new Date();
    expect(
      providerSubmitOutcomeSchema.safeParse({
        kind: 'failed',
        error_code: 'provider_content_rejected',
        receipt_summary: { status_code_family: '4xx' },
        failed_at: failedAt,
      }).success,
    ).toBe(true);
    expect(
      providerSubmitOutcomeSchema.safeParse({
        kind: 'failed',
        error_code: 'provider_content_rejected',
        receipt_summary: {},
        failed_at: failedAt,
      }).success,
    ).toBe(false);
  });

  it('reserves quota for polling without applying the submit circuit gate', async () => {
    const adapter = new FakeProviderAdapter('accepted');
    const reserve = vi.fn().mockResolvedValue({
      concurrencyKey: 'poll-concurrency',
      concurrencyToken: 'poll-owner',
    });
    const release = vi.fn().mockResolvedValue(undefined);
    const assertCanSubmit = vi.fn().mockRejectedValue(new Error('circuit is open'));
    const providerGateway = new ProviderGateway(new ProviderRegistry([adapter]), {
      mode: 'test',
      circuitGate: { assertCanSubmit },
      quotaGate: { reserve, release },
    });

    await expect(
      providerGateway.poll(model(), { providerRequestId: 'accepted-request' }, context()),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(reserve).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(assertCanSubmit).not.toHaveBeenCalled();
  });

  it('holds polling concurrency until a timed-out transport settles', async () => {
    let settleTransport: (() => void) | undefined;
    const adapter: ProviderAdapter = {
      provider: 'fake',
      modelId: 'fake-image-v1',
      version: '1',
      capabilities: ['image.generate'],
      submit: () => Promise.reject(new Error('submit is not used by this test')),
      poll: (_input, _model, callContext) =>
        new Promise((resolve) => {
          settleTransport = () =>
            resolve({
              kind: 'outcome_unknown',
              error_code: 'provider_cancelled',
              request_digest: callContext.requestDigest,
              unknown_at: new Date(),
            });
        }),
    };
    const release = vi.fn().mockResolvedValue(undefined);
    const providerGateway = new ProviderGateway(new ProviderRegistry([adapter]), {
      mode: 'test',
      circuitGate: { assertCanSubmit: () => Promise.resolve() },
      quotaGate: { reserve: () => Promise.resolve(), release },
    });

    await expect(
      providerGateway.poll(
        model(),
        { providerRequestId: 'accepted-request' },
        context(new Date(Date.now() + 30)),
      ),
    ).resolves.toMatchObject({ kind: 'outcome_unknown', error_code: 'provider_timeout' });
    expect(release).not.toHaveBeenCalled();

    settleTransport?.();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it.each([
    ['succeeded', 'pass'],
    ['failed', 'blocked'],
    ['outcome_unknown', 'unknown'],
  ] as const)('normalizes fake text moderation %s as %s', async (scenario, decision) => {
    const moderationModel = {
      ...model(),
      capability_contract: {
        ...model().capability_contract,
        capabilities: ['moderation.text', 'moderation.image'] as const,
      },
    };
    await expect(
      gateway(new FakeProviderAdapter(scenario)).moderateText(
        moderationModel,
        { text: 'approved test fixture' },
        context(),
      ),
    ).resolves.toMatchObject({ decision });
  });

  it('fails moderation closed when the adapter does not answer before the deadline', async () => {
    const moderationModel = {
      ...model(),
      capability_contract: {
        ...model().capability_contract,
        capabilities: ['moderation.text'] as const,
      },
    };
    await expect(
      gateway(new FakeProviderAdapter('never')).moderateText(
        moderationModel,
        { text: 'timeout fixture' },
        context(new Date(Date.now() + 10)),
      ),
    ).resolves.toMatchObject({ decision: 'unknown', error_code: 'provider_timeout' });
  });
});

describe('Provider cost report', () => {
  const baseInput = {
    providerUnitCostCny: '0.10',
    toolCostCny: '0.01',
    storageCostCny: '0.01',
    trafficCostCny: '0.01',
    agentBrainCostCny: '0.02',
    failureRate: '0.10',
    unknownRate: '0.05',
    refundRate: '0.05',
    riskReserveRate: '0.10',
    grossMarginTarget: '0.50',
    creditCnyAnchor: '0.05',
  };

  it('uses decimal arithmetic and rounds credits upward', () => {
    expect(calculateCostReport(baseInput)).toEqual({
      directCostCny: '0.15',
      riskAdjustedCostCny: '0.20',
      priceCny: '0.39',
      suggestedCredits: '8',
    });
  });

  it.each([
    ['grossMarginTarget', '1'],
    ['failureRate', '1.1'],
    ['creditCnyAnchor', '0'],
  ] as const)('rejects invalid %s', (key, value) => {
    expect(() => calculateCostReport({ ...baseInput, [key]: value })).toThrow();
  });
});

describe('Provider webhook verification', () => {
  const secret = Buffer.alloc(32, 11);
  const now = new Date('2026-08-11T01:02:03.000Z');
  const body = Buffer.from(
    JSON.stringify({
      event_id: 'fake-event-1',
      request_id: 'fake-request-1',
      status: 'failed',
      failed_at: now.toISOString(),
      error_code: 'provider_content_rejected',
    }),
  );

  function headers(timestamp = Math.floor(now.getTime() / 1_000).toString()) {
    return {
      'x-provider-key-id': 'fake-webhook-v1',
      'x-provider-timestamp': timestamp,
      'x-provider-signature': createHmac('sha256', secret)
        .update(timestamp)
        .update('.')
        .update(body)
        .digest('base64url'),
    };
  }

  it('verifies the raw bytes before returning a normalized callback', async () => {
    const registry = new ProviderWebhookRegistry([
      new FakeProviderAdapter('succeeded', () => now, {
        keyId: 'fake-webhook-v1',
        secret,
      }),
    ]);

    await expect(
      registry.verify('fake', body, headers(), { now, clockSkewSeconds: 300 }),
    ).resolves.toMatchObject({
      kind: 'failed',
      signature_key_id: 'fake-webhook-v1',
      event_id: 'fake-event-1',
      provider_request_id: 'fake-request-1',
    });
  });

  it('rejects a tampered signature and a stale timestamp', async () => {
    const registry = new ProviderWebhookRegistry([
      new FakeProviderAdapter('succeeded', () => now, {
        keyId: 'fake-webhook-v1',
        secret,
      }),
    ]);
    await expect(
      registry.verify(
        'fake',
        body,
        { ...headers(), 'x-provider-signature': 'invalid' },
        {
          now,
          clockSkewSeconds: 300,
        },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_WEBHOOK_SIGNATURE_INVALID' });
    await expect(
      registry.verify('fake', body, headers('1700000000'), { now, clockSkewSeconds: 300 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_WEBHOOK_CLOCK_SKEW' });
  });
});

describe('Provider circuit policy', () => {
  it('opens only after the model snapshot sample and rate thresholds are reached', () => {
    expect(
      evaluateCircuitWindow({
        sampleCount: 9,
        failureCount: 9,
        unknownCount: 0,
        model: model(),
      }),
    ).toBeNull();
    expect(
      evaluateCircuitWindow({
        sampleCount: 10,
        failureCount: 5,
        unknownCount: 0,
        model: model(),
      }),
    ).toBe('failure_rate');
    expect(
      evaluateCircuitWindow({
        sampleCount: 10,
        failureCount: 0,
        unknownCount: 2,
        model: model(),
      }),
    ).toBe('unknown_rate');
  });

  it('compares hourly exposure with decimal arithmetic', () => {
    expect(
      hourlyDispatchExposureExceeded({
        count: 3,
        riskAdjustedUnitCostCny: '0.333333333333333333',
        hourlyBudgetCny: '1.00',
      }),
    ).toBe(false);
    expect(
      hourlyDispatchExposureExceeded({
        count: 4,
        riskAdjustedUnitCostCny: '0.333333333333333333',
        hourlyBudgetCny: '1.00',
      }),
    ).toBe(true);
  });
});
