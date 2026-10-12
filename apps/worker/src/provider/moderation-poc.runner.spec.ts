import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ModerationPocRunner, type ModerationPocInput } from './moderation-poc.runner.js';

function response(output: unknown) {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'moderation-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: JSON.stringify(output) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function input(): ModerationPocInput {
  return {
    runId: randomUUID(),
    traceId: randomUUID(),
    requestedCapabilities: ['moderation.text', 'moderation.image'],
    apiKey: 'relay-key-123456',
    model: {
      id: randomUUID(),
      provider: 'openai',
      protocolFamily: 'openai',
      apiVariant: 'openai_responses',
      modelId: 'moderation-model',
      version: '1',
      status: 'free_test_only',
      capabilityContractJson: {
        schema_version: 1,
        capabilities: ['moderation.text', 'moderation.image'],
        aspect_ratios: [],
        resolutions: [],
        max_outputs: 1,
        max_reference_images: 1,
      },
      pricingJson: {
        schema_version: 1,
        currency: 'CNY',
        provider_unit_cost_cny: '0.03',
        tool_cost_cny: '0.00',
        storage_cost_cny: '0.00',
        traffic_cost_cny: '0.00',
        agent_brain_cost_cny: '0.00',
        failure_rate: '0.00',
        unknown_rate: '0.00',
        refund_rate: '0.00',
        risk_reserve_rate: '0.10',
        gross_margin_target: '0.50',
        credit_cny_anchor: '0.01',
      },
      quotaJson: {
        schema_version: 1,
        rpm: 60,
        concurrency: 4,
        hourly_budget_cny: '10.00',
        daily_budget_cny: '100.00',
        poll_initial_delay_ms: 1_000,
        poll_interval_ms: 1_000,
        max_poll_count: 30,
        terminal_timeout_ms: 30_000,
        circuit_sample_size: 20,
        circuit_failure_rate: '0.50',
        circuit_unknown_rate: '0.20',
        circuit_open_ms: 60_000,
      },
    },
    channel: {
      id: randomUUID(),
      revision: 1,
      provider: 'openai',
      adapterKey: 'vercel-ai-relay-v1',
      endpointProfileKey: 'relay-v1',
      baseUrl: 'https://relay.test.invalid',
      region: null,
    },
    credentialVersionId: randomUUID(),
  };
}

describe('ModerationPocRunner', () => {
  it('runs fixed text/image pass, blocked, and fail-closed cases with bounded cost', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ decision: 'pass', confidence: 0.99 }))
      .mockResolvedValueOnce(
        response({
          decision: 'blocked',
          confidence: 0.98,
          reason_codes: ['intellectual_property'],
        }),
      )
      .mockResolvedValueOnce(response({ decision: 'pass', confidence: 0.97 }))
      .mockResolvedValueOnce(
        response({
          decision: 'blocked',
          confidence: 0.96,
          reason_codes: ['illegal_goods'],
        }),
      );

    const result = await new ModerationPocRunner(
      ['https://relay.test.invalid'],
      10_000,
      fetchImpl,
    ).run(input());

    expect(result).toMatchObject({
      status: 'passed',
      summary: {
        code: 'MODEL_MODERATION_POC_PASSED',
        capabilities: 'moderation.image,moderation.text',
        case_count: '6',
        provider_calls: '4',
        actual_cost_cny: '0.12',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(result)).not.toContain('COUNTERFEIT');
    expect(JSON.stringify(result)).not.toContain('relay-key-123456');
  }, 15_000);

  it('records an unknown terminal result without retrying', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 503 }));

    const result = await new ModerationPocRunner(
      ['https://relay.test.invalid'],
      10_000,
      fetchImpl,
    ).run(input());

    expect(result).toMatchObject({
      status: 'outcome_unknown',
      summary: { code: 'MODEL_MODERATION_POC_OUTCOME_UNKNOWN' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails before dispatch when the protocol binding is not approved', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const invalid = input();
    invalid.model.apiVariant = 'openai_images';

    await expect(
      new ModerationPocRunner(['https://relay.test.invalid'], 10_000, fetchImpl).run(invalid),
    ).resolves.toMatchObject({
      status: 'failed',
      summary: { code: 'MODEL_MODERATION_POC_BINDING_INVALID' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
