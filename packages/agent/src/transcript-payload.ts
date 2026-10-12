import { z } from 'zod';

import { AGENT_TRANSCRIPT_LIMITS } from './runtime-defaults.js';
import {
  assertTranscriptJsonObject,
  TranscriptJsonError,
  verifyTranscriptJsonContent,
} from './transcript-json.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidSchema = z.uuid().toLowerCase();
const byteSizeSchema = z.int().positive().max(AGENT_TRANSCRIPT_LIMITS.privatePayloadBytes);
const kindSchema = z.enum(['planning', 'authoring', 'tool', 'legacy_message']);
const scopeSchema = z.strictObject({
  user_id: uuidSchema,
  session_id: uuidSchema,
  turn_id: uuidSchema.nullable(),
  import_attempt_id: uuidSchema.nullable(),
});
const identitySchema = scopeSchema
  .extend({ id: uuidSchema, schema_version: z.literal(1), kind: kindSchema })
  .refine((value) =>
    value.kind === 'legacy_message'
      ? value.import_attempt_id !== null
      : value.turn_id !== null && value.import_attempt_id === null,
  );
const prepareInputSchema = identitySchema.safeExtend({ content_json: z.unknown() });
const recordSchema = identitySchema.safeExtend({
  content_json: z.unknown(),
  content_digest: digestSchema,
  byte_size: byteSizeSchema,
});
export const agentTranscriptPayloadReferenceSchema = z.strictObject({
  schema_version: z.literal(1),
  type: z.literal('private_payload'),
  payload_id: uuidSchema,
  kind: kindSchema,
  content_digest: digestSchema,
  byte_size: byteSizeSchema,
});

export type AgentTranscriptPayloadKind = z.infer<typeof kindSchema>;
export type AgentTranscriptPayloadScope = z.infer<typeof scopeSchema>;
export type AgentTranscriptPayloadReference = Readonly<
  z.infer<typeof agentTranscriptPayloadReferenceSchema>
>;
export type AgentTranscriptPayloadRecord<T = unknown> = Omit<
  z.infer<typeof recordSchema>,
  'content_json'
> & { content_json: T };

export interface AgentTranscriptPayloadContract<T> {
  kind: AgentTranscriptPayloadKind;
  /** The host supplies the existing strict, versioned domain schema, never a generic record. */
  contentSchema: z.ZodType<T>;
}

export type AgentTranscriptPayloadFailure =
  | 'metadata_invalid'
  | 'json_invalid'
  | 'content_invalid'
  | 'content_changed'
  | 'content_too_large'
  | 'contract_mismatch'
  | 'scope_mismatch'
  | 'reference_mismatch'
  | 'digest_mismatch'
  | 'byte_size_mismatch';

export class AgentTranscriptPayloadError extends Error {
  constructor(
    readonly reason: AgentTranscriptPayloadFailure,
    /** Bounded cause of the failure (e.g. the offending JSON path) for production diagnosis. */
    readonly detail?: string,
  ) {
    super('AGENT_TRANSCRIPT_PAYLOAD_INVALID');
    this.name = 'AgentTranscriptPayloadError';
  }
}

export function parseAgentTranscriptPayloadReference(
  input: unknown,
): AgentTranscriptPayloadReference {
  return Object.freeze(parseMetadata(agentTranscriptPayloadReferenceSchema, input));
}

export function prepareAgentTranscriptPayload<T>(
  input: unknown,
  contract: AgentTranscriptPayloadContract<T>,
): {
  record: Readonly<AgentTranscriptPayloadRecord<T>>;
  reference: AgentTranscriptPayloadReference;
} {
  const metadata = parseMetadata(prepareInputSchema, input);
  if (metadata.kind !== contract.kind) fail('contract_mismatch');
  const content = verifyContent(metadata.content_json, contract.contentSchema);
  const record = Object.freeze({
    ...metadata,
    content_json: content.value,
    content_digest: content.digest,
    byte_size: content.byteSize,
  });
  const reference = Object.freeze({
    schema_version: record.schema_version,
    type: 'private_payload' as const,
    payload_id: record.id,
    kind: record.kind,
    content_digest: record.content_digest,
    byte_size: record.byte_size,
  });
  return Object.freeze({ record, reference });
}

/** Integrity only. The repository must authorize the live source item/dependencies before loading. */
export function verifyAgentTranscriptPayload<T>(
  input: { scope: unknown; reference: unknown; record: unknown },
  contract: AgentTranscriptPayloadContract<T>,
): T {
  const scope = parseMetadata(scopeSchema, input.scope);
  const reference = parseAgentTranscriptPayloadReference(input.reference);
  const record = parseMetadata(recordSchema, input.record);
  if (record.kind !== contract.kind) fail('contract_mismatch');
  if (
    record.user_id !== scope.user_id ||
    record.session_id !== scope.session_id ||
    record.turn_id !== scope.turn_id ||
    record.import_attempt_id !== scope.import_attempt_id
  ) {
    fail('scope_mismatch');
  }
  if (
    record.id !== reference.payload_id ||
    record.schema_version !== reference.schema_version ||
    record.kind !== reference.kind ||
    record.content_digest !== reference.content_digest ||
    record.byte_size !== reference.byte_size
  ) {
    fail('reference_mismatch');
  }
  const content = verifyContent(record.content_json, contract.contentSchema);
  if (content.byteSize !== record.byte_size) fail('byte_size_mismatch');
  if (content.digest !== record.content_digest) fail('digest_mismatch');
  return content.value;
}

function parseMetadata<T>(schema: z.ZodType<T>, input: unknown): T {
  assertJsonObject(input);
  const result = schema.safeParse(input);
  if (!result.success) fail('metadata_invalid');
  return result.data;
}

function verifyContent<T>(input: unknown, schema: z.ZodType<T>) {
  try {
    return verifyTranscriptJsonContent(input, schema, AGENT_TRANSCRIPT_LIMITS.privatePayloadBytes);
  } catch (error) {
    // Preserve the bounded cause (e.g. which path is not JSON-serializable): collapsing it to a
    // bare reason code is what made production failures impossible to locate.
    if (error instanceof TranscriptJsonError) {
      fail(error.reason, error.detail ?? 'no detail');
    }
    fail(
      'content_invalid',
      error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown',
    );
  }
}

function fail(reason: AgentTranscriptPayloadFailure, detail?: string): never {
  throw new AgentTranscriptPayloadError(reason, detail);
}

function assertJsonObject(input: unknown): void {
  try {
    assertTranscriptJsonObject(input);
  } catch (error) {
    fail(
      'json_invalid',
      error instanceof TranscriptJsonError ? (error.detail ?? 'no detail') : 'unknown cause',
    );
  }
}
