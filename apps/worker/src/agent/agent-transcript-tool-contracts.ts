import {
  inspectImageArgumentsSchema,
  loadSkillArgumentsSchema,
  prepareAgentTranscriptItem,
  transcriptSequenceSchema,
  verifyAgentTranscriptItem,
  type AgentTranscriptCallContract,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
  type AgentTranscriptResultStatus,
  type AgentProviderMetadata,
} from '@ecom-forge/agent';
import { attachmentSnapshotSchema } from '@ecom-forge/compiler';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import { transcriptSkillDependencySchema } from './agent-transcript-skill-context.js';
import type { AgentTranscriptRepositoryOptions } from './agent-transcript.repository.js';

export const transcriptInspectedImageSchema = z.strictObject({
  binding: attachmentSnapshotSchema,
  detail: inspectImageArgumentsSchema.shape.detail,
  materialized: z.literal(true),
});
export const transcriptLoadedSkillSchema = z.strictObject({
  skill_id: z.string().min(3).max(160),
  view: z.enum(['planning', 'references']),
  already_loaded: z.boolean(),
  resources: z.array(transcriptSkillDependencySchema).min(1).max(4),
});
export const transcriptToolErrorContract = {
  schema: z.strictObject({ public_error_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/) }),
};
export const transcriptNotExecutedContract = {
  schema: z.strictObject({
    reason: z.enum([
      'earlier_call_failed',
      'turn_interrupted',
      'turn_superseded',
      'turn_expired',
      'lease_lost',
      'budget_exhausted',
    ]),
  }),
};

export const transcriptKnowledgeToolContracts: readonly AgentTranscriptCallContract[] = [
  {
    name: 'inspect_image@1',
    mode: 'tools',
    arguments: { schema: inspectImageArgumentsSchema },
    results: {
      succeeded: { schema: transcriptInspectedImageSchema },
      rejected: transcriptToolErrorContract,
      unknown: transcriptToolErrorContract,
      not_executed: transcriptNotExecutedContract,
    },
  },
  {
    name: 'load_skill@1',
    mode: 'tools',
    arguments: { schema: loadSkillArgumentsSchema },
    results: {
      succeeded: { schema: transcriptLoadedSkillSchema },
      rejected: transcriptToolErrorContract,
      unknown: transcriptToolErrorContract,
      not_executed: transcriptNotExecutedContract,
    },
  },
];

type ItemMetadata = Omit<
  AgentTranscriptItem,
  'payload_json' | 'payload_digest' | 'item_type' | 'source_key'
>;

/** Validate the whole proposed response before the caller starts any tool. No I/O. */
export function prepareTranscriptKnowledgeBatch(
  metadata: ItemMetadata,
  calls: readonly {
    name: string;
    call_id: string;
    arguments: unknown;
    provider_metadata?: AgentProviderMetadata | undefined;
  }[],
  contracts: AgentTranscriptItemContracts,
  commentary?: string,
): AgentTranscriptItem {
  if (!metadata.turn_id || !metadata.source_trace_step_id) fail();
  if (
    calls.some(
      (call) => !transcriptKnowledgeToolContracts.some((contract) => contract.name === call.name),
    )
  )
    fail();
  return prepareAgentTranscriptItem(
    {
      ...metadata,
      item_type: 'assistant_output',
      source_key: `model:${metadata.source_trace_step_id}:output`,
      payload_json: {
        schema_version: 1,
        type: 'assistant_output',
        mode: 'tools',
        ...(commentary ? { commentary } : {}),
        calls: calls.map((call) => ({
          name: call.name,
          arguments: { type: 'inline', value: call.arguments },
          arguments_digest: canonicalSha256(call.arguments),
          provider_call_id: /^[A-Za-z0-9_-]{1,128}$/.test(call.call_id) ? call.call_id : null,
          ...(call.provider_metadata ? { provider_metadata: call.provider_metadata } : {}),
        })),
      },
    },
    contracts,
  ).item;
}

/** Pairing and dependency derivation only; host source/live authorization is still mandatory. */
export function prepareTranscriptKnowledgeResult(
  input: {
    metadata: Omit<
      ItemMetadata,
      'reply_to_item_id' | 'call_ordinal' | 'resource_dependencies_json'
    >;
    parent: AgentTranscriptItem;
    ordinal: number;
    status: AgentTranscriptResultStatus;
    result: unknown;
  },
  contracts: AgentTranscriptItemContracts,
): AgentTranscriptItem {
  const parent = verifyAgentTranscriptItem(
    {
      scope: { user_id: input.metadata.user_id, session_id: input.metadata.session_id },
      record: input.parent,
    },
    contracts,
  ).item;
  if (
    parent.payload_json.type !== 'assistant_output' ||
    parent.payload_json.mode !== 'tools' ||
    parent.turn_id !== input.metadata.turn_id ||
    parent.continuation_no! > input.metadata.continuation_no! ||
    BigInt(parent.sequence_no) >=
      BigInt(transcriptSequenceSchema.parse(input.metadata.sequence_no)) ||
    !Number.isInteger(input.ordinal)
  )
    fail();
  const call = parent.payload_json.calls[input.ordinal];
  if (!call || call.arguments.type !== 'inline') fail();
  if (!transcriptKnowledgeToolContracts.some((contract) => contract.name === call.name)) fail();
  const dependencies = [...parent.resource_dependencies_json];
  if (input.status === 'succeeded') {
    if (call.name === 'inspect_image@1') {
      const args = inspectImageArgumentsSchema.parse(call.arguments.value);
      const result = transcriptInspectedImageSchema.parse(input.result);
      if (args.binding_key !== result.binding.binding_key || args.detail !== result.detail) fail();
      // The image must have been present in this model input, not merely another readable asset.
      if (!dependencies.some((entry) => canonicalJson(entry) === canonicalJson(result.binding)))
        fail();
    } else if (call.name === 'load_skill@1') {
      const args = loadSkillArgumentsSchema.parse(call.arguments.value);
      const result = transcriptLoadedSkillSchema.parse(input.result);
      // parse() + superRefine guarantee reference_paths is a non-empty array for the
      // references view; the empty fallback is unreachable and only narrows the type.
      const paths = args.view === 'planning' ? ['SKILL.md'] : (args.reference_paths ?? []);
      if (
        result.skill_id !== args.skill_id ||
        result.view !== args.view ||
        result.resources.length !== paths.length ||
        new Set(paths).size !== paths.length ||
        result.resources.some(
          (resource, index) =>
            resource.skill_id !== args.skill_id || resource.resource_path !== paths[index],
        )
      )
        fail();
      dependencies.push(...result.resources);
    } else fail();
  }
  return prepareAgentTranscriptItem(
    {
      ...input.metadata,
      item_type: 'tool_result',
      source_key: `assistant:${parent.id}:result:${input.ordinal}`,
      reply_to_item_id: parent.id,
      call_ordinal: input.ordinal,
      payload_json: {
        schema_version: 1,
        type: 'tool_result',
        name: call.name,
        arguments_digest: call.arguments_digest,
        status: input.status,
        result: { type: 'inline', value: input.result },
      },
      resource_dependencies_json: [
        ...new Map(dependencies.map((entry) => [canonicalJson(entry), entry])).values(),
      ],
    },
    contracts,
  ).item;
}

/** The repository supplies an owned, integrity-checked parent; this function never loads it. */
export function verifyTranscriptKnowledgeResultSource(
  input: Parameters<NonNullable<AgentTranscriptRepositoryOptions['verifyToolResultSource']>>[0],
  contracts: AgentTranscriptItemContracts,
): boolean {
  try {
    const { item, parent } = input;
    const payload = item.payload_json;
    if (
      item.item_type !== 'tool_result' ||
      payload.type !== 'tool_result' ||
      payload.result.type !== 'inline' ||
      item.call_ordinal === null
    )
      return false;
    const restored = prepareTranscriptKnowledgeResult(
      {
        metadata: {
          id: item.id,
          user_id: item.user_id,
          session_id: item.session_id,
          turn_id: item.turn_id,
          continuation_no: item.continuation_no,
          sequence_no: item.sequence_no,
          schema_version: item.schema_version,
          source_message_id: item.source_message_id,
          source_trace_step_id: item.source_trace_step_id,
          import_attempt_id: item.import_attempt_id,
          created_at: item.created_at,
        },
        parent,
        ordinal: item.call_ordinal,
        status: payload.status,
        result: payload.result.value,
      },
      contracts,
    );
    return canonicalJson(item) === canonicalJson(restored);
  } catch {
    return false;
  }
}

function fail(): never {
  throw new Error('AGENT_TRANSCRIPT_TOOL_RESULT_INVALID');
}
