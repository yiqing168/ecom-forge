import { createHash } from 'node:crypto';

import { addMoney, canonicalSha256 } from '@ecom-forge/shared';

import {
  VERCEL_AI_AGENT_ADAPTER_KEY,
  VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY,
} from '../agent-brain/vercel-ai-agent-brain.js';
import type { ProviderImageExecutionOutcome } from '../contracts.js';
import { mediaV2ModelSnapshotSchema, type MediaCapabilitySpec } from '../model-contracts.js';
import { buildOpenAiImageSpecBindings, OpenAiImagesAdapter } from './openai-images.adapter.js';

const EDIT_FIXTURE_ID = '00000000-0000-4000-8000-000000000101';
const EDIT_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQMAAADOtka5AAAAA1BMVEX3+//Nu490AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAANklEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8G4IAAAFjdVCkAAAAAElFTkSuQmCC',
  'base64',
);

type ImageSpec = Extract<MediaCapabilitySpec, { kind: 'image' }>;

export interface ImagePocResult {
  status: 'passed' | 'failed' | 'outcome_unknown';
  evidenceDigest: string;
  summary: Record<string, string>;
}

export interface ImagePocInput {
  runId: string;
  traceId: string;
  requestedSpecKeys: readonly string[];
  apiKey: string;
  model: {
    id: string;
    providerChannelId: string | null;
    provider: string;
    protocolFamily: string | null;
    apiVariant: string | null;
    modelId: string;
    version: string;
    status: 'poc_passed' | 'poc_failed' | 'disabled' | 'free_test_only';
    capabilityContractJson: unknown;
    pricingJson: unknown;
    quotaJson: unknown;
  };
  channel: {
    id: string;
    revision: number;
    provider: string;
    adapterKey: string;
    endpointProfileKey: string;
    baseUrl: string;
    region: string | null;
  };
  credentialVersionId: string;
}

export class ImagePocRunner {
  constructor(
    private readonly allowedRelayOrigins: readonly string[],
    private readonly allowedOutputOrigins: readonly string[],
    private readonly timeoutMs: number,
    private readonly maxImageBytes: number,
    private readonly maxImagePixels: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(input: ImagePocInput): Promise<ImagePocResult> {
    if (
      input.model.provider !== 'openai' ||
      input.model.protocolFamily !== 'openai' ||
      input.model.apiVariant !== 'openai_images' ||
      input.model.providerChannelId !== input.channel.id ||
      input.channel.provider !== 'openai' ||
      input.channel.adapterKey !== VERCEL_AI_AGENT_ADAPTER_KEY ||
      input.channel.endpointProfileKey !== VERCEL_AI_AGENT_ENDPOINT_PROFILE_KEY
    ) {
      return this.failed(input, 'MODEL_IMAGE_POC_BINDING_INVALID');
    }
    const snapshot = mediaV2ModelSnapshotSchema.safeParse({
      id: input.model.id,
      provider_channel_id: input.channel.id,
      provider: input.model.provider,
      model_id: input.model.modelId,
      version: input.model.version,
      status: input.model.status,
      capability_contract: input.model.capabilityContractJson,
      pricing: input.model.pricingJson,
      quota: input.model.quotaJson,
    });
    if (!snapshot.success || snapshot.data.capability_contract.media_kind !== 'image') {
      return this.failed(input, 'MODEL_IMAGE_POC_CONTRACT_INVALID');
    }
    const specs = snapshot.data.capability_contract.specs.filter(
      (spec): spec is ImageSpec =>
        spec.kind === 'image' &&
        (spec.operation === 'image.generate' || spec.operation === 'image.edit'),
    );
    const byKey = new Map(specs.map((spec) => [spec.spec_key, spec]));
    const requested = [...new Set(input.requestedSpecKeys)];
    if (
      requested.length === 0 ||
      requested.length !== input.requestedSpecKeys.length ||
      requested.some((specKey) => !byKey.has(specKey))
    ) {
      return this.failed(input, 'MODEL_IMAGE_POC_SPEC_SET_INVALID');
    }

    let bindings;
    try {
      bindings = buildOpenAiImageSpecBindings(specs, this.maxImagePixels);
    } catch {
      return this.failed(input, 'MODEL_IMAGE_POC_SPEC_MAPPING_INVALID');
    }
    const fixture = await this.loadEditFixture();
    const fixtureHash = createHash('sha256').update(fixture).digest('hex');
    const adapter = new OpenAiImagesAdapter(
      input.model.modelId,
      input.model.version,
      input.apiKey,
      input.channel.baseUrl,
      this.allowedRelayOrigins,
      this.allowedOutputOrigins,
      bindings,
      (assetId) => {
        if (assetId !== EDIT_FIXTURE_ID) {
          return Promise.reject(new Error('IMAGE_POC_FIXTURE_NOT_FOUND'));
        }
        return Promise.resolve({
          bytes: fixture,
          mediaType: 'image/png',
          filename: 'blue-mug.png',
          contentHash: fixtureHash,
        });
      },
      this.fetchImpl,
      {
        maxOutputBytes: this.maxImageBytes,
        maxReferenceBytes: this.maxImageBytes,
        maxTotalReferenceBytes: this.maxImageBytes,
        maxPixels: this.maxImagePixels,
      },
    );

    const evidence: Array<Record<string, string>> = [];
    let actualCost = '0.00';
    for (const specKey of requested) {
      const spec = byKey.get(specKey);
      if (!spec) return this.failed(input, 'MODEL_IMAGE_POC_SPEC_SET_INVALID');
      const binding = bindings.find(
        (candidate) =>
          candidate.specKey === spec.spec_key && candidate.aspectRatio === spec.aspect_ratios[0],
      );
      const outputFormat = spec.output_formats[0];
      if (!binding || !outputFormat) {
        return this.failed(input, 'MODEL_IMAGE_POC_SPEC_MAPPING_INVALID');
      }
      const operation = spec.operation as 'image.generate' | 'image.edit';
      const outcome = await adapter.execute(
        {
          capability: operation,
          input: {
            spec_key: spec.spec_key,
            prompt:
              operation === 'image.generate'
                ? 'A single blue ceramic mug centered on a clean white studio background.'
                : 'Keep the blue ceramic mug unchanged and refine it onto a clean white background.',
            aspect_ratio: binding.aspectRatio,
            resolution_tier: binding.resolutionTier,
            output_count: 1,
            output_format: outputFormat,
            reference_asset_ids: operation === 'image.edit' ? [EDIT_FIXTURE_ID] : [],
          },
        },
        snapshot.data,
        {
          idempotencyKey: canonicalSha256({ run_id: input.runId, spec_key: spec.spec_key }),
          requestDigest: canonicalSha256({ suite: 'model-poc@1', spec_key: spec.spec_key }),
          traceId: input.traceId,
          deadlineAt: new Date(Date.now() + this.timeoutMs),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (outcome.kind === 'outcome_unknown') {
        return this.outcomeUnknown(input, evidence, spec.spec_key, outcome);
      }
      if (outcome.kind !== 'succeeded') {
        return this.failed(input, 'MODEL_IMAGE_POC_PROVIDER_REJECTED', evidence, {
          attempted_spec_key: spec.spec_key,
          provider_error_code:
            outcome.kind === 'accepted' ? 'provider_async_accepted' : outcome.error_code,
        });
      }
      if (outcome.cost_summary) {
        actualCost = addMoney(actualCost, outcome.cost_summary.amount);
      }
      for (const output of outcome.outputs) {
        await output.consume((bytes) => {
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (digest !== output.metadata.content_hash) {
            return Promise.reject(new Error('MODEL_IMAGE_POC_OUTPUT_HASH_MISMATCH'));
          }
          return Promise.resolve();
        });
      }
      const output = outcome.outputs[0]?.metadata;
      if (!output) return this.failed(input, 'MODEL_IMAGE_POC_OUTPUT_MISSING', evidence);
      evidence.push({
        spec_key: spec.spec_key,
        operation,
        provider_request_id_hash: canonicalSha256({ id: outcome.provider_request_id }),
        output_hash: output.content_hash,
        media_type: output.media_type,
        dimensions: `${output.width}x${output.height}`,
        actual_cost_cny: outcome.cost_summary?.amount ?? 'unknown',
      });
    }

    const evidencePayload = {
      model_snapshot_id: input.model.id,
      provider_channel_id: input.channel.id,
      provider_channel_revision: input.channel.revision,
      credential_version_id: input.credentialVersionId,
      probe_suite_version: 'model-poc@1',
      requested_spec_keys: requested,
      results: evidence,
      provider_calls: evidence.length,
      actual_cost_cny: actualCost,
    };
    return {
      status: 'passed',
      evidenceDigest: canonicalSha256(evidencePayload),
      summary: {
        code: 'MODEL_IMAGE_POC_PASSED',
        category: 'image',
        spec_count: String(requested.length),
        provider_calls: String(evidence.length),
        actual_cost_cny: actualCost,
      },
    };
  }

  private failed(
    input: ImagePocInput,
    code: string,
    evidence: Array<Record<string, string>> = [],
    details: Record<string, string> = {},
  ): ImagePocResult {
    return {
      status: 'failed',
      evidenceDigest: canonicalSha256({ run_id: input.runId, code, evidence, details }),
      summary: { code, ...details },
    };
  }

  private outcomeUnknown(
    input: ImagePocInput,
    evidence: Array<Record<string, string>>,
    attemptedSpecKey: string,
    outcome: Extract<ProviderImageExecutionOutcome, { kind: 'outcome_unknown' }>,
  ): ImagePocResult {
    return {
      status: 'outcome_unknown',
      evidenceDigest: canonicalSha256({
        run_id: input.runId,
        result: 'outcome_unknown',
        completed_results: evidence,
        attempted_spec_key: attemptedSpecKey,
        provider_error_code: outcome.error_code,
        provider_diagnostic_code: outcome.diagnostic_code ?? 'not_available',
        provider_response_shape: outcome.diagnostic_details
          ? JSON.stringify(outcome.diagnostic_details)
          : 'not_available',
        provider_request_id_present: outcome.provider_request_id !== undefined,
        actual_cost_cny: outcome.cost_summary?.amount ?? 'unknown',
      }),
      summary: {
        code: 'MODEL_IMAGE_POC_OUTCOME_UNKNOWN',
        completed_spec_count: String(evidence.length),
        attempted_spec_key: attemptedSpecKey,
        provider_error_code: outcome.error_code,
        provider_diagnostic_code: outcome.diagnostic_code ?? 'not_available',
        provider_response_shape: outcome.diagnostic_details
          ? JSON.stringify(outcome.diagnostic_details)
          : 'not_available',
        actual_cost_cny: outcome.cost_summary?.amount ?? 'unknown',
      },
    };
  }

  private loadEditFixture(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.from(EDIT_FIXTURE));
  }
}
