import { randomUUID } from 'node:crypto';

import {
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
} from '@ecom-forge/provider';
import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ImagePocRunner, type ImagePocInput } from './image-poc.runner.js';

let outputPng: Buffer;

beforeAll(async () => {
  outputPng = await sharp({
    create: { width: 1_024, height: 1_024, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
});

function input(): ImagePocInput {
  const channelId = randomUUID();
  return {
    runId: randomUUID(),
    traceId: randomUUID(),
    requestedSpecKeys: ['generate-1k', 'edit-1k'],
    apiKey: 'relay-key-123456',
    model: {
      id: randomUUID(),
      providerChannelId: channelId,
      provider: 'openai',
      protocolFamily: 'openai',
      apiVariant: 'openai_images',
      modelId: 'image-model-test',
      version: '1',
      status: 'free_test_only',
      capabilityContractJson: {
        schema_version: 2,
        contract_kind: 'media',
        media_kind: 'image',
        capabilities: ['image.generate', 'image.edit'],
        specs: [
          {
            kind: 'image',
            spec_key: 'generate-1k',
            operation: 'image.generate',
            mode: 'standard',
            resolution_tier: '1k',
            aspect_ratios: ['1:1'],
            max_outputs: 1,
            max_reference_images: 0,
            transparent_background: false,
            output_formats: ['png'],
          },
          {
            kind: 'image',
            spec_key: 'edit-1k',
            operation: 'image.edit',
            mode: 'standard',
            resolution_tier: '1k',
            aspect_ratios: ['1:1'],
            max_outputs: 1,
            max_reference_images: 1,
            transparent_background: false,
            output_formats: ['png'],
          },
        ],
      },
      pricingJson: {
        schema_version: 2,
        contract_kind: 'media_rate_card',
        currency: 'CNY',
        rate_cards: [
          {
            rate_key: 'generate-rate',
            spec_key: 'generate-1k',
            billing_unit: 'image',
            unit_cost_cny: '0.12',
          },
          {
            rate_key: 'edit-rate',
            spec_key: 'edit-1k',
            billing_unit: 'image',
            unit_cost_cny: '0.15',
          },
        ],
        overhead_cny: { tool: '0', storage: '0', traffic: '0', agent_brain: '0' },
        failure_rate: '0',
        unknown_rate: '0',
        refund_rate: '0',
        risk_reserve_rate: '0.1',
        gross_margin_target: '0.3',
        credit_cny_anchor: '0.01',
      },
      quotaJson: {
        schema_version: 1,
        rpm: 60,
        concurrency: 2,
        hourly_budget_cny: '10',
        daily_budget_cny: '100',
        poll_initial_delay_ms: 1_000,
        poll_interval_ms: 2_000,
        max_poll_count: 10,
        terminal_timeout_ms: 30_000,
        circuit_sample_size: 20,
        circuit_failure_rate: '0.5',
        circuit_unknown_rate: '0.2',
        circuit_open_ms: 60_000,
      },
    },
    channel: {
      id: channelId,
      revision: 1,
      provider: 'openai',
      adapterKey: VERCEL_AI_AGENT_ADAPTER_KEY,
      endpointProfileKey: VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
      baseUrl: 'https://relay.test.invalid',
      region: null,
    },
    credentialVersionId: randomUUID(),
  };
}

function successResponse(requestId: string) {
  return new Response(
    JSON.stringify({
      id: requestId,
      data: [{ b64_json: outputPng.toString('base64') }],
      output_format: 'png',
      size: '1024x1024',
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': requestId } },
  );
}

function runner(fetchImpl: typeof fetch) {
  return new ImagePocRunner(
    ['https://relay.test.invalid'],
    ['https://relay.test.invalid'],
    10_000,
    20 * 1024 * 1024,
    40_000_000,
    fetchImpl,
  );
}

describe('Image PoC runner', () => {
  it('proves requested generation and edit specs with bounded, redacted evidence', async () => {
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(() => {
      call += 1;
      return Promise.resolve(successResponse(`req-${call}`));
    });
    const result = await runner(fetchImpl).run(input());

    expect(result).toMatchObject({
      status: 'passed',
      summary: {
        code: 'MODEL_IMAGE_POC_PASSED',
        category: 'image',
        spec_count: '2',
        provider_calls: '2',
        actual_cost_cny: '0.27',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map(([url]) => fetchInputUrl(url));
    expect(urls).toContain('https://relay.test.invalid/v1/images/generations');
    expect(urls).toContain('https://relay.test.invalid/v1/images/edits');
    const editCall = fetchImpl.mock.calls.find(([url]) =>
      fetchInputUrl(url).endsWith('/images/edits'),
    );
    expect(editCall?.[1]?.body).toBeInstanceOf(FormData);
    expect((editCall?.[1]?.body as FormData).getAll('image')).toHaveLength(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('relay-key-123456');
    expect(serialized).not.toContain(outputPng.toString('base64'));
    expect(serialized).not.toContain('blue ceramic mug');
  });

  it('returns outcome_unknown after one ambiguous transport failure and never retries', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection reset'));
    const result = await runner(fetchImpl).run(input());

    expect(result).toMatchObject({
      status: 'outcome_unknown',
      summary: {
        code: 'MODEL_IMAGE_POC_OUTCOME_UNKNOWN',
        attempted_spec_key: 'generate-1k',
        provider_error_code: 'provider_unavailable',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects protocol, channel and spec drift before any network call', async () => {
    const cases = [
      { model: { apiVariant: 'openai_responses' } },
      { channel: { endpointProfileKey: 'arbitrary-endpoint' } },
      { requestedSpecKeys: ['missing-spec'] },
    ];
    for (const change of cases) {
      const value = input();
      Object.assign(value, {
        ...change,
        ...(change.model ? { model: { ...value.model, ...change.model } } : {}),
        ...(change.channel ? { channel: { ...value.channel, ...change.channel } } : {}),
      });
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(runner(fetchImpl).run(value)).resolves.toMatchObject({ status: 'failed' });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('fails closed on malformed output without a second Provider call', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'req-bad',
          data: [{ b64_json: Buffer.from('not an image').toString('base64') }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-bad' },
        },
      ),
    );
    await expect(runner(fetchImpl).run(input())).resolves.toMatchObject({
      status: 'outcome_unknown',
      summary: {
        attempted_spec_key: 'generate-1k',
        provider_error_code: 'provider_response_invalid',
        provider_diagnostic_code: 'output_media_or_dimensions_invalid',
        provider_response_shape: 'not_available',
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function fetchInputUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
