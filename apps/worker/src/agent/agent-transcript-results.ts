import { randomUUID } from 'node:crypto';

import {
  verifyAgentTranscriptPayload,
  type AgentTranscriptItem,
  type AgentTranscriptResultStatus,
} from '@ecom-forge/agent';
import {
  agentTranscriptItems,
  agentTranscriptPayloads,
  agentTraceSteps,
  agentTraces,
  agentTurns,
  and,
  desc,
  eq,
  sql,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';

import { appendNativeTranscriptBatch } from './agent-transcript-append.js';
import { nativeTranscriptContracts } from './agent-transcript-native.js';
import { verifyTranscriptModelOutputSource } from './agent-transcript-model-binding.js';
import { verifyStoredTranscriptItem } from './agent-transcript-storage-mapping.js';
import { prepareTranscriptKnowledgeResultBinding } from './agent-transcript-knowledge-binding.js';
import { prepareTranscriptTerminalResultBinding } from './agent-transcript-terminal-binding.js';
import {
  prepareTranscriptTerminalResult,
  transcriptCandidateArgumentsSchema,
} from './agent-transcript-terminal-contracts.js';
import {
  prepareTranscriptKnowledgeResult,
  verifyTranscriptKnowledgeResultSource,
} from './agent-transcript-tool-contracts.js';
import {
  AgentTranscriptWriteTransactions,
  type AgentTranscriptWriteScope,
} from './agent-transcript-write-transaction.js';
import { appendTraceStepWithQuery } from './agent-turn.repository-helpers.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';
import type { Database } from '@ecom-forge/db';

/** Route every new turn write through the native transcript transaction. */
export function withNativeTurnWrite<T>(
  database: Database,
  input: { claimed: ClaimedAgentTurn; revision: number },
  operation: (scope: AgentTranscriptWriteScope, turn: typeof agentTurns.$inferSelect) => Promise<T>,
) {
  const { claimed } = input;
  if (claimed.transcriptCaptureVersion !== 1 || !claimed.transcriptGeneration)
    throw new Error('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
  return new AgentTranscriptWriteTransactions(database).run(
    {
      userId: claimed.userId,
      sessionId: claimed.sessionId,
      turnId: claimed.turnId,
      owner: claimed.owner,
      revision: input.revision,
      continuationNo: claimed.continuationNo,
      expectedGeneration: claimed.transcriptGeneration,
    },
    async (scope) => {
      const turn = await scope.query((tx) =>
        tx.query.agentTurns.findFirst({
          where: and(
            eq(agentTurns.id, scope.turnId),
            eq(agentTurns.userId, scope.userId),
            eq(agentTurns.sessionId, scope.sessionId),
          ),
        }),
      );
      if (!turn || turn.executionFormat !== 'transcript_v1' || turn.transcriptCaptureVersion !== 1)
        return scope.abort();
      return operation(scope, turn);
    },
  );
}

export async function appendNativeTerminalReceipt(
  scope: AgentTranscriptWriteScope,
  stepId: string,
  status: AgentTranscriptResultStatus,
  result: unknown,
) {
  const parent = await readNativeModelOutput(scope, stepId);
  if (parent.payload_json.type !== 'assistant_output' || parent.payload_json.mode !== 'terminal')
    return scope.abort();
  return appendNativeResult(scope, { parent, ordinal: 0, sourceStepId: stepId, status, result });
}

export async function replayNativeTerminalReceipt(
  scope: AgentTranscriptWriteScope,
  stepId: string,
  status: AgentTranscriptResultStatus,
  result: unknown,
) {
  const parent = await readNativeModelOutput(scope, stepId);
  const receipt = await readNativeResult(scope, parent, 0);
  if (!receipt) return false;
  const payload = receipt.payload_json;
  if (
    payload.type !== 'tool_result' ||
    payload.result.type !== 'inline' ||
    payload.status !== status ||
    canonicalSha256(payload.result.value) !== canonicalSha256(result)
  )
    return scope.abort();
  return true;
}

export async function rejectNativePendingCalls(
  scope: AgentTranscriptWriteScope,
  input: { errorCode: string; sourceStepId: string; llmStepId?: string },
) {
  const row = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        eq(agentTranscriptItems.turnId, scope.turnId),
        eq(agentTranscriptItems.itemType, 'assistant_output'),
        input.llmStepId
          ? eq(agentTranscriptItems.sourceKey, `model:${input.llmStepId}:output`)
          : undefined,
      ),
      orderBy: [desc(agentTranscriptItems.sequenceNo)],
    }),
  );
  // Invalid model output/unknown delivery has no accepted semantic call to complete.
  if (!row) return;
  const parent = await readNativeModelOutput(scope, row.sourceTraceStepId!);
  if (parent.payload_json.type !== 'assistant_output') return scope.abort();
  if (parent.payload_json.mode === 'text') return;
  const completed = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findMany({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        eq(agentTranscriptItems.replyToItemId, parent.id),
      ),
    }),
  );
  const ordinals = new Set(
    completed.map(
      (item) =>
        verifyStoredTranscriptItem(
          item,
          { user_id: scope.userId, session_id: scope.sessionId },
          nativeTranscriptContracts,
        ).call_ordinal,
    ),
  );
  const ordinal = parent.payload_json.calls.findIndex((_call, index) => !ordinals.has(index));
  if (ordinal === -1) return;
  await appendNativeResult(scope, {
    parent,
    ordinal,
    sourceStepId:
      parent.payload_json.mode === 'terminal' ? parent.source_trace_step_id! : input.sourceStepId,
    status: 'rejected',
    result: { public_error_code: input.errorCode },
    closeRemaining: true,
  });
}

/** Close a terminal predecessor before the next turn appends its first model-visible event. */
export async function closeInterruptedTranscriptTail(scope: AgentTranscriptWriteScope) {
  const tail = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        eq(agentTranscriptItems.itemType, 'assistant_output'),
      ),
      orderBy: [desc(agentTranscriptItems.sequenceNo)],
    }),
  );
  if (!tail || tail.turnId === scope.turnId) return;
  const [previous] = await scope.query((tx) =>
    tx
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.id, tail.turnId!),
          eq(agentTurns.userId, scope.userId),
          eq(agentTurns.sessionId, scope.sessionId),
        ),
      )
      .for('update'),
  );
  if (
    !previous ||
    !previous.endedAt ||
    !['cancelled', 'superseded', 'failed', 'blocked'].includes(previous.status)
  )
    return;
  const previousScope: AgentTranscriptWriteScope = Object.freeze({
    ...scope,
    turnId: previous.id,
    continuationNo: previous.continuationNo,
    revision: previous.revision,
  });
  const parent = await readNativeModelOutput(previousScope, tail.sourceTraceStepId!);
  if (parent.payload_json.type !== 'assistant_output') return scope.abort();
  if (parent.payload_json.mode === 'text') return;
  const pending: number[] = [];
  for (let ordinal = 0; ordinal < parent.payload_json.calls.length; ordinal += 1) {
    if (!(await readNativeResult(previousScope, parent, ordinal))) pending.push(ordinal);
  }
  if (!pending.length) return;
  const trace = await scope.query((tx) =>
    tx.query.agentTraces.findFirst({
      where: and(
        eq(agentTraces.turnId, previous.id),
        eq(agentTraces.userId, scope.userId),
        eq(agentTraces.sessionId, scope.sessionId),
      ),
    }),
  );
  if (!trace) return scope.abort();
  const reason = previous.status === 'superseded' ? 'turn_superseded' : 'turn_interrupted';
  const step =
    parent.payload_json.mode === 'terminal'
      ? { stepId: parent.source_trace_step_id! }
      : await appendTraceStepWithQuery(scope.query, trace.id, {
          stepType: 'guardrail',
          actor: 'system',
          status: 'blocked',
          inputSummary: { action: 'close_interrupted_transcript' },
          outputSummary: {},
        });
  // Native business actions and their receipts commit atomically. A missing receipt here means
  // the terminal predecessor did not commit that local action; nothing is dispatched by recovery.
  await appendNativeResult(previousScope, {
    parent,
    ordinal: pending[0]!,
    sourceStepId: step.stepId,
    status: 'not_executed',
    result: { reason },
    closeRemaining: true,
  });
}

export async function readNativeModelOutput(scope: AgentTranscriptWriteScope, stepId: string) {
  const row = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        eq(agentTranscriptItems.turnId, scope.turnId),
        eq(agentTranscriptItems.sourceKey, `model:${stepId}:output`),
      ),
    }),
  );
  if (!row) return scope.abort();
  const parent = verifyStoredTranscriptItem(
    row,
    { user_id: scope.userId, session_id: scope.sessionId },
    nativeTranscriptContracts,
  );
  const [step] = await scope.query((tx) =>
    tx
      .select({ step: agentTraceSteps })
      .from(agentTraceSteps)
      .innerJoin(agentTraces, eq(agentTraces.id, agentTraceSteps.traceId))
      .where(
        and(
          eq(agentTraceSteps.id, stepId),
          eq(agentTraces.turnId, scope.turnId),
          eq(agentTraces.sessionId, scope.sessionId),
          eq(agentTraces.userId, scope.userId),
        ),
      ),
  );
  if (!step || !verifyTranscriptModelOutputSource(parent, step.step, nativeTranscriptContracts))
    return scope.abort();
  return parent;
}

/** Materialize the persisted plan only after verifying its owned model-output source. */
export async function readNativeCandidatePlan(scope: AgentTranscriptWriteScope, stepId: string) {
  const parent = await readNativeModelOutput(scope, stepId);
  if (parent.payload_json.type !== 'assistant_output' || parent.payload_json.mode !== 'terminal')
    return undefined;
  const call = parent.payload_json.calls[0];
  if (call?.name !== 'agent_candidate_plan@1') return undefined;
  const reference = call.arguments;
  let value: unknown;
  if (reference.type === 'inline') {
    value = reference.value;
  } else {
    const row = await scope.query((tx) =>
      tx.query.agentTranscriptPayloads.findFirst({
        where: and(
          eq(agentTranscriptPayloads.id, reference.payload_id),
          eq(agentTranscriptPayloads.userId, scope.userId),
          eq(agentTranscriptPayloads.sessionId, scope.sessionId),
          eq(agentTranscriptPayloads.turnId, scope.turnId),
        ),
      }),
    );
    if (!row) return scope.abort();
    value = verifyAgentTranscriptPayload(
      {
        scope: {
          user_id: scope.userId,
          session_id: scope.sessionId,
          turn_id: scope.turnId,
          import_attempt_id: parent.import_attempt_id,
        },
        reference,
        record: {
          id: row.id,
          user_id: row.userId,
          session_id: row.sessionId,
          turn_id: row.turnId,
          import_attempt_id: row.importAttemptId,
          schema_version: row.schemaVersion,
          kind: row.kind,
          content_json: row.contentJson,
          content_digest: row.contentDigest,
          byte_size: row.byteSize,
        },
      },
      { kind: reference.kind, contentSchema: transcriptCandidateArgumentsSchema },
    );
  }
  if (canonicalSha256(value) !== call.arguments_digest) return scope.abort();
  return transcriptCandidateArgumentsSchema.parse(value).plan;
}

export async function readNativeResult(
  scope: AgentTranscriptWriteScope,
  parent: AgentTranscriptItem,
  ordinal: number,
) {
  const row = await scope.query((tx) =>
    tx.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, scope.userId),
        eq(agentTranscriptItems.sessionId, scope.sessionId),
        eq(agentTranscriptItems.turnId, scope.turnId),
        eq(agentTranscriptItems.sourceKey, `assistant:${parent.id}:result:${ordinal}`),
      ),
    }),
  );
  if (!row) return null;
  const item = verifyStoredTranscriptItem(
    row,
    { user_id: scope.userId, session_id: scope.sessionId },
    nativeTranscriptContracts,
  );
  if (
    parent.payload_json.type !== 'assistant_output' ||
    item.payload_json.type !== 'tool_result' ||
    item.payload_json.result.type !== 'inline' ||
    item.reply_to_item_id !== parent.id ||
    item.call_ordinal !== ordinal
  )
    return scope.abort();
  if (parent.payload_json.mode === 'tools') {
    if (!verifyTranscriptKnowledgeResultSource({ item, parent }, nativeTranscriptContracts))
      return scope.abort();
    const expected = prepareTranscriptKnowledgeResultBinding(
      item,
      parent,
      nativeTranscriptContracts,
    );
    const step = await scope.query((tx) =>
      tx.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, item.source_trace_step_id!),
        columns: { outputSummary: true },
      }),
    );
    const bindings = (step?.outputSummary as Record<string, unknown> | undefined)
      ?.transcript_results;
    if (
      !Array.isArray(bindings) ||
      bindings.filter((entry) => canonicalSha256(entry) === canonicalSha256(expected)).length !== 1
    )
      return scope.abort();
  } else {
    const expected = prepareTranscriptTerminalResultBinding(
      item,
      parent,
      nativeTranscriptContracts,
    );
    const step = await scope.query((tx) =>
      tx.query.agentTraceSteps.findFirst({
        where: eq(agentTraceSteps.id, parent.source_trace_step_id!),
        columns: { outputSummary: true },
      }),
    );
    if (
      !step ||
      canonicalSha256((step.outputSummary as Record<string, unknown>).transcript_result) !==
        canonicalSha256(expected)
    )
      return scope.abort();
  }
  return item;
}

export async function appendNativeResult(
  scope: AgentTranscriptWriteScope,
  input: {
    parent: AgentTranscriptItem;
    ordinal: number;
    sourceStepId: string;
    status: AgentTranscriptResultStatus;
    result: unknown;
    closeRemaining?: boolean;
  },
) {
  const payload = input.parent.payload_json;
  if (payload.type !== 'assistant_output') return scope.abort();
  const items: AgentTranscriptItem[] = [];
  // The model output may have been appended earlier in this same transaction. The
  // immutable scope cursor then predates its parent; the append path assigns the
  // actual session sequence after validating this ordering constraint.
  const parentNextSequence = BigInt(input.parent.sequence_no) + 1n;
  const firstSequence =
    scope.nextSequence > parentNextSequence ? scope.nextSequence : parentNextSequence;
  const make = (ordinal: number, status: AgentTranscriptResultStatus, result: unknown) => {
    const metadata = {
      id: randomUUID(),
      user_id: scope.userId,
      session_id: scope.sessionId,
      turn_id: scope.turnId,
      continuation_no: scope.continuationNo,
      sequence_no: (firstSequence + BigInt(items.length)).toString(),
      schema_version: 1 as const,
      source_message_id: null,
      source_trace_step_id: input.sourceStepId,
      import_attempt_id: null,
      created_at: new Date().toISOString(),
    };
    return payload.mode === 'terminal'
      ? prepareTranscriptTerminalResult(
          { metadata, parent: input.parent, status, result },
          nativeTranscriptContracts,
        )
      : prepareTranscriptKnowledgeResult(
          { metadata, parent: input.parent, ordinal, status, result },
          nativeTranscriptContracts,
        );
  };
  if (payload.mode === 'terminal' && input.ordinal !== 0) return scope.abort();
  items.push(make(input.ordinal, input.status, input.result));
  if (input.closeRemaining) {
    if (input.status === 'succeeded') return scope.abort();
    for (let ordinal = input.ordinal + 1; ordinal < payload.calls.length; ordinal += 1)
      items.push(make(ordinal, 'not_executed', { reason: 'earlier_call_failed' }));
  }
  const appended = await appendNativeTranscriptBatch(
    scope,
    { items, privatePayloads: [] },
    nativeTranscriptContracts,
  );
  if (payload.mode === 'terminal') {
    const binding = prepareTranscriptTerminalResultBinding(
      appended.items[0]!,
      input.parent,
      nativeTranscriptContracts,
    );
    await scope.query((tx) =>
      tx
        .update(agentTraceSteps)
        .set({
          outputSummary: sql`${agentTraceSteps.outputSummary} || ${JSON.stringify({ transcript_result: binding })}::jsonb`,
        })
        .where(eq(agentTraceSteps.id, input.parent.source_trace_step_id!)),
    );
  } else {
    const bindings = appended.items.map((item) =>
      prepareTranscriptKnowledgeResultBinding(item, input.parent, nativeTranscriptContracts),
    );
    await scope.query((tx) =>
      tx
        .update(agentTraceSteps)
        .set({
          outputSummary: sql`${agentTraceSteps.outputSummary} || ${JSON.stringify({ transcript_results: bindings })}::jsonb`,
        })
        .where(eq(agentTraceSteps.id, input.sourceStepId)),
    );
  }
  return appended;
}
