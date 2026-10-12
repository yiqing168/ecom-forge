import {
  agentClarificationArgumentsSchema,
  agentConfirmedFactDependencySchema,
  agentProductFactsArgumentsSchema,
  agentRespondArgumentsSchema,
  authoredPromptsSchema,
  parseAgentBrainStepOutcome,
  prepareAgentTranscriptItem,
  prepareAgentTranscriptPayload,
  transcriptSequenceSchema,
  verifyAgentTranscriptItem,
  type AgentTranscriptCallContract,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
  type AgentTranscriptPayloadRecord,
  type AgentTranscriptResultStatus,
  type AgentProviderMetadata,
} from '@ecom-forge/agent';
import { attachmentSnapshotSchema, candidatePlanSchema } from '@ecom-forge/compiler';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import {
  transcriptNotExecutedContract,
  transcriptToolErrorContract,
} from './agent-transcript-tool-contracts.js';

const uuid = z.uuid().toLowerCase();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const confirmationResultSchema = z.strictObject({
  type: z.literal('confirmation_requested'),
  confirmation_id: uuid,
  payload_digest: digest,
});
const scopeConfirmationResultSchema = z.strictObject({
  type: z.literal('scope_confirmation_requested'),
  confirmation_id: uuid,
  payload_digest: digest,
  scope_digest: digest,
});
const quoteResultSchema = z.strictObject({
  type: z.literal('quote_created'),
  quote_id: uuid,
  plan_digest: digest,
});
const messageResultSchema = z.strictObject({
  type: z.literal('message_published'),
  message_id: uuid,
  content_digest: digest,
});
const factsResultSchema = z.strictObject({
  type: z.literal('facts_already_confirmed'),
  dependency: agentConfirmedFactDependencySchema,
});
const authoringResultSchema = z.strictObject({
  type: z.literal('authoring_required'),
  plan_digest: digest,
});
const authoringBatchResultSchema = z.strictObject({
  type: z.literal('authoring_batch_saved'),
  arguments_digest: digest,
});
export const transcriptTerminalSuccessSchema = z.discriminatedUnion('type', [
  messageResultSchema,
  confirmationResultSchema,
  scopeConfirmationResultSchema,
  factsResultSchema,
  authoringResultSchema,
  authoringBatchResultSchema,
  quoteResultSchema,
]);
export const transcriptCandidateArgumentsSchema = z.strictObject({ plan: candidatePlanSchema });

const failureResults = {
  rejected: transcriptToolErrorContract,
  unknown: transcriptToolErrorContract,
  not_executed: transcriptNotExecutedContract,
};
export const transcriptTerminalContracts: readonly AgentTranscriptCallContract[] = [
  {
    name: 'agent_respond@1',
    mode: 'terminal',
    arguments: { schema: agentRespondArgumentsSchema },
    results: { ...failureResults, succeeded: { schema: messageResultSchema } },
  },
  {
    name: 'agent_request_clarification@1',
    mode: 'terminal',
    arguments: { schema: agentClarificationArgumentsSchema },
    results: { ...failureResults, succeeded: { schema: confirmationResultSchema } },
  },
  {
    name: 'agent_request_product_facts@1',
    mode: 'terminal',
    arguments: { schema: agentProductFactsArgumentsSchema },
    results: {
      ...failureResults,
      succeeded: { schema: z.union([confirmationResultSchema, factsResultSchema]) },
    },
  },
  {
    name: 'agent_candidate_plan@1',
    mode: 'terminal',
    arguments: { schema: transcriptCandidateArgumentsSchema, privatePayloadKind: 'planning' },
    results: {
      ...failureResults,
      succeeded: {
        schema: z.union([authoringResultSchema, quoteResultSchema, scopeConfirmationResultSchema]),
      },
    },
  },
  {
    name: 'agent_author_prompts@1',
    mode: 'terminal',
    arguments: { schema: authoredPromptsSchema, privatePayloadKind: 'authoring' },
    results: {
      ...failureResults,
      succeeded: {
        schema: z.union([
          authoringBatchResultSchema,
          quoteResultSchema,
          scopeConfirmationResultSchema,
        ]),
      },
    },
  },
];

export type TranscriptTerminalMetadata = Omit<
  AgentTranscriptItem,
  'payload_json' | 'payload_digest' | 'item_type' | 'source_key'
>;

/** Capture accepted semantics only. Persistence, usage settlement and execution are separate. */
export function prepareTranscriptTerminalOutput(
  input: {
    metadata: TranscriptTerminalMetadata;
    outcome: unknown;
    phase: 'planning' | 'authoring';
    privatePayloadId: string;
  },
  contracts: AgentTranscriptItemContracts,
): { item: AgentTranscriptItem; privatePayloads: readonly AgentTranscriptPayloadRecord[] } {
  return withTerminalErrors(() => {
    const outcome = parseAgentBrainStepOutcome(input.outcome);
    if (canonicalJson(outcome) !== canonicalJson(input.outcome)) fail();
    if (!['planning', 'authoring'].includes(input.phase)) fail();
    const metadata = input.metadata;
    if (!metadata.turn_id || !metadata.source_trace_step_id) fail();
    if (outcome.type === 'chat_text') {
      if (input.phase !== 'planning') fail();
      const item = prepareAgentTranscriptItem(
        {
          ...metadata,
          item_type: 'assistant_output',
          source_key: `model:${metadata.source_trace_step_id}:output`,
          payload_json: {
            schema_version: 1,
            type: 'assistant_output',
            mode: 'text',
            calls: [],
            text: outcome.text,
          },
        },
        contracts,
      ).item;
      return { item, privatePayloads: [] };
    }
    let name: string;
    let args: unknown;
    let providerCallId: string | null = null;
    let providerMetadata: AgentProviderMetadata | undefined;
    if (input.phase === 'authoring') {
      if (
        (outcome.type !== 'candidate_plan' && outcome.type !== 'authoring_batch') ||
        !outcome.authoring_output
      )
        fail();
      name = outcome.authoring_output.name;
      args = outcome.authoring_output.arguments;
      providerCallId = outcome.authoring_output.provider_call_id;
      providerMetadata = outcome.authoring_output.provider_metadata;
    } else {
      if ('provider_metadata' in outcome) providerMetadata = outcome.provider_metadata;
      switch (outcome.type) {
        case 'respond':
          name = 'agent_respond@1';
          args = { text: outcome.text };
          break;
        case 'request_clarification':
          name = 'agent_request_clarification@1';
          args = {
            question: outcome.question,
            ...(outcome.suggestions === undefined ? {} : { suggestions: outcome.suggestions }),
          };
          break;
        case 'request_product_facts':
          name = 'agent_request_product_facts@1';
          args = {
            source_binding_key: outcome.source_binding_key,
            candidate_facts: outcome.candidate_facts,
            evidence: outcome.evidence,
          };
          break;
        case 'candidate_plan':
          if (outcome.authoring_output) fail();
          name = 'agent_candidate_plan@1';
          args = { plan: outcome.plan };
          break;
        case 'authoring_request':
          name = 'agent_candidate_plan@1';
          args = { plan: outcome.plan };
          break;
        default:
          fail();
      }
    }
    const contract = transcriptTerminalContracts.find((candidate) => candidate.name === name)!;
    const privatePayloads: AgentTranscriptPayloadRecord[] = [];
    let value: unknown = { type: 'inline', value: args };
    if (contract.arguments.privatePayloadKind) {
      const prepared = prepareAgentTranscriptPayload(
        {
          id: input.privatePayloadId,
          user_id: metadata.user_id,
          session_id: metadata.session_id,
          turn_id: metadata.turn_id,
          import_attempt_id: null,
          schema_version: 1,
          kind: contract.arguments.privatePayloadKind,
          content_json: args,
        },
        {
          kind: contract.arguments.privatePayloadKind,
          contentSchema: contract.arguments.schema,
        },
      );
      privatePayloads.push(prepared.record);
      value = prepared.reference;
    }
    const item = prepareAgentTranscriptItem(
      {
        ...metadata,
        item_type: 'assistant_output',
        source_key: `model:${metadata.source_trace_step_id}:output`,
        payload_json: {
          schema_version: 1,
          type: 'assistant_output',
          mode: 'terminal',
          calls: [
            {
              name,
              arguments: value,
              arguments_digest: canonicalSha256(args),
              provider_call_id: providerCallId,
              ...(providerMetadata ? { provider_metadata: providerMetadata } : {}),
            },
          ],
        },
      },
      contracts,
    ).item;
    return { item, privatePayloads: Object.freeze(privatePayloads) };
  });
}

/** Constructs a paired receipt. The caller must prove and atomically commit its domain source. */
export function prepareTranscriptTerminalResult(
  input: {
    metadata: Omit<
      TranscriptTerminalMetadata,
      'reply_to_item_id' | 'call_ordinal' | 'resource_dependencies_json'
    >;
    parent: AgentTranscriptItem;
    status: AgentTranscriptResultStatus;
    result: unknown;
  },
  contracts: AgentTranscriptItemContracts,
): AgentTranscriptItem {
  return withTerminalErrors(() => {
    const parent = verifyAgentTranscriptItem(
      {
        scope: { user_id: input.metadata.user_id, session_id: input.metadata.session_id },
        record: input.parent,
      },
      contracts,
    ).item;
    if (
      parent.payload_json.type !== 'assistant_output' ||
      parent.payload_json.mode !== 'terminal' ||
      parent.turn_id !== input.metadata.turn_id ||
      parent.continuation_no! > input.metadata.continuation_no! ||
      input.metadata.source_message_id !== null ||
      input.metadata.import_attempt_id !== null ||
      parent.source_trace_step_id !== input.metadata.source_trace_step_id ||
      BigInt(parent.sequence_no) >=
        BigInt(transcriptSequenceSchema.parse(input.metadata.sequence_no))
    )
      fail();
    const call = parent.payload_json.calls[0]!;
    if (!transcriptTerminalContracts.some((contract) => contract.name === call.name)) fail();
    const dependencies = [...parent.resource_dependencies_json];
    if (input.status === 'succeeded') {
      const result = transcriptTerminalSuccessSchema.parse(input.result);
      if (call.name === 'agent_request_product_facts@1') {
        if (call.arguments.type !== 'inline') fail();
        const args = agentProductFactsArgumentsSchema.parse(call.arguments.value);
        const source = parent.resource_dependencies_json
          .map((entry) => attachmentSnapshotSchema.safeParse(entry))
          .find((entry) => entry.success && entry.data.binding_key === args.source_binding_key);
        if (
          !source?.success ||
          source.data.kind !== 'asset' ||
          source.data.role !== 'product' ||
          source.data.owner_user_id !== parent.user_id
        )
          fail();
      }
      if (result.type === 'message_published') {
        if (call.arguments.type !== 'inline') fail();
        const args = agentRespondArgumentsSchema.parse(call.arguments.value);
        if (result.content_digest !== canonicalSha256({ text: args.text.normalize('NFC') })) fail();
      }
      if (result.type === 'facts_already_confirmed') {
        if (result.dependency.owner_user_id !== parent.user_id) fail();
        dependencies.push(result.dependency);
      }
      if (result.type === 'authoring_required' && result.plan_digest !== call.arguments_digest)
        fail();
      if (
        result.type === 'authoring_batch_saved' &&
        (call.name !== 'agent_author_prompts@1' ||
          result.arguments_digest !== call.arguments_digest)
      )
        fail();
    }
    return prepareAgentTranscriptItem(
      {
        ...input.metadata,
        item_type: 'tool_result',
        source_key: `assistant:${parent.id}:result:0`,
        reply_to_item_id: parent.id,
        call_ordinal: 0,
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
  });
}

function withTerminalErrors<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    // Preserve the original cause: replacing it with a generic code erases every reason a
    // production failure could be located from (`AgentTranscriptPayloadError.reason` etc.).
    throw new Error('AGENT_TRANSCRIPT_TERMINAL_INVALID', { cause: error });
  }
}

function fail(): never {
  throw new Error('AGENT_TRANSCRIPT_TERMINAL_INVALID');
}
