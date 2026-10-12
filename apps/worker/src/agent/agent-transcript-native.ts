import { randomUUID } from 'node:crypto';

import {
  agentConfirmedFactDependencySchema,
  agentConfirmationContextSchema,
  agentConfirmationDependencies,
  prepareAgentConfirmationContext,
  prepareAgentTranscriptItem,
  type AgentBrainStepInput,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { attachmentSnapshotSchema } from '@ecom-forge/compiler';
import { agentTurnConfirmations, and, chatMessages, eq, type Database } from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';
import type { SkillSelectionSnapshot } from '@ecom-forge/skills';
import { z } from 'zod';

import type { ClaimedAgentTurn } from './agent-turn.types.js';
import { appendNativeTranscriptBatch } from './agent-transcript-append.js';
import {
  prepareTranscriptCoreSkillContext,
  transcriptCoreSkillDependencies,
  transcriptCoreSkillContextSchema,
  transcriptSkillDependencySchema,
} from './agent-transcript-skill-context.js';
import {
  transcriptUserMessageContract,
  transcriptUserMessageSchema,
} from './agent-transcript-message-binding.js';
import {
  derivePreviousAttemptFailure,
  PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
  previousAttemptFailureContextSchema,
  previousAttemptFailureSourceKey,
} from './agent-transcript-failure-context.js';
import { transcriptTerminalContracts } from './agent-transcript-terminal-contracts.js';
import { transcriptKnowledgeToolContracts } from './agent-transcript-tool-contracts.js';
import { AgentTranscriptWriteTransactions } from './agent-transcript-write-transaction.js';
import { closeInterruptedTranscriptTail } from './agent-transcript-results.js';
import { transcriptRuntimePolicyContextSchema } from './agent-transcript-policy-context.js';
import type { LoadedSkillResource } from './skill-runtime.adapter.js';

const resourceDependencySchema = z.union([
  attachmentSnapshotSchema,
  transcriptSkillDependencySchema,
  agentConfirmedFactDependencySchema,
]);

export const nativeTranscriptContracts: AgentTranscriptItemContracts = {
  userMessage: transcriptUserMessageContract,
  legacyMessage: { schema: z.never() },
  calls: [...transcriptKnowledgeToolContracts, ...transcriptTerminalContracts],
  hostContexts: [
    { name: 'core_skill_knowledge@1', content: { schema: transcriptCoreSkillContextSchema } },
    { name: 'confirmation_answer@1', content: { schema: agentConfirmationContextSchema } },
    { name: 'runtime_policy@1', content: { schema: transcriptRuntimePolicyContextSchema } },
    {
      name: PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
      content: { schema: previousAttemptFailureContextSchema },
    },
  ],
  resourceDependencySchema,
};

export interface NativeTranscriptCapture {
  expectedGeneration: string;
  phase: 'planning' | 'authoring';
  resourceDependencies: readonly unknown[];
  contracts: AgentTranscriptItemContracts;
}

export function createNativeTranscriptCapture(input: {
  claimed: ClaimedAgentTurn;
  loaded: readonly LoadedSkillResource[];
  authorizedImages: AgentBrainStepInput['authorized_images'];
  confirmedFactDependency?: unknown;
  phase: 'planning' | 'authoring';
}): NativeTranscriptCapture {
  if (input.claimed.transcriptCaptureVersion !== 1)
    throw new Error('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
  if (!input.claimed.transcriptGeneration) throw new Error('AGENT_TRANSCRIPT_GENERATION_MISSING');
  const imageBindings = [
    ...input.claimed.attachments,
    ...(input.claimed.sessionImageCandidates ?? []).map(
      ({
        candidate_kind: _kind,
        candidate_position: _position,
        lineage_source_binding_keys: _lineage,
        source_group: _sourceGroup,
        ...binding
      }) => attachmentSnapshotSchema.parse(binding),
    ),
  ];
  for (const image of input.authorizedImages) {
    if (
      !imageBindings.some(
        (binding) =>
          binding.binding_key === image.binding_key &&
          binding.content_hash === image.content_hash &&
          binding.role === image.role,
      )
    )
      throw new Error('AGENT_TRANSCRIPT_IMAGE_DEPENDENCY_MISSING');
  }
  const dependencies = [
    ...(input.claimed.transcriptSummary?.resource_dependencies ?? []),
    ...(input.claimed.transcriptItems ?? []).flatMap(
      (entry) => entry.item.resource_dependencies_json,
    ),
    ...imageBindings,
    ...input.loaded.map((resource) => skillDependency(input.claimed.selection, resource)),
    ...(input.confirmedFactDependency ? [input.confirmedFactDependency] : []),
  ];
  const unique = [...new Map(dependencies.map((entry) => [canonicalJson(entry), entry])).values()];
  for (const dependency of unique) resourceDependencySchema.parse(dependency);
  return {
    expectedGeneration: input.claimed.transcriptGeneration,
    phase: input.phase,
    resourceDependencies: unique,
    contracts: nativeTranscriptContracts,
  };
}

export async function appendNativeTranscriptPrelude(
  database: Database,
  claimed: ClaimedAgentTurn,
): Promise<void> {
  if (claimed.transcriptCaptureVersion !== 1) throw new Error('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
  if (!claimed.transcriptGeneration) throw new Error('AGENT_TRANSCRIPT_GENERATION_MISSING');
  // Cross-turn continuity, read BEFORE the write transaction: it only touches the immutable
  // terminal state of the previous turn, and deriving it here keeps the write transaction to
  // transcript tables only (the derivation issues its own statements on a second connection).
  const previousAttemptFailure =
    claimed.continuationNo === 1
      ? await derivePreviousAttemptFailure(database, {
          userId: claimed.userId,
          sessionId: claimed.sessionId,
          turnId: claimed.turnId,
        })
      : null;
  await new AgentTranscriptWriteTransactions(database).run(
    {
      userId: claimed.userId,
      sessionId: claimed.sessionId,
      turnId: claimed.turnId,
      owner: claimed.owner,
      revision: claimed.revision,
      continuationNo: claimed.continuationNo,
      expectedGeneration: claimed.transcriptGeneration,
    },
    async (scope) => {
      await closeInterruptedTranscriptTail(scope);
      const source = await scope.query((tx) =>
        tx.query.chatMessages.findFirst({
          where: and(
            eq(chatMessages.id, claimed.userMessageId),
            eq(chatMessages.sessionId, claimed.sessionId),
            eq(chatMessages.turnId, claimed.turnId),
            eq(chatMessages.role, 'user'),
          ),
        }),
      );
      if (!source || source.content !== claimed.message) return scope.abort();
      const content = transcriptUserMessageSchema.parse({
        text: source.content,
        attachments: source.attachments,
      });
      const userItem = prepareAgentTranscriptItem(
        {
          id: randomUUID(),
          user_id: scope.userId,
          session_id: scope.sessionId,
          turn_id: scope.turnId,
          continuation_no: scope.continuationNo,
          sequence_no: scope.nextSequence.toString(),
          schema_version: 1,
          item_type: 'user_message',
          source_key: `message:${claimed.userMessageId}`,
          source_message_id: claimed.userMessageId,
          source_trace_step_id: null,
          import_attempt_id: null,
          reply_to_item_id: null,
          call_ordinal: null,
          payload_json: {
            schema_version: 1,
            type: 'user_message',
            content: {
              type: 'inline',
              value: content,
            },
          },
          resource_dependencies_json: content.attachments,
          created_at: new Date().toISOString(),
        },
        nativeTranscriptContracts,
      ).item;
      const items = [userItem];
      if (claimed.isFirstSessionTurn && claimed.continuationNo === 1) {
        const context = prepareTranscriptCoreSkillContext(claimed.selection);
        items.push(
          prepareAgentTranscriptItem(
            {
              id: randomUUID(),
              user_id: scope.userId,
              session_id: scope.sessionId,
              turn_id: scope.turnId,
              continuation_no: scope.continuationNo,
              sequence_no: (scope.nextSequence + 1n).toString(),
              schema_version: 1,
              item_type: 'host_context',
              source_key: `turn:${scope.turnId}:continuation:${scope.continuationNo}:core-skill`,
              source_message_id: null,
              source_trace_step_id: null,
              import_attempt_id: null,
              reply_to_item_id: null,
              call_ordinal: null,
              payload_json: {
                schema_version: 1,
                type: 'host_context',
                name: 'core_skill_knowledge@1',
                content: { type: 'inline', value: context },
              },
              resource_dependencies_json: transcriptCoreSkillDependencies(context),
              created_at: new Date().toISOString(),
            },
            nativeTranscriptContracts,
          ).item,
        );
      }
      // Cross-turn continuity: only the first continuation of a turn describes a *new* user
      // request, so it is the only place a "the previous attempt failed" context can be attached.
      if (previousAttemptFailure) {
        items.push(
          prepareAgentTranscriptItem(
            {
              id: randomUUID(),
              user_id: scope.userId,
              session_id: scope.sessionId,
              turn_id: scope.turnId,
              continuation_no: scope.continuationNo,
              sequence_no: (scope.nextSequence + BigInt(items.length)).toString(),
              schema_version: 1,
              item_type: 'host_context',
              source_key: previousAttemptFailureSourceKey(scope.turnId),
              source_message_id: null,
              source_trace_step_id: null,
              import_attempt_id: null,
              reply_to_item_id: null,
              call_ordinal: null,
              payload_json: {
                schema_version: 1,
                type: 'host_context',
                name: PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME,
                content: { type: 'inline', value: previousAttemptFailure },
              },
              resource_dependencies_json: [],
              created_at: new Date().toISOString(),
            },
            nativeTranscriptContracts,
          ).item,
        );
      }
      if (claimed.continuationNo > 1) {
        const confirmations = await scope.query((tx) =>
          tx.query.agentTurnConfirmations.findMany({
            where: and(
              eq(agentTurnConfirmations.turnId, scope.turnId),
              eq(agentTurnConfirmations.userId, scope.userId),
              eq(agentTurnConfirmations.status, 'answered'),
            ),
          }),
        );
        const current = confirmations.filter((entry) => {
          const response = z
            .object({ continuation_no: z.int(), turn_id: z.uuid() })
            .safeParse(entry.responseJson);
          return (
            response.success &&
            response.data.continuation_no === scope.continuationNo &&
            response.data.turn_id === scope.turnId
          );
        });
        if (current.length !== 1) return scope.abort();
        const answer = prepareAgentConfirmationContext(current[0]!);
        if (!answer) return scope.abort();
        items.push(
          prepareAgentTranscriptItem(
            {
              id: randomUUID(),
              user_id: scope.userId,
              session_id: scope.sessionId,
              turn_id: scope.turnId,
              continuation_no: scope.continuationNo,
              sequence_no: (scope.nextSequence + BigInt(items.length)).toString(),
              schema_version: 1,
              item_type: 'host_context',
              source_key: `confirmation:${answer.confirmation_id}:answered`,
              source_message_id: null,
              source_trace_step_id: null,
              import_attempt_id: null,
              reply_to_item_id: null,
              call_ordinal: null,
              payload_json: {
                schema_version: 1,
                type: 'host_context',
                name: 'confirmation_answer@1',
                content: { type: 'inline', value: answer },
              },
              resource_dependencies_json: agentConfirmationDependencies(scope.userId, answer),
              created_at: new Date().toISOString(),
            },
            nativeTranscriptContracts,
          ).item,
        );
      }
      await appendNativeTranscriptBatch(
        scope,
        { items, privatePayloads: [] },
        nativeTranscriptContracts,
      );
    },
  );
}

export function skillDependency(selection: SkillSelectionSnapshot, loaded: LoadedSkillResource) {
  const resource = loaded.resource;
  const owner = [
    {
      skillId: selection.primary_skill_id,
      definitionHash: selection.primary_definition_hash,
      packageRecordId: selection.primary_package_record_id,
      resources: [
        selection.primary_planning_resource,
        ...selection.primary_reference_resources,
        ...selection.preset_selections,
      ],
    },
    ...[...selection.required_auxiliary, ...selection.optional_auxiliary].map((skill) => ({
      skillId: skill.skill_id,
      definitionHash: skill.definition_hash,
      packageRecordId: skill.package_record_id,
      resources: [skill.planning_resource, ...skill.reference_resources],
    })),
  ].find((candidate) =>
    candidate.resources.some(
      (candidateResource) =>
        candidateResource.resource_snapshot_id === resource.resource_snapshot_id &&
        candidateResource.resource_hash === resource.resource_hash,
    ),
  );
  if (!owner) throw new Error('AGENT_TRANSCRIPT_SKILL_DEPENDENCY_MISSING');
  return transcriptSkillDependencySchema.parse({
    kind: 'skill_resource',
    catalog_release_id: selection.catalog_release_id,
    catalog_version: selection.catalog_version,
    skill_id: owner.skillId,
    definition_hash: owner.definitionHash,
    package_record_id: owner.packageRecordId,
    ...resource,
  });
}
