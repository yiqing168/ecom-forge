import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { ProviderCallContext, ProviderRequest } from '../contracts.js';
import { mediaV2ModelSnapshotSchema } from '../model-contracts.js';
import {
  buildOpenAiImageSpecBindings,
  resolveOpenAiImageDimensions,
  OpenAiImagesAdapter,
  type OpenAiImagesAdapterLimits,
  type OpenAiReferenceImage,
} from './openai-images.adapter.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlK0AAAAASUVORK5CYII=',
  'base64',
);
const ASSET_ID = '00000000-0000-4000-8000-000000000001';

function snapshot() {
  return mediaV2ModelSnapshotSchema.parse({
    id: randomUUID(),
    provider_channel_id: randomUUID(),
    provider: 'openai',
    model_id: 'image-model-test',
    version: '1',
    status: 'poc_passed',
    capability_contract: {
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
          max_outputs: 2,
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
          max_reference_images: 2,
          transparent_background: false,
          output_formats: ['png'],
        },
      ],
    },
    pricing: {
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
    quota: {
      schema_version: 1,
      rpm: 60,
      concurrency: 4,
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
  });
}

function context(): ProviderCallContext {
  return {
    idempotencyKey: 'image-operation-1234567890',
    requestDigest: 'a'.repeat(64),
    traceId: randomUUID(),
    deadlineAt: new Date(Date.now() + 10_000),
    signal: new AbortController().signal,
  };
}

function request(
  capability: 'image.generate' | 'image.edit' = 'image.generate',
  overrides: Record<string, unknown> = {},
): ProviderRequest {
  return {
    capability,
    input: {
      spec_key: capability === 'image.generate' ? 'generate-1k' : 'edit-1k',
      prompt: 'Render one blue ceramic mug on a clean white background.',
      aspect_ratio: '1:1',
      resolution_tier: '1k',
      output_count: 1,
      output_format: 'png',
      reference_asset_ids: capability === 'image.edit' ? [ASSET_ID] : [],
      ...overrides,
    },
  };
}

function providerResponse(
  data: unknown = [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
  init: { status?: number; headers?: Record<string, string>; extra?: Record<string, unknown> } = {},
) {
  return new Response(
    JSON.stringify({
      id: 'image-response-1',
      created: 1_700_000_000,
      data,
      output_format: 'png',
      size: 'auto',
      ...init.extra,
    }),
    {
      status: init.status ?? 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-image-1',
        ...init.headers,
      },
    },
  );
}

function providerFetch(response: Response = providerResponse()) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

function referenceImage(): OpenAiReferenceImage {
  return {
    bytes: ONE_PIXEL_PNG,
    mediaType: 'image/png',
    filename: 'source.png',
    contentHash: createHash('sha256').update(ONE_PIXEL_PNG).digest('hex'),
  };
}

function adapter(
  fetchImpl: typeof fetch,
  resolveReference = vi.fn(() => Promise.resolve(referenceImage())),
  limits: Partial<OpenAiImagesAdapterLimits> = {},
) {
  return new OpenAiImagesAdapter(
    'image-model-test',
    '1',
    'relay-key-123456',
    'https://relay.test.invalid',
    ['https://relay.test.invalid'],
    ['https://cdn.test.invalid'],
    [
      {
        specKey: 'generate-1k',
        aspectRatio: '1:1',
        resolutionTier: '1k',
        providerSize: '1x1',
        width: 1,
        height: 1,
        outputFormats: ['png'],
      },
      {
        specKey: 'edit-1k',
        aspectRatio: '1:1',
        resolutionTier: '1k',
        providerSize: '1x1',
        width: 1,
        height: 1,
        outputFormats: ['png'],
      },
    ],
    resolveReference,
    fetchImpl,
    limits,
  );
}

describe('OpenAI Images adapter', () => {
  const screenshotDimensions = [
    { ratio: '1:1', '1k': [1024, 1024], '2k': [2048, 2048], '4k': [2880, 2880] },
    { ratio: '3:4', '1k': [864, 1152], '2k': [1728, 2304], '4k': [2448, 3264] },
    { ratio: '4:3', '1k': [1152, 864], '2k': [2304, 1728], '4k': [3264, 2448] },
    { ratio: '16:9', '1k': [1280, 720], '2k': [2560, 1440], '4k': [3840, 2160] },
    { ratio: '9:16', '1k': [720, 1280], '2k': [1440, 2560], '4k': [2160, 3840] },
  ] as const;

  for (const tier of ['1k', '2k', '4k'] as const) {
    it.each(screenshotDimensions)(`matches the supplied ${tier} dimensions for $ratio`, (row) => {
      const [width, height] = row[tier];
      expect(resolveOpenAiImageDimensions(row.ratio, tier)).toEqual({ width, height });
      expect(resolveOpenAiImageDimensions(row.ratio, tier, 8_294_400)).toEqual({ width, height });
    });
  }

  it('uses the same formula for other ratios and reduces equivalent ratios first', () => {
    expect(resolveOpenAiImageDimensions('7:5', '1k')).toEqual({ width: 1120, height: 800 });
    expect(resolveOpenAiImageDimensions('7:5', '2k')).toEqual({ width: 2352, height: 1680 });
    expect(resolveOpenAiImageDimensions('7:5', '4k')).toEqual({ width: 3360, height: 2400 });
    expect(resolveOpenAiImageDimensions('16:10', '4k')).toEqual({ width: 3584, height: 2240 });
    expect(resolveOpenAiImageDimensions('8:5', '4k')).toEqual({ width: 3584, height: 2240 });
    expect(resolveOpenAiImageDimensions('300:400', '4k')).toEqual({ width: 2448, height: 3264 });
    expect(resolveOpenAiImageDimensions('999:999', '4k')).toEqual({ width: 2880, height: 2880 });
  });

  it.each(['2:1', '1:2', '5:2', '2:5'])(
    'rejects unavailable 4K edge lengths for %s without shrinking the selected tier',
    (ratio) => {
      expect(() => resolveOpenAiImageDimensions(ratio, '4k')).toThrow(
        'IMAGE_SPEC_PROVIDER_SIZE_UNAVAILABLE',
      );
    },
  );

  it('rejects undersized pixel budgets and unrepresentable ratios without downgrading', () => {
    expect(() => resolveOpenAiImageDimensions('3:4', '4k', 7_990_271)).toThrow(
      'IMAGE_SPEC_PROVIDER_SIZE_UNAVAILABLE',
    );
    expect(resolveOpenAiImageDimensions('3:4', '4k', 7_990_272)).toEqual({
      width: 2448,
      height: 3264,
    });
    expect(() => resolveOpenAiImageDimensions('997:996', '1k')).toThrow(
      'IMAGE_SPEC_PROVIDER_SIZE_UNAVAILABLE',
    );
    for (const invalidLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveOpenAiImageDimensions('1:1', '1k', invalidLimit)).toThrow(
        'IMAGE_SPEC_PROVIDER_SIZE_UNAVAILABLE',
      );
    }
    expect(() => resolveOpenAiImageDimensions('1:4', '4k')).toThrow(
      'IMAGE_SPEC_ASPECT_RATIO_UNSUPPORTED',
    );
  });

  it.each(['0:1', '1:0', '3/4', '1.5:1', '1000:1', '1:1 trailing'])(
    'rejects invalid ratio %s',
    (ratio) => {
      expect(() => resolveOpenAiImageDimensions(ratio, '1k')).toThrow(
        'IMAGE_SPEC_ASPECT_RATIO_UNSUPPORTED',
      );
    },
  );
  it('maps aspect ratios to Provider-valid 16-pixel dimensions within image limits', () => {
    const bindings = buildOpenAiImageSpecBindings([
      {
        kind: 'image',
        spec_key: 'edit-1k',
        operation: 'image.edit',
        mode: 'standard',
        resolution_tier: '1k',
        aspect_ratios: ['3:4'],
        max_outputs: 1,
        max_reference_images: 1,
        transparent_background: false,
        output_formats: ['png'],
      },
      {
        kind: 'image',
        spec_key: 'edit-4k',
        operation: 'image.edit',
        mode: 'standard',
        resolution_tier: '4k',
        aspect_ratios: ['1:1', '9:16'],
        max_outputs: 1,
        max_reference_images: 1,
        transparent_background: false,
        output_formats: ['png'],
      },
    ]);

    expect(bindings).toEqual([
      expect.objectContaining({ providerSize: '864x1152', width: 864, height: 1152 }),
      expect.objectContaining({ providerSize: '2880x2880', width: 2880, height: 2880 }),
      expect.objectContaining({ providerSize: '2160x3840', width: 2160, height: 3840 }),
    ]);
    expect(
      bindings.every(
        (binding) =>
          binding.width % 16 === 0 &&
          binding.height % 16 === 0 &&
          binding.width <= 3840 &&
          binding.height <= 3840 &&
          binding.width * binding.height <= 8_294_400,
      ),
    ).toBe(true);
  });

  for (const operation of ['image.generate', 'image.edit'] as const) {
    for (const tier of ['1k', '2k', '4k'] as const) {
      it.each(screenshotDimensions)(
        `sends exact screenshot dimensions and high quality for ${operation} ${tier} $ratio`,
        async (row) => {
          const model = snapshot();
          const spec = model.capability_contract.specs.find((item) => item.operation === operation);
          if (!spec || spec.kind !== 'image') throw new Error('Expected image spec');
          spec.resolution_tier = tier;
          spec.aspect_ratios = [row.ratio];
          const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('{}', { status: 400 }));
          const imageAdapter = new OpenAiImagesAdapter(
            model.model_id,
            model.version,
            'relay-key-123456',
            'https://relay.test.invalid',
            ['https://relay.test.invalid'],
            ['https://cdn.test.invalid'],
            buildOpenAiImageSpecBindings(
              model.capability_contract.specs.filter((item) => item.kind === 'image'),
            ),
            () => Promise.resolve(referenceImage()),
            fetchImpl,
          );

          const outcome = await imageAdapter.execute(
            request(operation, { aspect_ratio: row.ratio, resolution_tier: tier }),
            model,
            context(),
          );

          expect(outcome.kind).toBe('failed');
          expect(fetchImpl).toHaveBeenCalledTimes(1);
          const init = fetchImpl.mock.calls[0]?.[1];
          const [width, height] = row[tier];
          const size = `${width}x${height}`;
          if (operation === 'image.generate') {
            if (typeof init?.body !== 'string') throw new Error('Expected JSON request');
            expect(JSON.parse(init.body)).toMatchObject({ size, quality: 'high' });
          } else {
            if (!(init?.body instanceof FormData)) throw new Error('Expected multipart request');
            expect(init.body.get('size')).toBe(size);
            expect(init.body.get('quality')).toBe('high');
          }
        },
      );
    }
  }

  it('uses the fixed generation endpoint and returns one redacted, single-use byte lease', async () => {
    const fetchImpl = providerFetch();
    const outcome = await adapter(fetchImpl).execute(request(), snapshot(), context());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://relay.test.invalid/v1/images/generations');
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer relay-key-123456' });
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(init.body)).toEqual({
      model: 'image-model-test',
      prompt: 'Render one blue ceramic mug on a clean white background.',
      n: 1,
      background: 'auto',
      quality: 'high',
      size: '1x1',
      response_format: 'url',
    });
    expect(outcome).toMatchObject({
      kind: 'succeeded',
      provider_request_id: 'req-image-1',
      cost_summary: { amount: '0.12', provider_units: '1' },
    });
    if (outcome.kind !== 'succeeded') throw new Error('Expected success');
    expect(JSON.stringify(outcome.outputs[0])).toContain('[REDACTED]');
    expect(JSON.stringify(outcome.outputs[0])).not.toContain(ONE_PIXEL_PNG.toString('base64'));
    await expect(
      outcome.outputs[0]?.consume((bytes) => Promise.resolve(bytes.byteLength)),
    ).resolves.toBe(ONE_PIXEL_PNG.byteLength);
    await expect(outcome.outputs[0]?.consume(() => Promise.resolve(0))).rejects.toThrow(
      'PROVIDER_IMAGE_OUTPUT_ALREADY_CONSUMED',
    );
  });

  it('does not apply the retired 16k transport prompt limit', async () => {
    const fetchImpl = providerFetch();
    const longPrompt = 'visible mark '.repeat(1_600);

    const outcome = await adapter(fetchImpl).execute(
      request('image.generate', { prompt: longPrompt }),
      snapshot(),
      context(),
    );

    expect(outcome.kind).toBe('succeeded');
    const init = fetchImpl.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({ prompt: longPrompt });
  });

  it('accepts OpenAI-compatible extra metadata and nullable revised prompts', async () => {
    const fetchImpl = providerFetch(
      providerResponse(
        [
          {
            b64_json: ONE_PIXEL_PNG.toString('base64'),
            revised_prompt: null,
            provider_metadata: { route: 'image' },
          },
        ],
        { extra: { model: 'image-model-test', provider_trace: 'redacted' } },
      ),
    );

    await expect(
      adapter(fetchImpl).execute(request(), snapshot(), context()),
    ).resolves.toMatchObject({ kind: 'succeeded', provider_request_id: 'req-image-1' });
  });

  it('derives a stable receipt id when a synchronous relay omits response ids', async () => {
    const fetchImpl = providerFetch(
      providerResponse(undefined, {
        headers: { 'x-request-id': '' },
        extra: { id: undefined },
      }),
    );

    const outcome = await adapter(fetchImpl).execute(request(), snapshot(), context());

    expect(outcome).toMatchObject({ kind: 'succeeded' });
    if (outcome.kind !== 'succeeded') throw new Error('Expected success');
    expect(outcome.provider_request_id).toMatch(/^sync-[a-f0-9]{64}$/);
  });

  it('uses multipart on the fixed edits endpoint with server-resolved reference bytes', async () => {
    const fetchImpl = providerFetch();
    const resolveReference = vi.fn(() => Promise.resolve(referenceImage()));
    const outcome = await adapter(fetchImpl, resolveReference).execute(
      request('image.edit'),
      snapshot(),
      context(),
    );

    expect(outcome).toMatchObject({ kind: 'succeeded', cost_summary: { amount: '0.15' } });
    expect(resolveReference).toHaveBeenCalledWith(ASSET_ID, expect.any(AbortSignal));
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://relay.test.invalid/v1/images/edits');
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('image-model-test');
    expect(form.get('size')).toBe('1x1');
    expect(form.get('background')).toBe('auto');
    expect(form.get('quality')).toBe('high');
    expect(form.getAll('image')).toHaveLength(1);
    expect(form.getAll('image[]')).toHaveLength(0);
    expect((form.get('image') as File).type).toBe('image/png');
    expect(form.get('response_format')).toBe('url');
    expect(form.has('output_format')).toBe(false);
    expect(init?.headers).not.toHaveProperty('content-type');
  });

  it('downloads URL outputs through a bounded single-use GET and yields a byte lease', async () => {
    const download = new Response(ONE_PIXEL_PNG, {
      headers: { 'content-type': 'image/png' },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(providerResponse([{ url: 'https://cdn.test.invalid/output.png' }]))
      .mockResolvedValueOnce(download);

    const outcome = await adapter(fetchImpl).execute(request(), snapshot(), context());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [downloadUrl, downloadInit] = fetchImpl.mock.calls[1] ?? [];
    expect(downloadUrl).toBe('https://cdn.test.invalid/output.png');
    expect(downloadInit?.method).toBe('GET');
    expect(downloadInit?.redirect).toBe('manual');
    expect(downloadInit?.headers).toMatchObject({ accept: 'image/png' });
    expect(outcome).toMatchObject({
      kind: 'succeeded',
      outputs: [{ metadata: { width: 1, height: 1, media_type: 'image/png' } }],
    });
    if (outcome.kind !== 'succeeded') throw new Error('Expected success');
    await expect(
      outcome.outputs[0]?.consume((bytes) => Promise.resolve(bytes.byteLength)),
    ).resolves.toBe(ONE_PIXEL_PNG.byteLength);
  });

  it('rejects output URLs outside the configured Provider origin allowlist before download', async () => {
    for (const url of [
      'https://127.0.0.1/output.png',
      'https://cdn.test.invalid.attacker.example/output.png',
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(providerResponse([{ url }]));

      await expect(
        adapter(fetchImpl).execute(request(), snapshot(), context()),
      ).resolves.toMatchObject({
        kind: 'outcome_unknown',
        error_code: 'provider_response_invalid',
        diagnostic_code: 'output_url_invalid',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds concurrent output URL downloads while preserving output order', async () => {
    let activeDownloads = 0;
    let maximumActiveDownloads = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method !== 'GET') {
        return providerResponse([
          { url: 'https://cdn.test.invalid/first.png' },
          { url: 'https://cdn.test.invalid/second.png' },
        ]);
      }
      activeDownloads += 1;
      maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeDownloads -= 1;
      return new Response(ONE_PIXEL_PNG, { headers: { 'content-type': 'image/png' } });
    });

    const outcome = await adapter(fetchImpl, undefined, {
      maxOutputDownloadConcurrency: 1,
    }).execute(request('image.generate', { output_count: 2 }), snapshot(), context());

    expect(outcome.kind).toBe('succeeded');
    expect(maximumActiveDownloads).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    if (outcome.kind !== 'succeeded') throw new Error('Expected success');
    expect(outcome.outputs.map((item) => item.metadata.provider_output_id)).toEqual([
      'req-image-1:0',
      'req-image-1:1',
    ]);
  });

  it('rejects unsafe or drifted URL downloads as outcome unknown', async () => {
    const cases: Array<[Response, string | undefined]> = [
      [
        new Response('moved', {
          status: 302,
          headers: { location: 'https://cdn.test.invalid/other.png', 'content-type': 'image/png' },
        }),
        'redirect responses are never followed',
      ],
      [
        new Response(ONE_PIXEL_PNG, { headers: { 'content-type': 'image/jpeg' } }),
        'content type must match the requested output format',
      ],
      [new Response('nope', { status: 404 }), 'download failures stay outcome unknown'],
    ];
    for (const [downloadResponse] of cases) {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(providerResponse([{ url: 'https://cdn.test.invalid/output.png' }]))
        .mockResolvedValueOnce(downloadResponse);
      await expect(
        adapter(fetchImpl).execute(request(), snapshot(), context()),
      ).resolves.toMatchObject({
        kind: 'outcome_unknown',
        error_code: 'provider_response_invalid',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('classifies a URL body stream interruption as a download failure', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ONE_PIXEL_PNG);
        controller.error(new Error('connection reset while reading output'));
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(providerResponse([{ url: 'https://cdn.test.invalid/output.png' }]))
      .mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'image/png' } }));

    await expect(
      adapter(fetchImpl).execute(request(), snapshot(), context()),
    ).resolves.toMatchObject({
      kind: 'outcome_unknown',
      error_code: 'provider_response_invalid',
      diagnostic_code: 'output_url_download_failed',
    });
  });

  it('accepts a provider base64 response without making a second network request', async () => {
    const fetchImpl = providerFetch(
      providerResponse([{ b64_json: Buffer.from(ONE_PIXEL_PNG).toString('base64') }]),
    );

    const outcome = await adapter(fetchImpl).execute(request(), snapshot(), context());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      kind: 'succeeded',
      outputs: [{ metadata: { width: 1, height: 1, media_type: 'image/png' } }],
    });
  });

  it('rejects malformed URLs and base64, output-count drift, MIME drift and dimensions', async () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    const twoPixelPng = Buffer.from(ONE_PIXEL_PNG);
    twoPixelPng.writeUInt32BE(2, 16);
    const cases: unknown[] = [
      [{ url: 'data:image/png;base64,invalid' }],
      [{ url: 'not-a-url' }],
      [{ b64_json: 'not-base64' }],
      [],
      [
        { b64_json: ONE_PIXEL_PNG.toString('base64') },
        { b64_json: ONE_PIXEL_PNG.toString('base64') },
      ],
    ];

    for (const data of cases) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(providerResponse(data));
      await expect(
        adapter(fetchImpl).execute(request(), snapshot(), context()),
      ).resolves.toMatchObject({
        kind: 'outcome_unknown',
        error_code: 'provider_response_invalid',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }

    for (const bytes of [jpeg, twoPixelPng]) {
      const fetchImpl = providerFetch(providerResponse([{ b64_json: bytes.toString('base64') }]));
      await expect(
        adapter(fetchImpl).execute(request(), snapshot(), context()),
      ).resolves.toMatchObject({
        kind: 'outcome_unknown',
        error_code: 'provider_response_invalid',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds response and decoded output sizes before allocating unbounded image data', async () => {
    const oversizedHeader = providerResponse(undefined, {
      headers: { 'content-length': '10000' },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(oversizedHeader);
    await expect(
      adapter(fetchImpl, undefined, { maxResponseBytes: 100 }).execute(
        request(),
        snapshot(),
        context(),
      ),
    ).resolves.toMatchObject({ kind: 'outcome_unknown' });

    const outputFetch = vi.fn<typeof fetch>().mockResolvedValue(providerResponse());
    await expect(
      adapter(outputFetch, undefined, { maxOutputBytes: 16 }).execute(
        request(),
        snapshot(),
        context(),
      ),
    ).resolves.toMatchObject({ kind: 'outcome_unknown' });
  });

  it('does not retry redirects, HTTP failures or ambiguous transport failures', async () => {
    const redirect = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } }),
      );
    await expect(
      adapter(redirect).execute(request(), snapshot(), context()),
    ).resolves.toMatchObject({
      kind: 'failed',
      error_code: 'provider_unavailable',
    });
    expect(redirect).toHaveBeenCalledTimes(1);

    const rateLimited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 429 }));
    await expect(
      adapter(rateLimited).execute(request(), snapshot(), context()),
    ).resolves.toMatchObject({ kind: 'failed', error_code: 'provider_rate_limited' });
    expect(rateLimited).toHaveBeenCalledTimes(1);

    const reset = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection reset'));
    await expect(adapter(reset).execute(request(), snapshot(), context())).resolves.toMatchObject({
      kind: 'outcome_unknown',
      error_code: 'provider_unavailable',
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('records a pre-header transport failure without retrying or leaking the error message', async () => {
    const error = new TypeError('secret prompt and signed URL', {
      cause: Object.assign(new Error('private address'), { code: 'UND_ERR_SOCKET' }),
    });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(error);
    const outcome = await adapter(fetchImpl).execute(request(), snapshot(), context());
    expect(outcome).toMatchObject({
      kind: 'outcome_unknown',
      error_code: 'provider_unavailable',
      transport_diagnostic: {
        phase: 'response_headers',
        error_name: 'TypeError',
        network_code: 'UND_ERR_SOCKET',
        aborted: false,
        deadline_exceeded: false,
      },
    });
    expect(outcome).not.toHaveProperty('provider_request_id');
    expect(JSON.stringify(outcome)).not.toMatch(/secret|private address|signed URL/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retains response-header identity when the response body is interrupted', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error('secret'), { code: 'ECONNRESET' }));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: { 'x-request-id': 'relay-request-123', 'content-type': 'application/json' },
      }),
    );
    expect(await adapter(fetchImpl).execute(request(), snapshot(), context())).toMatchObject({
      kind: 'outcome_unknown',
      provider_request_id: 'relay-request-123',
      diagnostic_code: 'response_body_invalid',
      transport_diagnostic: {
        phase: 'response_body',
        network_code: 'ECONNRESET',
        http_status: 200,
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('diagnoses output download failures separately from the paid generation request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(providerResponse([{ url: 'https://cdn.test.invalid/output.png' }]))
      .mockRejectedValueOnce(
        new TypeError('private URL', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
      );
    expect(await adapter(fetchImpl).execute(request(), snapshot(), context())).toMatchObject({
      kind: 'outcome_unknown',
      diagnostic_code: 'output_url_download_failed',
      transport_diagnostic: { phase: 'output_headers', network_code: 'UND_ERR_CONNECT_TIMEOUT' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid task/model/spec bindings before any Provider dispatch', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      adapter(fetchImpl).execute(
        request('image.generate', { resolution_tier: '3k' }),
        snapshot(),
        context(),
      ),
    ).resolves.toMatchObject({ kind: 'not_dispatched' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
