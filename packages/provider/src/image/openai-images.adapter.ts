import { createHash } from 'node:crypto';

import { multiplyMoney } from '@ecom-forge/shared';
import { Decimal } from 'decimal.js';
import { z } from 'zod';

import {
  ProviderImageOutputLease,
  type ProviderCallContext,
  type ProviderErrorCode,
  type ProviderImageExecutionOutcome,
  type ProviderImageMediaType,
  type ProviderRequest,
} from '../contracts.js';
import {
  IMAGE_PROMPT_ABSOLUTE_MAX_CHARACTERS,
  mediaV2ModelSnapshotSchema,
  type MediaCapabilitySpec,
  type MediaV2ModelSnapshot,
} from '../model-contracts.js';
import {
  assertRelayApiBaseUrlAllowed,
  isOutputOriginAllowed,
  normalizeOutputOriginEntry,
  relayApiResourceUrl,
} from '../relay-policy.js';
import { OPENAI_IMAGES_RUNTIME_DEFAULTS } from './runtime-defaults.js';
import { imageTransportDiagnostic, type ImageTransportDiagnostic } from './transport-diagnostic.js';

const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const imageInputSchema = z.strictObject({
  spec_key: z.string().min(1).max(128),
  // The selected model spec remains the authoritative prompt admission limit.
  // This envelope only prevents an unbounded request when an old caller bypasses it.
  prompt: z.string().min(1).max(IMAGE_PROMPT_ABSOLUTE_MAX_CHARACTERS),
  aspect_ratio: z.string().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/),
  resolution_tier: z.enum(['1k', '2k', '4k']),
  output_count: z.int().positive().max(16),
  output_format: z.enum(['png', 'jpeg', 'webp']),
  reference_asset_ids: z.array(z.uuid()).max(16).default([]),
});

const responseItemSchema = z
  .object({
    url: z.string().min(1).max(2_048).optional(),
    b64_json: z
      .string()
      .min(1)
      .max(64 * 1024 * 1024)
      .refine(isValidBase64, 'Image output base64 payload is invalid')
      .optional(),
    revised_prompt: z.string().max(32_000).nullable().optional(),
  })
  .refine(
    (value) => (value.url !== undefined) !== (value.b64_json !== undefined),
    'Image output must contain exactly one URL or base64 payload',
  );

const responseSchema = z.object({
  id: z.string().min(1).max(256).optional(),
  created: z.number().int().nonnegative().optional(),
  data: z.array(responseItemSchema).min(1).max(16),
  background: z.string().max(32).optional(),
  output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
  quality: z.string().max(64).optional(),
  size: z.string().max(64).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export interface OpenAiImageSpecBinding {
  specKey: string;
  aspectRatio: string;
  resolutionTier: '1k' | '2k' | '4k';
  providerSize: string;
  width: number;
  height: number;
  outputFormats: readonly ('png' | 'jpeg' | 'webp')[];
}

export interface OpenAiReferenceImage {
  bytes: Uint8Array;
  mediaType: ProviderImageMediaType;
  filename: string;
  contentHash: string;
}

export type OpenAiReferenceImageResolver = (
  assetId: string,
  signal: AbortSignal,
) => Promise<OpenAiReferenceImage>;

export interface OpenAiImagesAdapterLimits {
  maxResponseBytes: number;
  maxOutputBytes: number;
  maxReferenceBytes: number;
  maxTotalReferenceBytes: number;
  maxPixels: number;
  maxOutputDownloadConcurrency: number;
}

const defaultLimits: OpenAiImagesAdapterLimits = {
  maxResponseBytes: 64 * 1024 * 1024,
  maxOutputBytes: 20 * 1024 * 1024,
  maxReferenceBytes: 20 * 1024 * 1024,
  maxTotalReferenceBytes: 80 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxOutputDownloadConcurrency: 2,
};

export const OPENAI_IMAGES_PROBE_SUITE_VERSION = 'model-poc@1' as const;

export function buildOpenAiImageSpecBindings(
  specs: readonly Extract<MediaCapabilitySpec, { kind: 'image' }>[],
  maxPixels = defaultLimits.maxPixels,
): OpenAiImageSpecBinding[] {
  const bindings: OpenAiImageSpecBinding[] = [];
  for (const spec of specs) {
    if (spec.operation !== 'image.generate' && spec.operation !== 'image.edit') continue;
    for (const aspectRatio of spec.aspect_ratios) {
      const { width, height } = resolveOpenAiImageDimensions(
        aspectRatio,
        spec.resolution_tier,
        maxPixels,
      );
      const binding = {
        specKey: spec.spec_key,
        aspectRatio,
        resolutionTier: spec.resolution_tier,
        providerSize: `${width}x${height}`,
        width,
        height,
        outputFormats: [...spec.output_formats],
      } satisfies OpenAiImageSpecBinding;
      assertBinding(binding, maxPixels);
      bindings.push(binding);
    }
  }
  if (bindings.length === 0) throw new Error('IMAGE_SPEC_BINDING_REQUIRED');
  return bindings;
}

export function resolveOpenAiImageDimensions(
  aspectRatio: string,
  resolutionTier: OpenAiImageSpecBinding['resolutionTier'],
  configuredMaxPixels = defaultLimits.maxPixels,
): { width: number; height: number } {
  if (!/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(aspectRatio)) {
    throw new Error('IMAGE_SPEC_ASPECT_RATIO_UNSUPPORTED');
  }
  const [rawWidth = 0, rawHeight = 0] = aspectRatio.split(':').map(Number);
  if (Math.max(rawWidth, rawHeight) / Math.min(rawWidth, rawHeight) > 3) {
    throw new Error('IMAGE_SPEC_ASPECT_RATIO_UNSUPPORTED');
  }
  let divisor = rawWidth;
  let remainder = rawHeight;
  while (remainder !== 0) {
    [divisor, remainder] = [remainder, divisor % remainder];
  }
  const ratioWidth = rawWidth / divisor;
  const ratioHeight = rawHeight / divisor;
  const { edgeStep, maxEdge, minPixels, pixelBudgets } = OPENAI_IMAGES_RUNTIME_DEFAULTS;
  const pixelBudget = pixelBudgets[resolutionTier];
  if (!Number.isSafeInteger(configuredMaxPixels) || configuredMaxPixels <= 0) {
    throw new Error('IMAGE_SPEC_PROVIDER_SIZE_UNAVAILABLE');
  }
  // Quantize one common scale so both dimensions retain the exact aspect ratio.
  const unit =
    Math.floor(Math.sqrt(pixelBudget / (ratioWidth * ratioHeight)) / edgeStep) * edgeStep;
  const width = ratioWidth * unit;
  const height = ratioHeight * unit;
  const pixels = width * height;
  if (
    !Number.isSafeInteger(unit) ||
    unit <= 0 ||
    width > maxEdge ||
    height > maxEdge ||
    pixels > pixelBudget ||
    pixels > configuredMaxPixels ||
    pixels < minPixels
  ) {
    throw new Error('IMAGE_SPEC_PROVIDER_SIZE_UNAVAILABLE');
  }
  return { width, height };
}

export class OpenAiImagesAdapter {
  readonly provider = 'openai' as const;
  readonly capabilities = ['image.generate', 'image.edit'] as const;

  private readonly baseUrl: string;
  private readonly allowedOutputOrigins: readonly string[];
  private readonly bindings = new Map<string, OpenAiImageSpecBinding>();
  private readonly limits: OpenAiImagesAdapterLimits;

  constructor(
    readonly modelId: string,
    readonly version: string,
    private readonly apiKey: string,
    baseUrl: string,
    allowedRelayOrigins: readonly string[],
    allowedOutputOrigins: readonly string[],
    bindings: readonly OpenAiImageSpecBinding[],
    private readonly resolveReferenceImage: OpenAiReferenceImageResolver,
    private readonly fetchImpl: typeof fetch = fetch,
    limits: Partial<OpenAiImagesAdapterLimits> = {},
  ) {
    if (!modelIdPattern.test(modelId) || version.length === 0 || version.length > 128) {
      throw new Error('IMAGE_MODEL_IDENTITY_INVALID');
    }
    if (apiKey.trim().length < 8) throw new Error('IMAGE_CREDENTIAL_INVALID');
    this.baseUrl = assertRelayApiBaseUrlAllowed(baseUrl, allowedRelayOrigins);
    this.allowedOutputOrigins = [...new Set(allowedOutputOrigins.map(normalizeOutputOriginEntry))];
    if (this.allowedOutputOrigins.length === 0) throw new Error('IMAGE_OUTPUT_ORIGIN_REQUIRED');
    this.limits = Object.freeze({ ...defaultLimits, ...limits });
    assertLimits(this.limits);
    for (const binding of bindings) {
      assertBinding(binding, this.limits.maxPixels);
      const key = bindingKey(binding.specKey, binding.aspectRatio, binding.resolutionTier);
      if (this.bindings.has(key)) throw new Error('IMAGE_SPEC_BINDING_DUPLICATE');
      this.bindings.set(
        key,
        Object.freeze({ ...binding, outputFormats: [...binding.outputFormats] }),
      );
    }
    if (this.bindings.size === 0) throw new Error('IMAGE_SPEC_BINDING_REQUIRED');
  }

  async execute(
    request: ProviderRequest,
    rawModel: unknown,
    context: ProviderCallContext,
  ): Promise<ProviderImageExecutionOutcome> {
    const model = mediaV2ModelSnapshotSchema.safeParse(rawModel);
    const input = imageInputSchema.safeParse(request.input);
    if (
      !model.success ||
      !input.success ||
      (request.capability !== 'image.generate' && request.capability !== 'image.edit') ||
      !this.isApproved(model.data, request.capability)
    ) {
      return notDispatched(context, 'provider_request_invalid');
    }
    const spec = findSpec(model.data, input.data.spec_key, request.capability);
    const binding = this.bindings.get(
      bindingKey(input.data.spec_key, input.data.aspect_ratio, input.data.resolution_tier),
    );
    if (!spec || !binding || !requestMatchesSpec(input.data, spec, binding)) {
      return notDispatched(context, 'provider_request_invalid');
    }
    if (
      (request.capability === 'image.generate' && input.data.reference_asset_ids.length !== 0) ||
      (request.capability === 'image.edit' && input.data.reference_asset_ids.length === 0)
    ) {
      return notDispatched(context, 'provider_request_invalid');
    }
    if (context.signal.aborted || context.deadlineAt.getTime() <= Date.now()) {
      return notDispatched(context, 'provider_timeout');
    }

    let costSummary: Extract<ProviderImageExecutionOutcome, { kind: 'succeeded' }>['cost_summary'];
    try {
      costSummary = calculateImageCost(model.data, spec, binding, input.data.output_count);
    } catch {
      return notDispatched(context, 'provider_request_invalid');
    }
    let init: RequestInit;
    try {
      init =
        request.capability === 'image.generate'
          ? this.generationRequest(input.data, binding, context)
          : await this.editRequest(input.data, binding, context);
    } catch {
      return notDispatched(context, 'provider_request_invalid');
    }
    if (context.signal.aborted || context.deadlineAt.getTime() <= Date.now()) {
      return notDispatched(context, 'provider_timeout');
    }

    const acceptedAt = new Date();
    let response: Response;
    try {
      response = await this.fetchImpl(
        relayApiResourceUrl(
          this.baseUrl,
          `images/${request.capability === 'image.generate' ? 'generations' : 'edits'}`,
        ),
        init,
      );
    } catch (error) {
      return {
        ...unknown(
          context,
          Date.now() >= context.deadlineAt.getTime() ? 'provider_timeout' : 'provider_unavailable',
        ),
        transport_diagnostic: imageTransportDiagnostic(error, {
          phase: 'response_headers',
          startedAt: acceptedAt.getTime(),
          requestStartedAt: acceptedAt.getTime(),
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        }),
      };
    }
    const providerRequestId = requestId(response);
    const receipt = { status_code_family: statusFamily(response.status) } as const;
    if (!response.ok) {
      return {
        kind: 'failed',
        ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
        error_code: statusError(response.status),
        receipt_summary: receipt,
        failed_at: new Date(),
      };
    }

    let rawBody: unknown;
    const bodyStartedAt = Date.now();
    try {
      rawBody = await readBoundedJson(response, this.limits.maxResponseBytes);
    } catch (error) {
      return {
        ...unknown(
          context,
          'provider_response_invalid',
          providerRequestId,
          costSummary,
          'response_body_invalid',
          safeResponseShape(response, undefined),
        ),
        transport_diagnostic: imageTransportDiagnostic(error, {
          phase: 'response_body',
          startedAt: bodyStartedAt,
          requestStartedAt: acceptedAt.getTime(),
          signal: context.signal,
          deadlineAt: context.deadlineAt,
          httpStatus: response.status,
        }),
      };
    }
    const parsedBody = responseSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return unknown(
        context,
        'provider_response_invalid',
        providerRequestId,
        costSummary,
        'response_schema_invalid',
        safeResponseShape(response, rawBody),
      );
    }
    const body = parsedBody.data;
    if (body.data.length !== input.data.output_count) {
      return unknown(
        context,
        'provider_response_invalid',
        providerRequestId ?? body.id,
        costSummary,
        'response_identity_or_count_invalid',
      );
    }
    const resolvedRequestId =
      providerRequestId ??
      body.id ??
      derivedSynchronousReceiptId(
        context.requestDigest,
        body.data.map((item) => {
          const result: { b64_json?: string; url?: string } = {};
          if (item.url !== undefined) result.url = item.url;
          if (item.b64_json !== undefined) result.b64_json = item.b64_json;
          return result;
        }),
      );
    if (body.output_format && body.output_format !== input.data.output_format) {
      return unknown(
        context,
        'provider_response_invalid',
        resolvedRequestId,
        costSummary,
        'response_metadata_mismatch',
      );
    }

    try {
      const outputs = await mapWithConcurrency(
        body.data,
        this.limits.maxOutputDownloadConcurrency,
        async (item, index) => {
          const expectedMediaType = outputMediaType(input.data.output_format);
          const bytes = await resolveOutputBytes(
            item,
            this.fetchImpl,
            context,
            this.limits.maxOutputBytes,
            expectedMediaType,
            this.allowedOutputOrigins,
            acceptedAt.getTime(),
          );
          const inspected = inspectImage(bytes);
          if (
            !inspected ||
            inspected.mediaType !== expectedMediaType ||
            !dimensionsCompatible(inspected, binding) ||
            inspected.width * inspected.height > this.limits.maxPixels
          ) {
            throw new Error('IMAGE_OUTPUT_INVALID');
          }
          const contentHash = createHash('sha256').update(bytes).digest('hex');
          return new ProviderImageOutputLease(
            {
              provider_output_id: `${resolvedRequestId}:${index}`,
              media_type: inspected.mediaType,
              byte_length: bytes.byteLength,
              width: inspected.width,
              height: inspected.height,
              content_hash: contentHash,
            },
            bytes,
          );
        },
      );
      return {
        kind: 'succeeded',
        provider_request_id: resolvedRequestId,
        receipt_summary: receipt,
        accepted_at: acceptedAt,
        completed_at: new Date(),
        outputs,
        ...(costSummary ? { cost_summary: costSummary } : {}),
      };
    } catch (error) {
      const diagnosticCode = diagnosticCodeForOutputError(error);
      return {
        ...unknown(
          context,
          'provider_response_invalid',
          resolvedRequestId,
          costSummary,
          diagnosticCode,
        ),
        ...(error instanceof ImageOutputDownloadError
          ? { transport_diagnostic: error.diagnostic }
          : {}),
      };
    }
  }

  private generationRequest(
    input: z.infer<typeof imageInputSchema>,
    binding: OpenAiImageSpecBinding,
    context: ProviderCallContext,
  ): RequestInit {
    return {
      method: 'POST',
      redirect: 'manual',
      signal: context.signal,
      headers: requestHeaders(this.apiKey, context, true),
      body: JSON.stringify({
        model: this.modelId,
        prompt: input.prompt,
        n: input.output_count,
        background: 'auto',
        quality: OPENAI_IMAGES_RUNTIME_DEFAULTS.quality,
        size: binding.providerSize,
        response_format: 'url',
      }),
    };
  }

  private async editRequest(
    input: z.infer<typeof imageInputSchema>,
    binding: OpenAiImageSpecBinding,
    context: ProviderCallContext,
  ): Promise<RequestInit> {
    const form = new FormData();
    form.set('model', this.modelId);
    form.set('prompt', input.prompt);
    form.set('n', String(input.output_count));
    form.set('background', 'auto');
    form.set('quality', OPENAI_IMAGES_RUNTIME_DEFAULTS.quality);
    form.set('size', binding.providerSize);
    form.set('response_format', 'url');
    let totalBytes = 0;
    for (const assetId of input.reference_asset_ids) {
      const source = await this.resolveReferenceImage(assetId, context.signal);
      const inspected = inspectImage(source.bytes);
      totalBytes += source.bytes.byteLength;
      if (
        source.bytes.byteLength === 0 ||
        source.bytes.byteLength > this.limits.maxReferenceBytes ||
        totalBytes > this.limits.maxTotalReferenceBytes ||
        !inspected ||
        inspected.mediaType !== source.mediaType ||
        !sha256Pattern.test(source.contentHash) ||
        createHash('sha256').update(source.bytes).digest('hex') !== source.contentHash ||
        !safeFilename(source.filename)
      ) {
        throw new Error('IMAGE_REFERENCE_INVALID');
      }
      form.append(
        input.reference_asset_ids.length === 1 ? 'image' : 'image[]',
        new Blob([Uint8Array.from(source.bytes)], { type: source.mediaType }),
        source.filename,
      );
    }
    return {
      method: 'POST',
      redirect: 'manual',
      signal: context.signal,
      headers: requestHeaders(this.apiKey, context, false),
      body: form,
    };
  }

  private isApproved(
    model: MediaV2ModelSnapshot,
    capability: 'image.generate' | 'image.edit',
  ): boolean {
    return (
      model.provider === this.provider &&
      model.model_id === this.modelId &&
      model.version === this.version &&
      model.capability_contract.media_kind === 'image' &&
      model.capability_contract.capabilities.includes(capability) &&
      (model.status === 'poc_passed' || model.status === 'free_test_only')
    );
  }
}

function requestHeaders(
  apiKey: string,
  context: ProviderCallContext,
  json: boolean,
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'idempotency-key': context.idempotencyKey,
    'x-client-request-id': context.traceId,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

function bindingKey(specKey: string, aspectRatio: string, resolutionTier: string): string {
  return `${specKey}\u0000${aspectRatio}\u0000${resolutionTier}`;
}

function assertBinding(binding: OpenAiImageSpecBinding, maxPixels: number): void {
  if (
    !binding.specKey ||
    !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(binding.aspectRatio) ||
    !/^[A-Za-z0-9][A-Za-z0-9._x:-]{0,63}$/.test(binding.providerSize) ||
    !Number.isInteger(binding.width) ||
    !Number.isInteger(binding.height) ||
    binding.width <= 0 ||
    binding.height <= 0 ||
    binding.width * binding.height > maxPixels ||
    binding.outputFormats.length === 0 ||
    new Set(binding.outputFormats).size !== binding.outputFormats.length
  ) {
    throw new Error('IMAGE_SPEC_BINDING_INVALID');
  }
}

function assertLimits(limits: OpenAiImagesAdapterLimits): void {
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.maxReferenceBytes > limits.maxTotalReferenceBytes ||
    limits.maxOutputDownloadConcurrency > 16
  ) {
    throw new Error('IMAGE_ADAPTER_LIMITS_INVALID');
  }
}

function findSpec(
  model: MediaV2ModelSnapshot,
  specKey: string,
  capability: 'image.generate' | 'image.edit',
): Extract<MediaCapabilitySpec, { kind: 'image' }> | undefined {
  return model.capability_contract.specs.find(
    (spec): spec is Extract<MediaCapabilitySpec, { kind: 'image' }> =>
      spec.kind === 'image' && spec.spec_key === specKey && spec.operation === capability,
  );
}

function requestMatchesSpec(
  input: z.infer<typeof imageInputSchema>,
  spec: Extract<MediaCapabilitySpec, { kind: 'image' }>,
  binding: OpenAiImageSpecBinding,
): boolean {
  return (
    spec.resolution_tier === input.resolution_tier &&
    spec.aspect_ratios.includes(input.aspect_ratio) &&
    spec.max_outputs >= input.output_count &&
    spec.max_reference_images >= input.reference_asset_ids.length &&
    spec.output_formats.includes(input.output_format) &&
    binding.outputFormats.includes(input.output_format)
  );
}

function calculateImageCost(
  model: MediaV2ModelSnapshot,
  spec: Extract<MediaCapabilitySpec, { kind: 'image' }>,
  binding: OpenAiImageSpecBinding,
  outputCount: number,
): Extract<ProviderImageExecutionOutcome, { kind: 'succeeded' }>['cost_summary'] {
  const rate = model.pricing.rate_cards.find((candidate) => candidate.spec_key === spec.spec_key);
  if (!rate || (rate.billing_unit !== 'image' && rate.billing_unit !== 'megapixel')) {
    throw new Error('IMAGE_RATE_CARD_INVALID');
  }
  let units = new Decimal(outputCount);
  if (rate.billing_unit === 'megapixel') {
    const raw = new Decimal(binding.width)
      .times(binding.height)
      .dividedBy(1_000_000)
      .times(outputCount);
    const minimum = new Decimal(rate.min_megapixels);
    const maximum = new Decimal(rate.max_megapixels);
    const step = new Decimal(rate.step_megapixels);
    if (raw.greaterThan(maximum)) throw new Error('IMAGE_RATE_CARD_LIMIT_EXCEEDED');
    units = raw.lessThan(minimum)
      ? minimum
      : minimum.plus(raw.minus(minimum).dividedBy(step).ceil().times(step));
    if (units.greaterThan(maximum)) throw new Error('IMAGE_RATE_CARD_LIMIT_EXCEEDED');
  }
  if (rate.unit_cost_cny === null) return undefined;
  return {
    currency: 'CNY',
    amount: multiplyMoney(rate.unit_cost_cny, units.toString()),
    provider_units: units.toString(),
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBytes(response, maxBytes)),
  );
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new Error('IMAGE_RESPONSE_TOO_LARGE');
  }
  if (!response.body) throw new Error('IMAGE_RESPONSE_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('IMAGE_RESPONSE_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function inspectImage(
  bytes: Uint8Array,
): { mediaType: ProviderImageMediaType; width: number; height: number } | null {
  if (
    bytes.byteLength >= 24 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    ) &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
  ) {
    return {
      mediaType: 'image/png',
      width: readUint32(bytes, 16),
      height: readUint32(bytes, 20),
    };
  }
  if (bytes.byteLength >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
      if (length < 2 || offset + length > bytes.byteLength) return null;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return {
          mediaType: 'image/jpeg',
          height: ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0),
          width: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        };
      }
      offset += length;
    }
    return null;
  }
  if (
    bytes.byteLength >= 30 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === 'VP8X') {
      return {
        mediaType: 'image/webp',
        width: 1 + readUint24LittleEndian(bytes, 24),
        height: 1 + readUint24LittleEndian(bytes, 27),
      };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      return {
        mediaType: 'image/webp',
        width: 1 + (((bytes[22] ?? 0) & 0x3f) << 8) + (bytes[21] ?? 0),
        height:
          1 +
          (((bytes[24] ?? 0) & 0x0f) << 10) +
          ((bytes[23] ?? 0) << 2) +
          (((bytes[22] ?? 0) & 0xc0) >> 6),
      };
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        mediaType: 'image/webp',
        width: (((bytes[27] ?? 0) << 8) | (bytes[26] ?? 0)) & 0x3fff,
        height: (((bytes[29] ?? 0) << 8) | (bytes[28] ?? 0)) & 0x3fff,
      };
    }
  }
  return null;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8) + ((bytes[offset + 2] ?? 0) << 16);
}

function outputMediaType(format: 'png' | 'jpeg' | 'webp'): ProviderImageMediaType {
  return format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
}

function safeFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  );
}

function requestId(response: Response): string | undefined {
  const value = response.headers.get('x-request-id')?.trim();
  return value && value.length <= 256 ? value : undefined;
}

type ImageResponseItem = z.infer<typeof responseItemSchema>;

class ImageOutputDownloadError extends Error {
  constructor(readonly diagnostic: ImageTransportDiagnostic) {
    super('IMAGE_OUTPUT_URL_DOWNLOAD_FAILED');
  }
}

async function resolveOutputBytes(
  item: ImageResponseItem,
  fetchImpl: typeof fetch,
  context: ProviderCallContext,
  maxOutputBytes: number,
  expectedMediaType: ProviderImageMediaType,
  allowedOutputOrigins: readonly string[],
  requestStartedAt: number,
): Promise<Uint8Array> {
  if (item.b64_json !== undefined) {
    return decodeBase64Output(item.b64_json, maxOutputBytes);
  }
  if (item.url === undefined) {
    throw new Error('IMAGE_OUTPUT_URL_INVALID');
  }

  let outputUrl: URL;
  try {
    outputUrl = new URL(item.url);
  } catch {
    throw new Error('IMAGE_OUTPUT_URL_INVALID');
  }
  if (outputUrl.protocol !== 'https:' || outputUrl.username || outputUrl.password) {
    throw new Error('IMAGE_OUTPUT_URL_INVALID');
  }
  if (!isOutputOriginAllowed(outputUrl, allowedOutputOrigins)) {
    throw new Error('IMAGE_OUTPUT_URL_INVALID');
  }

  let response: Response;
  let phase: ImageTransportDiagnostic['phase'] = 'output_headers';
  let startedAt = Date.now();
  const downloadError = (error: unknown, httpStatus?: number) =>
    new ImageOutputDownloadError(
      imageTransportDiagnostic(error, {
        phase,
        startedAt,
        requestStartedAt,
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      }),
    );
  try {
    response = await fetchImpl(outputUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: context.signal,
      headers: { accept: expectedMediaType },
    });
  } catch (error) {
    throw downloadError(error);
  }
  if (!response.ok) {
    throw downloadError(undefined, response.status);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
  if (contentType !== expectedMediaType) {
    throw new Error('IMAGE_OUTPUT_URL_INVALID');
  }
  let bytes: Uint8Array;
  phase = 'output_body';
  startedAt = Date.now();
  try {
    bytes = await readBoundedBytes(response, maxOutputBytes);
  } catch (error) {
    // A response can be HTTP-valid and still fail while its body is streaming. Keep
    // transport interruption separate from payload validation for operational diagnosis.
    if (isInvalidBoundedResponseError(error)) throw new Error('IMAGE_OUTPUT_URL_INVALID');
    throw downloadError(error, response.status);
  }
  if (context.signal.aborted || context.deadlineAt.getTime() <= Date.now()) {
    throw downloadError(undefined, response.status);
  }
  return bytes;
}

function isInvalidBoundedResponseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'IMAGE_RESPONSE_TOO_LARGE' ||
      error.message === 'IMAGE_RESPONSE_BODY_MISSING')
  );
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  project: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await project(values[index] as T, index);
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error('IMAGE_REFERENCE_BATCH_FAILED');
  }
  return results;
}

function diagnosticCodeForOutputError(
  error: unknown,
): Extract<ProviderImageExecutionOutcome, { kind: 'outcome_unknown' }>['diagnostic_code'] {
  if (error instanceof Error && error.message === 'IMAGE_OUTPUT_INVALID') {
    return 'output_media_or_dimensions_invalid';
  }
  if (error instanceof Error && error.message === 'IMAGE_OUTPUT_BASE64_INVALID') {
    return 'output_base64_invalid';
  }
  if (error instanceof Error && error.message === 'IMAGE_OUTPUT_URL_INVALID') {
    return 'output_url_invalid';
  }
  if (error instanceof Error && error.message === 'IMAGE_OUTPUT_URL_DOWNLOAD_FAILED') {
    return 'output_url_download_failed';
  }
  return 'output_decode_invalid';
}

function derivedSynchronousReceiptId(
  requestDigest: string,
  data: readonly { b64_json?: string; url?: string }[],
): string {
  const digest = createHash('sha256').update(requestDigest);
  for (const item of data) {
    digest.update('\0').update(item.url ?? item.b64_json ?? '');
  }
  return `sync-${digest.digest('hex')}`;
}

function statusFamily(status: number): '2xx' | '3xx' | '4xx' | '5xx' {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}

function statusError(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'provider_auth_failed';
  if (status === 429) return 'provider_rate_limited';
  if (status === 402) return 'provider_quota_exhausted';
  if (status === 408 || status === 504) return 'provider_timeout';
  if (status >= 400 && status < 500) return 'provider_request_invalid';
  return 'provider_unavailable';
}

function notDispatched(
  context: ProviderCallContext,
  errorCode: ProviderErrorCode,
): ProviderImageExecutionOutcome {
  return {
    kind: 'not_dispatched',
    error_code: errorCode,
    retryable: false,
    request_digest: context.requestDigest,
  };
}

function unknown(
  context: ProviderCallContext,
  errorCode: ProviderErrorCode,
  providerRequestId?: string,
  costSummary?: Extract<ProviderImageExecutionOutcome, { kind: 'succeeded' }>['cost_summary'],
  diagnosticCode?: Extract<
    ProviderImageExecutionOutcome,
    { kind: 'outcome_unknown' }
  >['diagnostic_code'],
  diagnosticDetails?: Extract<
    ProviderImageExecutionOutcome,
    { kind: 'outcome_unknown' }
  >['diagnostic_details'],
): Extract<ProviderImageExecutionOutcome, { kind: 'outcome_unknown' }> {
  return {
    kind: 'outcome_unknown',
    ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
    error_code: errorCode,
    request_digest: context.requestDigest,
    unknown_at: new Date(),
    ...(costSummary ? { cost_summary: costSummary } : {}),
    ...(diagnosticCode ? { diagnostic_code: diagnosticCode } : {}),
    ...(diagnosticDetails ? { diagnostic_details: diagnosticDetails } : {}),
  };
}

function safeResponseShape(
  response: Response,
  value: unknown,
): NonNullable<
  Extract<ProviderImageExecutionOutcome, { kind: 'outcome_unknown' }>['diagnostic_details']
> {
  const record = isRecord(value) ? value : undefined;
  const data = Array.isArray(record?.data) ? record.data : [];
  const first = isRecord(data[0]) ? data[0] : undefined;
  return {
    content_type: (response.headers.get('content-type') ?? 'missing').slice(0, 64),
    body_kind: Array.isArray(value)
      ? 'array'
      : value === null
        ? 'null'
        : typeof value === 'object'
          ? 'object'
          : 'primitive',
    has_id: typeof record?.id === 'string',
    has_data: Array.isArray(record?.data),
    data_count: data.length,
    first_item_has_url: typeof first?.url === 'string',
    first_item_has_b64_json: typeof first?.b64_json === 'string',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength > 0 && bytes.toString('base64') === value;
}

function decodeBase64Output(value: string, maxBytes: number): Uint8Array {
  if (!isValidBase64(value)) throw new Error('IMAGE_OUTPUT_BASE64_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > maxBytes) throw new Error('IMAGE_OUTPUT_BASE64_INVALID');
  return Uint8Array.from(bytes);
}

function dimensionsCompatible(
  actual: { width: number; height: number },
  expected: { width: number; height: number },
): boolean {
  const widthScale = actual.width / expected.width;
  const heightScale = actual.height / expected.height;
  const actualRatio = actual.width / actual.height;
  const expectedRatio = expected.width / expected.height;
  return (
    widthScale >= 0.98 &&
    widthScale <= 1.5 &&
    heightScale >= 0.98 &&
    heightScale <= 1.5 &&
    Math.abs(actualRatio / expectedRatio - 1) <= 0.02
  );
}
