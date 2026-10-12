import { z } from 'zod';

import {
  ACTIVE_JOB_TYPES,
  SUPPORTED_QUEUE_SCHEMA_VERSIONS,
  type ActiveJobType,
  type QueueSchemaVersion,
} from './constants.js';

const uuid = z.uuid();
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const v1Envelope = {
  schema_version: z.literal(1),
  trace_id: uuid,
};

const v2Envelope = {
  schema_version: z.literal(2),
  trace_id: uuid,
};

const v4Envelope = {
  schema_version: z.literal(4),
  trace_id: uuid,
};

const workflowAdvanceSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('workflow.advance'),
  workflow_run_id: uuid,
  user_id: uuid,
});

const taskExecuteSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('task.execute'),
  task_id: uuid,
  workflow_run_id: uuid,
  task_attempt_id: uuid.optional(),
  user_id: uuid,
});

const moderationExecuteSchema = z.strictObject({
  ...v4Envelope,
  job_type: z.literal('moderation.execute'),
  task_id: uuid,
  workflow_run_id: uuid,
  user_id: uuid,
});

const agentContinueSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('agent.continue'),
  session_id: uuid,
  turn_id: uuid,
  user_message_id: uuid,
  continuation_no: z.int().positive(),
  turn_revision: z.int().positive(),
  retry_no: z.int().nonnegative().max(8).optional(),
});

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const agentQuoteSubmitSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('agent.quote.submit'),
  turn_id: uuid,
  quote_id: uuid,
  continuation_no: z.int().positive(),
  plan_digest: sha256,
  authorization_digest: sha256,
});

const agentQuoteExpireSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('agent.quote.expire'),
  turn_id: uuid,
  quote_id: uuid,
  continuation_no: z.int().positive(),
  plan_digest: sha256,
});

const evaluationRunSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('evaluation.run'),
  artifact_id: uuid,
  evaluation_type: z.enum(['commerce_evidence', 'platform_spec', 'content_safety']),
  workflow_run_id: uuid,
});

const assetProcessSchema = z
  .strictObject({
    ...v1Envelope,
    job_type: z.literal('asset.process'),
    asset_id: uuid,
    operation: z.enum(['generate_thumbnail', 'inspect_metadata', 'cleanup']),
    operation_no: z.int().positive(),
    user_id: uuid,
    idempotency_key: z.string().min(1).max(256),
  })
  .superRefine((value, context) => {
    if (
      value.idempotency_key !== `asset:${value.asset_id}:${value.operation}:${value.operation_no}`
    ) {
      context.addIssue({
        code: 'custom',
        path: ['idempotency_key'],
        message: 'idempotency_key does not match the asset operation',
      });
    }
  });

const exportProcessSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('export.process'),
  export_id: uuid,
  operation: z.enum(['build', 'retry_failed', 'cleanup']),
  user_id: uuid,
  idempotency_key: z
    .string()
    .min(1)
    .max(256)
    .regex(/^export:[0-9a-f-]{36}:(?:build|retry_failed|cleanup):\d+$/),
});

const providerCallbackProcessSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('provider.callback.process'),
  provider_callback_event_id: uuid,
  processing_no: z.int().positive(),
});

const providerPollSchema = z.strictObject({
  ...v1Envelope,
  job_type: z.literal('provider.poll'),
  task_attempt_id: uuid,
  poll_no: z.int().positive(),
});

const settlementExecuteSchema = z
  .strictObject({
    ...v1Envelope,
    job_type: z.literal('settlement.execute'),
    workflow_run_id: uuid,
    task_id: uuid,
    task_attempt_id: uuid,
    reservation_id: uuid,
    provider_reported_cost: decimal.optional(),
    artifact_ids: z.array(uuid),
    idempotency_key: z.string().min(1).max(256),
  })
  .superRefine((value, context) => {
    if (value.idempotency_key !== `settle:task_attempt:${value.task_attempt_id}`) {
      context.addIssue({
        code: 'custom',
        path: ['idempotency_key'],
        message: 'idempotency_key does not match the task attempt',
      });
    }
  });

const skillPackageValidateSchema = z.strictObject({
  ...v2Envelope,
  job_type: z.literal('skill-package.validate'),
  package_record_id: uuid,
  validation_report_id: uuid,
  attempt_no: z.int().positive(),
  package_digest: sha256,
  validator_contract_version: z.string().min(1).max(128),
  platform_eval_suite_digest: sha256,
});

const evaluationV3Envelope = {
  schema_version: z.literal(3),
  trace_id: uuid,
};

const providerCredentialValidateSchema = z.strictObject({
  ...evaluationV3Envelope,
  job_type: z.literal('provider-credential.validate'),
  credential_validation_run_id: uuid,
  provider_channel_id: uuid,
  credential_version_id: uuid,
  probe_contract_version: z.string().min(1).max(128),
  attempt_no: z.int().positive(),
});

const storageCredentialValidateSchema = z.strictObject({
  ...evaluationV3Envelope,
  job_type: z.literal('storage-credential.validate'),
  storage_validation_run_id: uuid,
  storage_channel_id: uuid,
  credential_version_id: uuid,
  probe_contract_version: z.string().min(1).max(128),
  attempt_no: z.int().positive(),
});

const modelPocRunSchema = z.strictObject({
  ...evaluationV3Envelope,
  job_type: z.literal('model-poc.run'),
  model_poc_run_id: uuid,
  model_snapshot_id: uuid,
  provider_channel_id: uuid,
  credential_version_id: uuid,
  probe_suite_version: z.string().min(1).max(128),
  requested_spec_keys_digest: sha256,
  attempt_no: z.int().positive(),
});

export const queuePayloadSchema = z.discriminatedUnion('job_type', [
  workflowAdvanceSchema,
  taskExecuteSchema,
  moderationExecuteSchema,
  agentContinueSchema,
  agentQuoteSubmitSchema,
  agentQuoteExpireSchema,
  evaluationRunSchema,
  assetProcessSchema,
  exportProcessSchema,
  providerCallbackProcessSchema,
  providerPollSchema,
  settlementExecuteSchema,
  skillPackageValidateSchema,
  providerCredentialValidateSchema,
  storageCredentialValidateSchema,
  modelPocRunSchema,
]);

export type QueuePayload = z.infer<typeof queuePayloadSchema>;

export const QUEUE_PAYLOAD_ERROR_CODES = [
  'QUEUE_SCHEMA_VERSION_UNSUPPORTED',
  'QUEUE_JOB_TYPE_UNSUPPORTED',
  'QUEUE_PAYLOAD_SENSITIVE_FIELD',
  'QUEUE_PAYLOAD_INVALID',
] as const;

export type QueuePayloadErrorCode = (typeof QUEUE_PAYLOAD_ERROR_CODES)[number];

export class QueuePayloadError extends Error {
  constructor(
    readonly code: QueuePayloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'QueuePayloadError';
  }
}

const FORBIDDEN_FIELD_NAMES = new Set([
  'api_key',
  'access_token',
  'refresh_token',
  'secret',
  'provider_key',
  'prompt',
  'full_prompt',
  'object_key',
  'signed_url',
  'binary',
  'bytes',
  'image_data',
  'file_data',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findSensitiveField(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findSensitiveField(item);
      if (nested) return nested;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) return key;
    const nested = findSensitiveField(nestedValue);
    if (nested) return nested;
  }
  return undefined;
}

function readEnvelopeField(input: unknown, key: string): unknown {
  return isRecord(input) ? input[key] : undefined;
}

export function parseQueuePayload(input: unknown): QueuePayload {
  const schemaVersion = readEnvelopeField(input, 'schema_version');
  if (
    typeof schemaVersion !== 'number' ||
    !SUPPORTED_QUEUE_SCHEMA_VERSIONS.includes(schemaVersion as QueueSchemaVersion)
  ) {
    throw new QueuePayloadError(
      'QUEUE_SCHEMA_VERSION_UNSUPPORTED',
      'Queue payload schema version is unsupported',
    );
  }
  const jobType = readEnvelopeField(input, 'job_type');
  if (typeof jobType !== 'string' || !ACTIVE_JOB_TYPES.includes(jobType as ActiveJobType)) {
    throw new QueuePayloadError(
      'QUEUE_JOB_TYPE_UNSUPPORTED',
      'Queue payload job type is unsupported',
    );
  }
  const sensitiveField = findSensitiveField(input);
  if (sensitiveField) {
    throw new QueuePayloadError(
      'QUEUE_PAYLOAD_SENSITIVE_FIELD',
      `Queue payload contains forbidden field: ${sensitiveField}`,
    );
  }
  const result = queuePayloadSchema.safeParse(input);
  if (!result.success) {
    throw new QueuePayloadError('QUEUE_PAYLOAD_INVALID', 'Queue payload is invalid');
  }
  return result.data;
}
