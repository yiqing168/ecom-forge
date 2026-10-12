import {
  modelSnapshotSchema,
  moderationOutcomeSchema,
  providerPollOutcomeSchema,
  providerSubmitOutcomeSchema,
  type GatewayMode,
  type ModelSnapshot,
  type ModerationOutcome,
  type ProviderErrorCode,
  type ProviderAdapter,
  type ProviderCallContext,
  type ProviderRequest,
  type ProviderPollInput,
  type ProviderPollOutcome,
  type ProviderSubmitOutcome,
  type ProviderWebhookHeaders,
  type ProviderWebhookContext,
  type VerifiedProviderCallback,
} from './contracts.js';
import { z } from 'zod';

import { IMAGE_PROMPT_ABSOLUTE_MAX_CHARACTERS } from './model-contracts.js';

export interface CircuitGate {
  assertCanSubmit(model: ModelSnapshot): Promise<CircuitPermit | void>;
  recordOutcome?(
    model: ModelSnapshot,
    outcome: ProviderSubmitOutcome,
    permit: CircuitPermit | void,
  ): Promise<void>;
  recordModerationOutcome?(
    model: ModelSnapshot,
    outcome: ModerationOutcome,
    permit: CircuitPermit | void,
  ): Promise<void>;
}

export interface CircuitPermit {
  probeToken?: string;
}

export interface QuotaGate {
  reserve(
    model: ModelSnapshot,
    context: Pick<ProviderCallContext, 'deadlineAt'>,
  ): Promise<QuotaPermit | void>;
  release?(model: ModelSnapshot, permit: QuotaPermit | void): Promise<void>;
}

export interface QuotaPermit {
  concurrencyKey?: string;
  concurrencyToken?: string;
}

export interface ProviderGatewayOptions {
  mode: GatewayMode;
  circuitGate: CircuitGate;
  quotaGate: QuotaGate;
  now?: () => Date;
  telemetry?: ProviderGatewayTelemetry;
}

export interface ProviderGatewayTelemetry {
  info(event: Record<string, unknown>): void;
}

const NOOP_GATEWAY_TELEMETRY: ProviderGatewayTelemetry = { info: () => undefined };

interface DeadlineExecution<T> {
  outcome: T;
  transport: Promise<T>;
  timedOut: boolean;
}

async function executeUntilDeadline<T>(input: {
  context: ProviderCallContext;
  remainingMs: number;
  execute(context: ProviderCallContext): Promise<T>;
  onError(error: unknown): T;
  onTimeout(): T;
}): Promise<DeadlineExecution<T>> {
  const deadlineController = new AbortController();
  const transportContext: ProviderCallContext = {
    ...input.context,
    signal: AbortSignal.any([input.context.signal, deadlineController.signal]),
  };
  const transport = Promise.resolve()
    .then(() => input.execute(transportContext))
    .catch((error: unknown) => input.onError(error));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ source: 'timeout'; outcome: T }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ source: 'timeout', outcome: input.onTimeout() });
      deadlineController.abort(new Error('Provider call deadline exceeded'));
    }, input.remainingMs);
  });

  try {
    const winner = await Promise.race([
      transport.then((outcome) => ({ source: 'transport' as const, outcome })),
      timeout,
    ]);
    return {
      outcome: winner.outcome,
      transport,
      timedOut: winner.source === 'timeout',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ProviderGatewayError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_ADAPTER_NOT_FOUND'
      | 'PROVIDER_CAPABILITY_UNSUPPORTED'
      | 'PROVIDER_MODEL_NOT_APPROVED'
      | 'PROVIDER_TEST_ADAPTER_REQUIRED'
      | 'PROVIDER_INPUT_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderGatewayError';
  }
}

export class ProviderOutcomeRecordingError extends Error {
  constructor(
    readonly outcome: ProviderSubmitOutcome,
    cause: unknown,
  ) {
    super('Provider outcome was received but circuit evidence could not be recorded', { cause });
    this.name = 'ProviderOutcomeRecordingError';
  }
}

export class ProviderModerationRecordingError extends Error {
  constructor(
    readonly outcome: ModerationOutcome,
    cause: unknown,
  ) {
    super('Provider moderation outcome could not be recorded as circuit evidence', { cause });
    this.name = 'ProviderModerationRecordingError';
  }
}

const imageGenerateInputSchema = z.strictObject({
  // v1 snapshots have no model-specific prompt field. Keep only the transport
  // absolute guard here; v2 image dispatch validates against the selected spec.
  prompt: z.string().min(1).max(IMAGE_PROMPT_ABSOLUTE_MAX_CHARACTERS),
  aspect_ratio: z.string().min(1).max(32),
  resolution: z.string().min(1).max(32),
  output_count: z.int().positive().max(16),
});

const imageEditInputSchema = imageGenerateInputSchema.extend({
  reference_asset_ids: z.array(z.uuid()).min(1).max(16),
});

const moderationTextInputSchema = z.strictObject({ text: z.string().min(1).max(16_000) });
const moderationImageInputSchema = z.strictObject({ asset_id: z.uuid() });

function normalizedRequest(request: ProviderRequest, model: ModelSnapshot): ProviderRequest {
  const parsed = (() => {
    switch (request.capability) {
      case 'image.generate':
        return imageGenerateInputSchema.safeParse(request.input);
      case 'image.edit':
        return imageEditInputSchema.safeParse(request.input);
      case 'moderation.text':
        return moderationTextInputSchema.safeParse(request.input);
      case 'moderation.image':
        return moderationImageInputSchema.safeParse(request.input);
    }
  })();
  if (!parsed.success) {
    throw new ProviderGatewayError(
      'PROVIDER_INPUT_INVALID',
      'Provider input does not match the capability contract',
    );
  }
  if ('aspect_ratio' in parsed.data) {
    if (
      !model.capability_contract.aspect_ratios.includes(parsed.data.aspect_ratio) ||
      !model.capability_contract.resolutions.includes(parsed.data.resolution) ||
      parsed.data.output_count > model.capability_contract.max_outputs
    ) {
      throw new ProviderGatewayError(
        'PROVIDER_INPUT_INVALID',
        'Provider image parameters exceed the model capability contract',
      );
    }
  }
  if (request.capability === 'image.edit') {
    const editInput = imageEditInputSchema.parse(parsed.data);
    if (editInput.reference_asset_ids.length > model.capability_contract.max_reference_images) {
      throw new ProviderGatewayError(
        'PROVIDER_INPUT_INVALID',
        'Provider reference count exceeds the model capability contract',
      );
    }
  }
  return { capability: request.capability, input: parsed.data };
}

function adapterKey(provider: string, modelId: string, version: string): string {
  return `${provider}\u0000${modelId}\u0000${version}`;
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: readonly ProviderAdapter[]) {
    for (const adapter of adapters) {
      const key = adapterKey(adapter.provider, adapter.modelId, adapter.version);
      if (this.adapters.has(key)) throw new Error('Duplicate Provider adapter registration');
      this.adapters.set(key, adapter);
    }
  }

  get(model: ModelSnapshot): ProviderAdapter {
    const adapter = this.adapters.get(adapterKey(model.provider, model.model_id, model.version));
    if (!adapter) {
      throw new ProviderGatewayError(
        'PROVIDER_ADAPTER_NOT_FOUND',
        'No adapter is registered for the exact Provider model version',
      );
    }
    return adapter;
  }
}

export class ProviderWebhookRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: readonly ProviderAdapter[]) {
    for (const adapter of adapters) {
      if (!adapter.verifyWebhook) continue;
      if (this.adapters.has(adapter.provider)) {
        throw new Error('Duplicate Provider webhook adapter registration');
      }
      this.adapters.set(adapter.provider, adapter);
    }
  }

  has(provider: string): boolean {
    return this.adapters.has(provider);
  }

  verify(
    provider: string,
    rawBody: Buffer,
    headers: ProviderWebhookHeaders,
    context: ProviderWebhookContext,
  ): Promise<VerifiedProviderCallback> {
    const adapter = this.adapters.get(provider);
    if (!adapter?.verifyWebhook) {
      throw new ProviderGatewayError(
        'PROVIDER_ADAPTER_NOT_FOUND',
        'No webhook adapter is registered for this Provider',
      );
    }
    return adapter.verifyWebhook(rawBody, headers, context);
  }
}

function assertModelAllowed(model: ModelSnapshot, mode: GatewayMode): void {
  if (mode === 'workflow' && model.status !== 'poc_passed') {
    throw new ProviderGatewayError(
      'PROVIDER_MODEL_NOT_APPROVED',
      'Workflow routing requires a PoC-approved model',
    );
  }
  if (mode !== 'workflow' && !['free_test_only', 'poc_passed'].includes(model.status)) {
    throw new ProviderGatewayError(
      'PROVIDER_MODEL_NOT_APPROVED',
      'The Provider model is not available for controlled execution',
    );
  }
  if (mode === 'test' && model.provider !== 'fake') {
    throw new ProviderGatewayError(
      'PROVIDER_TEST_ADAPTER_REQUIRED',
      'Tests may only use the fake Provider adapter',
    );
  }
}

export class ProviderGateway {
  private readonly now: () => Date;
  private readonly telemetry: ProviderGatewayTelemetry;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly options: ProviderGatewayOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.telemetry = options.telemetry ?? NOOP_GATEWAY_TELEMETRY;
  }

  async submit(
    rawModel: unknown,
    request: ProviderRequest,
    context: ProviderCallContext,
  ): Promise<ProviderSubmitOutcome> {
    const model = modelSnapshotSchema.parse(rawModel);
    assertModelAllowed(model, this.options.mode);
    if (request.capability === 'moderation.text' || request.capability === 'moderation.image') {
      throw new ProviderGatewayError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'Moderation capabilities must use the dedicated Gateway method',
      );
    }
    if (!model.capability_contract.capabilities.includes(request.capability)) {
      throw new ProviderGatewayError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'The model snapshot does not permit this capability',
      );
    }
    const adapter = this.registry.get(model);
    if (!adapter.capabilities.includes(request.capability)) {
      throw new ProviderGatewayError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'The adapter does not implement this capability',
      );
    }
    const validatedRequest = normalizedRequest(request, model);

    const quotaPermit = await this.options.quotaGate.reserve(model, context);
    let releaseAfterTransport: Promise<unknown> | undefined;
    try {
      const circuitPermit = await this.options.circuitGate.assertCanSubmit(model);
      const remainingMs = context.deadlineAt.getTime() - this.now().getTime();
      if (remainingMs <= 0) {
        const outcome = this.unknownOutcome(context, 'provider_timeout');
        try {
          await this.options.circuitGate.recordOutcome?.(model, outcome, circuitPermit);
        } catch (error) {
          throw new ProviderOutcomeRecordingError(outcome, error);
        }
        return outcome;
      }

      const execution = await executeUntilDeadline({
        context,
        remainingMs,
        execute: (transportContext) => adapter.submit(validatedRequest, model, transportContext),
        onError: () => this.unknownOutcome(context, 'provider_internal_error'),
        onTimeout: () => this.unknownOutcome(context, 'provider_timeout'),
      });
      if (execution.timedOut) releaseAfterTransport = execution.transport;
      const parsed = providerSubmitOutcomeSchema.safeParse(execution.outcome);
      const normalized = parsed.success
        ? parsed.data
        : this.unknownOutcome(context, 'provider_response_invalid');
      try {
        await this.options.circuitGate.recordOutcome?.(model, normalized, circuitPermit);
      } catch (error) {
        throw new ProviderOutcomeRecordingError(normalized, error);
      }
      return normalized;
    } finally {
      if (releaseAfterTransport) {
        void releaseAfterTransport
          .then(() => this.releaseQuota(model, quotaPermit))
          .catch(() => undefined);
      } else {
        await this.releaseQuota(model, quotaPermit);
      }
    }
  }

  async poll(
    rawModel: unknown,
    input: ProviderPollInput,
    context: ProviderCallContext,
  ): Promise<ProviderPollOutcome> {
    const model = modelSnapshotSchema.parse(rawModel);
    assertModelAllowed(model, this.options.mode);
    const adapter = this.registry.get(model);
    if (!adapter.poll) {
      return this.unknownOutcome(context, 'provider_response_invalid');
    }
    const quotaPermit = await this.options.quotaGate.reserve(model, context);
    let releaseAfterTransport: Promise<unknown> | undefined;
    try {
      const remainingMs = context.deadlineAt.getTime() - this.now().getTime();
      if (remainingMs <= 0) return this.unknownOutcome(context, 'provider_timeout');

      const execution = await executeUntilDeadline({
        context,
        remainingMs,
        execute: (transportContext) => adapter.poll!(input, model, transportContext),
        onError: () => this.unknownOutcome(context, 'provider_internal_error'),
        onTimeout: () => this.unknownOutcome(context, 'provider_timeout'),
      });
      if (execution.timedOut) releaseAfterTransport = execution.transport;
      const parsed = providerPollOutcomeSchema.safeParse(execution.outcome);
      return parsed.success
        ? parsed.data
        : this.unknownOutcome(context, 'provider_response_invalid');
    } finally {
      if (releaseAfterTransport) {
        void releaseAfterTransport
          .then(() => this.releaseQuota(model, quotaPermit))
          .catch(() => undefined);
      } else {
        await this.releaseQuota(model, quotaPermit);
      }
    }
  }

  moderateText(
    rawModel: unknown,
    input: unknown,
    context: ProviderCallContext,
  ): Promise<ModerationOutcome> {
    return this.moderate(rawModel, 'moderation.text', input, context);
  }

  moderateImage(
    rawModel: unknown,
    input: unknown,
    context: ProviderCallContext,
  ): Promise<ModerationOutcome> {
    return this.moderate(rawModel, 'moderation.image', input, context);
  }

  private async moderate(
    rawModel: unknown,
    capability: 'moderation.text' | 'moderation.image',
    input: unknown,
    context: ProviderCallContext,
  ): Promise<ModerationOutcome> {
    const model = modelSnapshotSchema.parse(rawModel);
    assertModelAllowed(model, this.options.mode);
    if (!model.capability_contract.capabilities.includes(capability)) {
      throw new ProviderGatewayError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'The model snapshot does not permit this moderation capability',
      );
    }
    const adapter = this.registry.get(model);
    const method =
      capability === 'moderation.text'
        ? adapter.moderateText?.bind(adapter)
        : adapter.moderateImage?.bind(adapter);
    if (!adapter.capabilities.includes(capability) || !method) {
      throw new ProviderGatewayError(
        'PROVIDER_CAPABILITY_UNSUPPORTED',
        'The adapter does not implement this moderation capability',
      );
    }
    const request = normalizedRequest({ capability, input }, model);
    const startedAt = this.now().getTime();
    const quotaPermit = await this.options.quotaGate.reserve(model, context);
    let releaseAfterTransport: Promise<unknown> | undefined;
    try {
      const circuitPermit = await this.options.circuitGate.assertCanSubmit(model);
      const remainingMs = context.deadlineAt.getTime() - this.now().getTime();
      if (remainingMs <= 0) {
        const outcome = this.unknownModeration('provider_timeout');
        await this.recordModerationCircuitOutcome(model, outcome, circuitPermit);
        this.recordModerationTelemetry(model, capability, outcome, startedAt);
        return outcome;
      }
      const execution = await executeUntilDeadline({
        context,
        remainingMs,
        execute: (transportContext) => method(request.input, model, transportContext),
        onError: () => this.unknownModeration('provider_unavailable'),
        onTimeout: () => this.unknownModeration('provider_timeout'),
      });
      if (execution.timedOut) releaseAfterTransport = execution.transport;
      const parsed = moderationOutcomeSchema.safeParse(execution.outcome);
      const normalized = parsed.success
        ? parsed.data
        : this.unknownModeration('provider_response_invalid');
      await this.recordModerationCircuitOutcome(model, normalized, circuitPermit);
      this.recordModerationTelemetry(model, capability, normalized, startedAt);
      return normalized;
    } finally {
      if (releaseAfterTransport) {
        void releaseAfterTransport
          .then(() => this.releaseQuota(model, quotaPermit))
          .catch(() => undefined);
      } else {
        await this.releaseQuota(model, quotaPermit);
      }
    }
  }

  private releaseQuota(model: ModelSnapshot, permit: QuotaPermit | void): Promise<void> {
    return (
      this.options.quotaGate.release?.(model, permit).catch(() => undefined) ?? Promise.resolve()
    );
  }

  private unknownModeration(errorCode: ProviderErrorCode): ModerationOutcome {
    return {
      decision: 'unknown',
      policy_version: 'gateway-v1',
      error_code: errorCode,
    };
  }

  private async recordModerationCircuitOutcome(
    model: ModelSnapshot,
    outcome: ModerationOutcome,
    permit: CircuitPermit | void,
  ): Promise<void> {
    try {
      await this.options.circuitGate.recordModerationOutcome?.(model, outcome, permit);
    } catch (error) {
      throw new ProviderModerationRecordingError(outcome, error);
    }
  }

  private recordModerationTelemetry(
    model: ModelSnapshot,
    capability: 'moderation.text' | 'moderation.image',
    outcome: ModerationOutcome,
    startedAt: number,
  ): void {
    this.telemetry.info({
      event: 'provider_moderation_completed',
      metric: 'provider_moderation_decision_total',
      provider: model.provider,
      model_version: model.version,
      capability,
      decision: outcome.decision,
      ...(outcome.decision === 'unknown' ? { error_code: outcome.error_code } : {}),
      duration_ms: Math.max(0, this.now().getTime() - startedAt),
    });
  }

  private unknownOutcome(
    context: ProviderCallContext,
    errorCode: ProviderErrorCode,
  ): Extract<ProviderSubmitOutcome, { kind: 'outcome_unknown' }> {
    return {
      kind: 'outcome_unknown',
      error_code: errorCode,
      request_digest: context.requestDigest,
      unknown_at: this.now(),
    };
  }
}
