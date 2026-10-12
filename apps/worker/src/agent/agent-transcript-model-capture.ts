import { randomUUID } from 'node:crypto';

import {
  parseAgentBrainStepOutcome,
  verifyAgentTranscriptPayload,
  type AgentBrainStepOutcome,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { agentTranscriptItems, agentTranscriptPayloads, and, eq, isNull } from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';

import { appendNativeTranscriptBatch } from './agent-transcript-append.js';
import {
  prepareTranscriptModelInputBinding,
  prepareTranscriptModelOutputBinding,
  verifyTranscriptModelOutputSource,
  type TranscriptModelSourceStep,
} from './agent-transcript-model-binding.js';
import { prepareTranscriptKnowledgeBatch } from './agent-transcript-tool-contracts.js';
import {
  prepareTranscriptTerminalOutput,
  type TranscriptTerminalMetadata,
} from './agent-transcript-terminal-contracts.js';
import { privatePayloadUses } from './agent-transcript.repository.js';
import { verifyStoredTranscriptItem } from './agent-transcript-storage-mapping.js';
import { prepareTranscriptRuntimePolicyContext } from './agent-transcript-policy-context.js';
import type { AgentTranscriptWriteScope } from './agent-transcript-write-transaction.js';

export interface TranscriptModelCapture {
  expectedGeneration: string;
  phase: 'planning' | 'authoring';
  /** Collected from the actual authorized input before reserve, never inferred from output. */
  resourceDependencies: readonly unknown[];
  contracts: AgentTranscriptItemContracts;
}

export function verifyTranscriptReservedInput(
  stepId: string,
  continuationNo: number,
  summary: unknown,
  capture: TranscriptModelCapture,
) {
  const expected = prepareTranscriptModelInputBinding(
    {
      step_id: stepId,
      continuation_no: continuationNo,
      resource_dependencies: capture.resourceDependencies,
    },
    capture.contracts.resourceDependencySchema,
  );
  const parsed = z
    .object({
      purpose: z.literal('agent_step'),
      continuation_no: z.int().positive(),
      transcript_phase: z.enum(['planning', 'authoring']),
      transcript_input: z.unknown(),
    })
    .safeParse(summary);
  if (
    !parsed.success ||
    parsed.data.continuation_no !== continuationNo ||
    parsed.data.transcript_phase !== capture.phase ||
    canonicalJson(parsed.data.transcript_input) !== canonicalJson(expected)
  )
    throw new Error('AGENT_TRANSCRIPT_MODEL_INPUT_DRIFT');
  return expected;
}

/** Storage and acceptance only. No tools, prompts, or external calls are executed here. */
export async function captureTranscriptModelOutput(
  scope: AgentTranscriptWriteScope,
  input: {
    step: TranscriptModelSourceStep;
    outcome: AgentBrainStepOutcome;
    capture: TranscriptModelCapture;
  },
): Promise<{
  item: AgentTranscriptItem;
  binding: ReturnType<typeof prepareTranscriptModelOutputBinding>;
} | null> {
  const { capture, step } = input;
  if (step.status !== 'started') throw new Error('AGENT_TRANSCRIPT_MODEL_ALREADY_SETTLED');
  const inputBinding = verifyTranscriptReservedInput(
    step.id,
    scope.continuationNo,
    step.inputSummary,
    capture,
  );
  const outcome = parseAgentBrainStepOutcome(input.outcome);
  if (canonicalJson(outcome) !== canonicalJson(input.outcome))
    throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_INVALID');
  if (
    outcome.type === 'invalid_tool_input' ||
    outcome.type === 'invalid_terminal_output' ||
    outcome.type === 'public_text_rejected'
  )
    return null;
  const metadata = {
    id: randomUUID(),
    user_id: scope.userId,
    session_id: scope.sessionId,
    turn_id: scope.turnId,
    continuation_no: scope.continuationNo,
    sequence_no: scope.nextSequence.toString(),
    schema_version: 1 as const,
    source_message_id: null,
    source_trace_step_id: step.id,
    import_attempt_id: null,
    reply_to_item_id: null,
    call_ordinal: null,
    resource_dependencies_json: [...capture.resourceDependencies],
    created_at: new Date().toISOString(),
  };
  const prepared = prepareOutput(metadata, outcome, capture, randomUUID());
  const appended = await appendNativeTranscriptBatch(
    scope,
    {
      items: [prepared.item],
      privatePayloads: prepared.privatePayloads,
    },
    capture.contracts,
  );
  const item = appended.items[0]!;
  const binding = prepareTranscriptModelOutputBinding(item, inputBinding, capture.contracts);
  return { item, binding };
}

/** A settled step may only verify existing records. Missing records are never repaired here. */
export async function verifySettledTranscriptModelOutput(
  scope: AgentTranscriptWriteScope,
  input: {
    step: TranscriptModelSourceStep;
    outcome: AgentBrainStepOutcome;
    capture: TranscriptModelCapture;
  },
): Promise<void> {
  const { step, outcome, capture } = input;
  verifyTranscriptReservedInput(step.id, scope.continuationNo, step.inputSummary, capture);
  const row = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        eq(agentTranscriptItems.turnId, scope.turnId),
        eq(agentTranscriptItems.sourceKey, `model:${step.id}:output`),
      ),
    }),
  );
  if (
    outcome.type === 'invalid_tool_input' ||
    outcome.type === 'invalid_terminal_output' ||
    outcome.type === 'public_text_rejected'
  ) {
    const policyRow = await scope.query((tx) =>
      tx.query.agentTranscriptItems.findFirst({
        where: and(
          eq(agentTranscriptItems.userId, scope.userId),
          eq(agentTranscriptItems.sessionId, scope.sessionId),
          eq(agentTranscriptItems.turnId, scope.turnId),
          eq(agentTranscriptItems.sourceKey, `policy:${step.id}:${policySourceSuffix(outcome)}`),
        ),
      }),
    );
    if (
      row ||
      !policyRow ||
      step.status !== 'failed' ||
      step.errorCode !== outcome.error_code ||
      (step.outputSummary as Record<string, unknown>).transcript_output !== undefined
    )
      throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
    const policy = verifyStoredTranscriptItem(
      policyRow,
      { user_id: scope.userId, session_id: scope.sessionId },
      capture.contracts,
    );
    const repairAttempt = z
      .object({ diagnostic: z.object({ repair_attempt: z.int().min(1).max(4).optional() }) })
      .parse(step.outputSummary).diagnostic.repair_attempt;
    const expected = prepareTranscriptRuntimePolicyContext(
      {
        id: policy.id,
        userId: scope.userId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        continuationNo: scope.continuationNo,
        sequenceNo: policy.sequence_no,
        stepId: step.id,
        outcome,
        ...(repairAttempt === undefined ? {} : { repairAttempt }),
        createdAt: policy.created_at,
      },
      capture.contracts,
    );
    if (canonicalJson(policy) !== canonicalJson(expected))
      throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
    return;
  }
  if (!row) throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
  const item = verifyStoredTranscriptItem(
    row,
    { user_id: scope.userId, session_id: scope.sessionId },
    capture.contracts,
  );
  if (!verifyTranscriptModelOutputSource(item, step, capture.contracts))
    throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
  const uses = privatePayloadUses(item, capture.contracts);
  const prepared = prepareOutput(
    item,
    outcome,
    capture,
    uses[0]?.reference.payload_id ?? randomUUID(),
  );
  if (canonicalJson(prepared.item) !== canonicalJson(item))
    throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
  for (const { reference, contract } of uses) {
    const payload = await scope.query((tx) =>
      tx.query.agentTranscriptPayloads.findFirst({
        where: and(
          eq(agentTranscriptPayloads.id, reference.payload_id),
          eq(agentTranscriptPayloads.userId, scope.userId),
          eq(agentTranscriptPayloads.sessionId, scope.sessionId),
          eq(agentTranscriptPayloads.turnId, scope.turnId),
          isNull(agentTranscriptPayloads.importAttemptId),
        ),
      }),
    );
    if (!payload) throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
    const content = verifyAgentTranscriptPayload(
      {
        scope: {
          user_id: scope.userId,
          session_id: scope.sessionId,
          turn_id: scope.turnId,
          import_attempt_id: null,
        },
        reference,
        record: {
          id: payload.id,
          user_id: payload.userId,
          session_id: payload.sessionId,
          turn_id: payload.turnId,
          import_attempt_id: payload.importAttemptId,
          schema_version: payload.schemaVersion,
          kind: payload.kind,
          content_json: payload.contentJson,
          content_digest: payload.contentDigest,
          byte_size: payload.byteSize,
        },
      },
      { kind: reference.kind, contentSchema: contract.schema },
    );
    const expected = prepared.privatePayloads.find((entry) => entry.id === reference.payload_id);
    if (!expected || canonicalJson(content) !== canonicalJson(expected.content_json))
      throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
  }
}

function policySourceSuffix(
  outcome: Extract<
    AgentBrainStepOutcome,
    { type: 'invalid_tool_input' | 'invalid_terminal_output' | 'public_text_rejected' }
  >,
): 'invalid-tool-input' | 'invalid-terminal-output' | 'public-text-rejected' {
  if (outcome.type === 'public_text_rejected') return 'public-text-rejected';
  return outcome.type === 'invalid_tool_input' ? 'invalid-tool-input' : 'invalid-terminal-output';
}

function prepareOutput(
  metadata: TranscriptTerminalMetadata,
  outcome: AgentBrainStepOutcome,
  capture: TranscriptModelCapture,
  privatePayloadId: string,
) {
  // Select metadata explicitly: a stored item also carries a digest, which is not input metadata.
  const identity = {
    id: metadata.id,
    user_id: metadata.user_id,
    session_id: metadata.session_id,
    turn_id: metadata.turn_id,
    continuation_no: metadata.continuation_no,
    sequence_no: metadata.sequence_no,
    schema_version: metadata.schema_version,
    source_message_id: metadata.source_message_id,
    source_trace_step_id: metadata.source_trace_step_id,
    import_attempt_id: metadata.import_attempt_id,
    reply_to_item_id: metadata.reply_to_item_id,
    call_ordinal: metadata.call_ordinal,
    resource_dependencies_json: metadata.resource_dependencies_json,
    created_at: metadata.created_at,
  };
  return outcome.type === 'tool_calls'
    ? {
        item: prepareTranscriptKnowledgeBatch(
          identity,
          outcome.calls,
          capture.contracts,
          outcome.commentary,
        ),
        privatePayloads: [],
      }
    : prepareTranscriptTerminalOutput(
        { metadata: identity, phase: capture.phase, outcome, privatePayloadId },
        capture.contracts,
      );
}
