import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import { AGENT_TRANSCRIPT_LIMITS } from './runtime-defaults.js';
import { agentProviderMetadataSchema } from './provider-metadata.js';
import {
  assertTranscriptJsonObject,
  freezeTranscriptJson,
  TranscriptJsonError,
  type TranscriptJsonFailure,
  verifyTranscriptJsonContent,
} from './transcript-json.js';
import {
  agentTranscriptPayloadReferenceSchema,
  type AgentTranscriptPayloadKind,
  type AgentTranscriptPayloadReference,
} from './transcript-payload.js';

const uuidSchema = z.uuid().toLowerCase();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const versionedNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]*@[1-9]\d*$/);
const positiveIntSchema = z.int().positive().max(2_147_483_647);
export const transcriptSequenceSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .pipe(z.string().refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n));
export const transcriptScopeSchema = z.strictObject({
  user_id: uuidSchema,
  session_id: uuidSchema,
});
const inlineSchema = z.strictObject({ type: z.literal('inline'), value: z.unknown() });
const semanticValueSchema = z.discriminatedUnion('type', [
  inlineSchema,
  agentTranscriptPayloadReferenceSchema,
]);
const callSchema = z.strictObject({
  name: versionedNameSchema,
  arguments: semanticValueSchema,
  arguments_digest: digestSchema,
  provider_call_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .nullable(),
  provider_metadata: agentProviderMetadataSchema.optional(),
});
const statusSchema = z.enum(['succeeded', 'rejected', 'not_executed', 'unknown']);
const envelopeSchema = z.union([
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('user_message'),
    content: inlineSchema,
  }),
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('assistant_output'),
    mode: z.enum(['tools', 'terminal']),
    calls: z.array(callSchema).min(1).max(4),
    commentary: z.string().trim().min(1).max(2_000).optional(),
  }),
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('assistant_output'),
    mode: z.literal('text'),
    calls: z.tuple([]),
    text: z.string().min(1).max(8_000),
  }),
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('tool_result'),
    name: versionedNameSchema,
    arguments_digest: digestSchema,
    status: statusSchema,
    result: semanticValueSchema,
  }),
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('host_context'),
    name: versionedNameSchema,
    content: semanticValueSchema,
  }),
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('legacy_message'),
    role: z.enum(['user', 'assistant', 'tool']),
    content: semanticValueSchema,
    source_content_digest: digestSchema,
  }),
  z.strictObject({
    schema_version: z.literal(1),
    type: z.literal('redacted'),
    reason: z.enum(['resource_revoked', 'privacy_erased', 'retention_expired']),
    original_payload_digest: digestSchema,
    redacted_at: z.iso.datetime(),
  }),
]);
const metadataSchema = z.strictObject({
  id: uuidSchema,
  user_id: uuidSchema,
  session_id: uuidSchema,
  turn_id: uuidSchema.nullable(),
  continuation_no: positiveIntSchema.nullable(),
  sequence_no: transcriptSequenceSchema,
  schema_version: z.literal(1),
  item_type: z.enum([
    'user_message',
    'assistant_output',
    'tool_result',
    'host_context',
    'legacy_message',
  ]),
  source_key: z.string().regex(/^[A-Za-z0-9_.:/-]{1,256}$/),
  source_message_id: uuidSchema.nullable(),
  source_trace_step_id: uuidSchema.nullable(),
  import_attempt_id: uuidSchema.nullable(),
  reply_to_item_id: uuidSchema.nullable(),
  call_ordinal: z.int().min(0).max(3).nullable(),
  payload_json: envelopeSchema,
  resource_dependencies_json: z.array(z.unknown()),
  created_at: z.iso.datetime(),
});
const recordSchema = metadataSchema.extend({ payload_digest: digestSchema });

export type AgentTranscriptItem = Readonly<z.infer<typeof recordSchema>>;
export type AgentTranscriptEnvelope = z.infer<typeof envelopeSchema>;
export type AgentTranscriptCall = z.infer<typeof callSchema>;
export type AgentTranscriptResultStatus = z.infer<typeof statusSchema>;

export interface AgentTranscriptValueContract {
  /** The host supplies an existing strict domain schema, never an arbitrary JSON fallback. */
  schema: z.ZodType;
  privatePayloadKind?: AgentTranscriptPayloadKind;
}

export interface AgentTranscriptCallContract {
  name: string;
  mode: 'tools' | 'terminal';
  arguments: AgentTranscriptValueContract;
  results: Record<AgentTranscriptResultStatus, AgentTranscriptValueContract>;
}

export interface AgentTranscriptItemContracts {
  userMessage: AgentTranscriptValueContract;
  legacyMessage: AgentTranscriptValueContract;
  calls: readonly AgentTranscriptCallContract[];
  hostContexts: readonly { name: string; content: AgentTranscriptValueContract }[];
  resourceDependencySchema: z.ZodType;
}

export interface PreparedAgentTranscriptItem {
  item: AgentTranscriptItem;
  /** Structural references only. Authorize live sources/dependencies before reading content. */
  unresolved_payload_references: readonly AgentTranscriptPayloadReference[];
}

export type AgentTranscriptItemFailure =
  | TranscriptJsonFailure
  | 'metadata_invalid'
  | 'contract_mismatch'
  | 'scope_mismatch'
  | 'item_type_mismatch'
  | 'source_invalid'
  | 'pair_invalid'
  | 'digest_mismatch'
  | 'arguments_digest_mismatch'
  | 'reference_mismatch'
  | 'dependency_duplicate'
  | 'dependency_missing'
  | 'redacted_unavailable'
  | 'sequence_invalid'
  | 'duplicate_item'
  | 'protocol_unclosed'
  | 'result_after_failure';

export class AgentTranscriptItemError extends Error {
  constructor(readonly reason: AgentTranscriptItemFailure) {
    super('AGENT_TRANSCRIPT_ITEM_INVALID');
    this.name = 'AgentTranscriptItemError';
  }
}

export function prepareAgentTranscriptItem(
  input: unknown,
  contracts: AgentTranscriptItemContracts,
): PreparedAgentTranscriptItem {
  return withTranscriptItemErrors(() =>
    prepare(parseItemMetadata(metadataSchema, input), contracts, false),
  );
}

export function verifyAgentTranscriptItem(
  input: { scope: unknown; record: unknown },
  contracts: AgentTranscriptItemContracts,
): PreparedAgentTranscriptItem {
  return withTranscriptItemErrors(() => {
    const scope = parseItemMetadata(transcriptScopeSchema, input.scope);
    const record = parseItemMetadata(recordSchema, input.record);
    if (record.user_id !== scope.user_id || record.session_id !== scope.session_id)
      fail('scope_mismatch');
    const prepared = prepare(record, contracts, true);
    if (prepared.item.payload_digest !== record.payload_digest) fail('digest_mismatch');
    return prepared;
  });
}

/** A lossless, ordered dependency snapshot, not proof that the host collected every input. */
export function prepareAgentTranscriptDependencies(input: unknown, schema: z.ZodType) {
  return withTranscriptItemErrors(() => {
    const { dependencies: raw } = parseItemMetadata(
      z.strictObject({ dependencies: z.array(z.unknown()) }),
      { dependencies: input },
    );
    const keys = new Set<string>();
    const dependencies = raw.map((dependency) => {
      const checked = verifyTranscriptJsonContent(
        dependency,
        schema,
        AGENT_TRANSCRIPT_LIMITS.envelopeBytes,
      );
      const key = canonicalJson(checked.value);
      if (keys.has(key)) fail('dependency_duplicate');
      keys.add(key);
      return checked.value;
    });
    return freezeTranscriptJson({ dependencies, digest: canonicalSha256(dependencies) });
  });
}

function prepare(
  record: z.infer<typeof metadataSchema>,
  contracts: AgentTranscriptItemContracts,
  allowRedacted: boolean,
): PreparedAgentTranscriptItem {
  validateMetadataRelations(record);
  const payload = record.payload_json;
  if (payload.type === 'redacted') {
    if (!allowRedacted) fail('redacted_unavailable');
  } else if (payload.type !== record.item_type) fail('item_type_mismatch');

  const calls = namedContracts(contracts.calls);
  const contexts = namedContracts(contracts.hostContexts);
  const references = new Map<string, AgentTranscriptPayloadReference>();
  const checkValue = (
    value: z.infer<typeof semanticValueSchema>,
    contract: AgentTranscriptValueContract,
  ): string => {
    if (value.type === 'inline') {
      return verifyTranscriptJsonContent(
        value.value,
        contract.schema,
        AGENT_TRANSCRIPT_LIMITS.envelopeBytes,
      ).digest;
    }
    if (!contract.privatePayloadKind || value.kind !== contract.privatePayloadKind)
      fail('contract_mismatch');
    if ((value.kind === 'legacy_message') !== (record.item_type === 'legacy_message'))
      fail('contract_mismatch');
    const previous = references.get(value.payload_id);
    if (previous && canonicalJson(previous) !== canonicalJson(value)) fail('reference_mismatch');
    references.set(value.payload_id, value);
    return value.content_digest;
  };
  switch (payload.type) {
    case 'user_message':
      checkValue(payload.content, contracts.userMessage);
      break;
    case 'legacy_message':
      if (checkValue(payload.content, contracts.legacyMessage) !== payload.source_content_digest)
        fail('digest_mismatch');
      break;
    case 'host_context': {
      const contract = contexts.get(payload.name);
      if (!contract) fail('contract_mismatch');
      checkValue(payload.content, contract.content);
      break;
    }
    case 'assistant_output':
      if (payload.mode === 'text') break;
      if (payload.mode !== 'tools' && payload.commentary !== undefined) fail('contract_mismatch');
      if (payload.mode === 'terminal' && payload.calls.length !== 1) fail('contract_mismatch');
      for (const call of payload.calls) {
        const contract = calls.get(call.name);
        if (!contract || contract.mode !== payload.mode) fail('contract_mismatch');
        if (checkValue(call.arguments, contract.arguments) !== call.arguments_digest)
          fail('arguments_digest_mismatch');
      }
      break;
    case 'tool_result': {
      const contract = calls.get(payload.name);
      if (!contract) fail('contract_mismatch');
      checkValue(payload.result, contract.results[payload.status]);
      break;
    }
    case 'redacted':
      break;
  }
  const { dependencies } = prepareAgentTranscriptDependencies(
    record.resource_dependencies_json,
    contracts.resourceDependencySchema,
  );
  // Envelope identity normalization is already complete; semantic values must remain unchanged.
  const checkedPayload = verifyTranscriptJsonContent(
    payload,
    envelopeSchema,
    AGENT_TRANSCRIPT_LIMITS.envelopeBytes,
  );
  const item = freezeTranscriptJson({
    ...record,
    payload_json: checkedPayload.value,
    resource_dependencies_json: dependencies,
    payload_digest: checkedPayload.digest,
  });
  const detachedReferences = [...references.values()].map((reference) => ({ ...reference }));
  return freezeTranscriptJson({ item, unresolved_payload_references: detachedReferences });
}

function validateMetadataRelations(record: z.infer<typeof metadataSchema>): void {
  const legacy = record.item_type === 'legacy_message';
  if (legacy !== (record.import_attempt_id !== null)) fail('source_invalid');
  if (legacy) {
    if (!record.turn_id && record.continuation_no !== null) fail('source_invalid');
  } else if (!record.turn_id || record.continuation_no === null) fail('source_invalid');
  if ((legacy || record.item_type === 'user_message') && !record.source_message_id)
    fail('source_invalid');
  if (record.item_type === 'tool_result') {
    if (!record.reply_to_item_id || record.call_ordinal === null) fail('pair_invalid');
  } else if (record.reply_to_item_id !== null || record.call_ordinal !== null) fail('pair_invalid');
}

function namedContracts<T extends { name: string }>(contracts: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const contract of contracts) {
    if (!versionedNameSchema.safeParse(contract.name).success || result.has(contract.name))
      fail('contract_mismatch');
    result.set(contract.name, contract);
  }
  return result;
}

export function parseItemMetadata<T>(schema: z.ZodType<T>, input: unknown): T {
  assertTranscriptJsonObject(input);
  const result = schema.safeParse(input);
  if (!result.success) fail('metadata_invalid');
  return result.data;
}

export function withTranscriptItemErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof AgentTranscriptItemError) throw error;
    fail(error instanceof TranscriptJsonError ? error.reason : 'metadata_invalid');
  }
}

function fail(reason: AgentTranscriptItemFailure): never {
  throw new AgentTranscriptItemError(reason);
}
