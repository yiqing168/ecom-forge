import {
  agentClarificationPayloadSchema,
  agentClarificationArgumentsSchema,
  agentProductFactsArgumentsSchema,
  agentProductFactsConfirmationPayloadSchema,
  prepareAgentTranscriptDependencies,
  transcriptSequenceSchema,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import {
  agentTraces,
  agentTraceSteps,
  agentTurnConfirmations,
  and,
  assets,
  chatMessages,
  eq,
  productFactSets,
  runQuotes,
  type Database,
} from '@ecom-forge/db';
import { attachmentSnapshotSchema } from '@ecom-forge/compiler';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import {
  modelOutputBindingSchema,
  verifyTranscriptModelOutputSource,
} from './agent-transcript-model-binding.js';
import {
  prepareTranscriptTerminalResult,
  transcriptTerminalSuccessSchema,
} from './agent-transcript-terminal-contracts.js';

const uuid = z.uuid().toLowerCase();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const resultBindingSchema = z.strictObject({
  schema_version: z.literal(1),
  assistant_item_id: uuid,
  call_ordinal: z.literal(0),
  result_item_id: uuid,
  continuation_no: z.int().positive().max(2_147_483_647),
  sequence_no: transcriptSequenceSchema,
  payload_digest: digest,
  arguments_digest: digest,
  resource_dependencies_digest: digest,
});
// The terminal step's outputSummary is written in two stages: a base object at terminal-write
// time plus a jsonb-merged transcript_result binding. Only the merged binding is semantic; the
// base diagnostic fields stay optional so the strict schema tolerates both stages.
const summarySchema = z.strictObject({
  transcript_output: modelOutputBindingSchema,
  transcript_result: resultBindingSchema,
  // recordModelStepDiagnostic jsonb-merges downstream outcomes into the same summary.
  downstream: z.record(z.string(), z.unknown()).optional(),
  // The model-output capture writes these siblings onto the same step summary.
  transcript_outcome_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  transcript_results: z.unknown().optional(),
  diagnostic: z.record(z.string(), z.unknown()).optional(),
  outcome: z.string().optional(),
  message_id: z.uuid().optional(),
  confirmation_id: z.uuid().optional(),
  action: z.string().optional(),
  rule: z.string().optional(),
  reason: z.string().optional(),
  missing_skill_ids: z.array(z.string()).optional(),
  error_key: z.string().optional(),
  progress_hash: z.string().optional(),
  source_binding_key: z.string().optional(),
});

/** Persist with the domain result and item. This is never a recovery-time source generator. */
export function prepareTranscriptTerminalResultBinding(
  item: AgentTranscriptItem,
  parent: AgentTranscriptItem,
  contracts: AgentTranscriptItemContracts,
) {
  try {
    const payload = item.payload_json;
    if (payload.type !== 'tool_result' || payload.result.type !== 'inline') fail();
    const restored = prepareTranscriptTerminalResult(
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
        status: payload.status,
        result: payload.result.value,
      },
      contracts,
    );
    if (canonicalJson(restored) !== canonicalJson(item)) fail();
    return Object.freeze(
      resultBindingSchema.parse({
        schema_version: 1,
        assistant_item_id: parent.id,
        call_ordinal: 0,
        result_item_id: item.id,
        continuation_no: item.continuation_no,
        sequence_no: item.sequence_no,
        payload_digest: item.payload_digest,
        arguments_digest: payload.arguments_digest,
        resource_dependencies_digest: prepareAgentTranscriptDependencies(
          item.resource_dependencies_json,
          contracts.resourceDependencySchema,
        ).digest,
      }),
    );
  } catch {
    fail();
  }
}

/** Source proof only. The owned repository separately checks all inherited live dependencies. */
export class AgentTranscriptTerminalBinding {
  constructor(
    private readonly database: Pick<Database, 'query'>,
    private readonly contracts: AgentTranscriptItemContracts,
  ) {}

  async verifySource(input: { item: AgentTranscriptItem; parent: AgentTranscriptItem }) {
    try {
      const { item, parent } = input;
      const expected = prepareTranscriptTerminalResultBinding(item, parent, this.contracts);
      const trace = await this.database.query.agentTraces.findFirst({
        where: and(
          eq(agentTraces.turnId, item.turn_id!),
          eq(agentTraces.userId, item.user_id),
          eq(agentTraces.sessionId, item.session_id),
        ),
        columns: { id: true, turnId: true, userId: true, sessionId: true },
      });
      if (
        !trace ||
        trace.turnId !== item.turn_id ||
        trace.userId !== item.user_id ||
        trace.sessionId !== item.session_id
      )
        return false;
      const step = await this.database.query.agentTraceSteps.findFirst({
        where: and(
          eq(agentTraceSteps.id, item.source_trace_step_id!),
          eq(agentTraceSteps.traceId, trace.id),
        ),
        columns: {
          id: true,
          traceId: true,
          stepType: true,
          actor: true,
          status: true,
          errorCode: true,
          inputSummary: true,
          outputSummary: true,
        },
      });
      if (
        !step ||
        step.traceId !== trace.id ||
        !verifyTranscriptModelOutputSource(parent, step, this.contracts)
      )
        return false;
      const summary = summarySchema.safeParse(step.outputSummary);
      if (
        !summary.success ||
        canonicalJson(summary.data.transcript_result) !== canonicalJson(expected)
      )
        return false;
      const payload = item.payload_json;
      if (payload.type !== 'tool_result' || payload.result.type !== 'inline') return false;
      if (payload.status !== 'succeeded') return true;
      const result = transcriptTerminalSuccessSchema.parse(payload.result.value);
      switch (result.type) {
        case 'authoring_required':
          return result.plan_digest === payload.arguments_digest;
        case 'authoring_batch_saved':
          return (
            payload.name === 'agent_author_prompts@1' &&
            result.arguments_digest === payload.arguments_digest
          );
        case 'message_published': {
          const message = await this.database.query.chatMessages.findFirst({
            where: and(
              eq(chatMessages.id, result.message_id),
              eq(chatMessages.sessionId, item.session_id),
              eq(chatMessages.turnId, item.turn_id),
              eq(chatMessages.role, 'assistant'),
            ),
            columns: {
              id: true,
              sessionId: true,
              turnId: true,
              role: true,
              content: true,
              attachments: true,
              pendingApproval: true,
              toolCalls: true,
            },
          });
          return (
            !!message &&
            message.id === result.message_id &&
            message.sessionId === item.session_id &&
            message.turnId === item.turn_id &&
            message.role === 'assistant' &&
            canonicalJson(message.attachments) === '[]' &&
            canonicalJson(message.pendingApproval) === '{}' &&
            canonicalJson(message.toolCalls) === '[]' &&
            canonicalSha256({ text: message.content }) === result.content_digest
          );
        }
        case 'confirmation_requested':
        case 'scope_confirmation_requested': {
          const confirmation = await this.database.query.agentTurnConfirmations.findFirst({
            where: and(
              eq(agentTurnConfirmations.id, result.confirmation_id),
              eq(agentTurnConfirmations.userId, item.user_id),
              eq(agentTurnConfirmations.turnId, item.turn_id),
            ),
            columns: {
              id: true,
              userId: true,
              turnId: true,
              type: true,
              answerSchemaVersion: true,
              payloadDigest: true,
              publicPayloadJson: true,
            },
          });
          const type =
            payload.name === 'agent_request_clarification@1' ||
            payload.name === 'agent_candidate_plan@1' ||
            payload.name === 'agent_author_prompts@1'
              ? 'clarification'
              : 'product_facts';
          if (
            !confirmation ||
            confirmation.id !== result.confirmation_id ||
            confirmation.userId !== item.user_id ||
            confirmation.turnId !== item.turn_id ||
            confirmation.type !== type ||
            confirmation.answerSchemaVersion !== 1 ||
            confirmation.payloadDigest !== result.payload_digest ||
            canonicalSha256(confirmation.publicPayloadJson) !== result.payload_digest
          )
            return false;
          const schema =
            type === 'clarification'
              ? agentClarificationPayloadSchema
              : agentProductFactsConfirmationPayloadSchema;
          const confirmed = schema.parse(confirmation.publicPayloadJson);
          if (canonicalJson(confirmed) !== canonicalJson(confirmation.publicPayloadJson))
            return false;
          if (result.type === 'scope_confirmation_requested') {
            const clarification = agentClarificationPayloadSchema.parse(confirmed);
            return (
              (payload.name === 'agent_candidate_plan@1' ||
                payload.name === 'agent_author_prompts@1') &&
              clarification.scope_digest === result.scope_digest &&
              clarification.allow_free_text === false &&
              clarification.options.length === 2 &&
              clarification.options[0]?.id === 'option-1' &&
              clarification.options[1]?.id === 'option-2'
            );
          }
          const call =
            parent.payload_json.type === 'assistant_output'
              ? parent.payload_json.calls[0]
              : undefined;
          if (call?.arguments.type !== 'inline') return false;
          if (type === 'clarification') {
            const args = agentClarificationArgumentsSchema.parse(call.arguments.value);
            const question = agentClarificationPayloadSchema.parse(confirmed);
            return (
              question.question === args.question.normalize('NFC') &&
              canonicalJson(question.options) ===
                canonicalJson(
                  (args.suggestions ?? []).map((label, index) => ({
                    id: `option-${index + 1}`,
                    label: label.normalize('NFC'),
                  })),
                )
            );
          }
          const args = agentProductFactsArgumentsSchema.parse(call.arguments.value);
          const question = agentProductFactsConfirmationPayloadSchema.parse(confirmed);
          const source = productSource(parent, args.source_binding_key);
          return (
            !!source &&
            question.source_asset_id === source.object_id &&
            question.source_version === source.object_version &&
            canonicalJson(question.candidate_facts) === canonicalJson(args.candidate_facts)
          );
        }
        case 'quote_created': {
          const quote = await this.database.query.runQuotes.findFirst({
            where: and(
              eq(runQuotes.id, result.quote_id),
              eq(runQuotes.userId, item.user_id),
              eq(runQuotes.source, 'chat'),
              eq(runQuotes.sourceId, item.turn_id),
            ),
            columns: { id: true, userId: true, source: true, sourceId: true, planDigest: true },
          });
          return (
            !!quote &&
            quote.id === result.quote_id &&
            quote.userId === item.user_id &&
            quote.source === 'chat' &&
            quote.sourceId === item.turn_id &&
            quote.planDigest === result.plan_digest
          );
        }
        case 'facts_already_confirmed': {
          const dependency = result.dependency;
          const call =
            parent.payload_json.type === 'assistant_output'
              ? parent.payload_json.calls[0]
              : undefined;
          if (call?.arguments.type !== 'inline') return false;
          const args = agentProductFactsArgumentsSchema.parse(call.arguments.value);
          const source = productSource(parent, args.source_binding_key);
          if (!source) return false;
          const asset = await this.database.query.assets.findFirst({
            where: and(eq(assets.id, source.object_id), eq(assets.userId, item.user_id)),
            columns: {
              id: true,
              userId: true,
              productId: true,
              status: true,
              deletedAt: true,
              contentHash: true,
            },
          });
          if (
            !asset ||
            asset.id !== source.object_id ||
            asset.userId !== item.user_id ||
            asset.productId !== dependency.product_id ||
            asset.status !== 'ready' ||
            asset.deletedAt !== null ||
            asset.contentHash !== source.content_hash ||
            source.object_version !== source.content_hash
          )
            return false;
          const fact = await this.database.query.productFactSets.findFirst({
            where: and(
              eq(productFactSets.id, dependency.object_id),
              eq(productFactSets.userId, item.user_id),
              eq(productFactSets.productId, dependency.product_id),
            ),
            columns: {
              id: true,
              userId: true,
              productId: true,
              versionNo: true,
              sourceAssetId: true,
              sourceVersion: true,
              factsJson: true,
              confirmedBy: true,
              confirmedAt: true,
            },
          });
          return (
            !!fact &&
            fact.id === dependency.object_id &&
            fact.userId === item.user_id &&
            fact.productId === dependency.product_id &&
            String(fact.versionNo) === dependency.object_version &&
            fact.sourceAssetId === dependency.source_asset_id &&
            fact.sourceVersion === dependency.source_version &&
            fact.confirmedBy === item.user_id &&
            fact.confirmedAt instanceof Date &&
            Number.isFinite(fact.confirmedAt.getTime()) &&
            canonicalSha256(fact.factsJson) === dependency.content_hash
          );
        }
      }
    } catch {
      return false;
    }
  }
}

function fail(): never {
  throw new Error('AGENT_TRANSCRIPT_TERMINAL_SOURCE_INVALID');
}

function productSource(parent: AgentTranscriptItem, key: string) {
  for (const entry of parent.resource_dependencies_json) {
    const parsed = attachmentSnapshotSchema.safeParse(entry);
    if (
      parsed.success &&
      parsed.data.binding_key === key &&
      parsed.data.kind === 'asset' &&
      parsed.data.role === 'product' &&
      parsed.data.owner_user_id === parent.user_id
    )
      return parsed.data;
  }
  return null;
}
