import {
  type AgentBrainImageDetail,
  type AgentTranscriptItem,
  callPositionKey,
} from '@ecom-forge/agent';
import { attachmentSnapshotSchema } from '@ecom-forge/compiler';
import { agentTraces, agentTraceSteps, and, eq, type Database } from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';

import {
  appendOutboxEventInTransaction,
  appendOutboxEventWithQuery,
} from '../database/outbox.repository.js';
import { appendTraceStepWithQuery, lockOwnedTurn } from './agent-turn.repository-helpers.js';
import type { ClaimedAgentTurn, TraceStepInput } from './agent-turn.types.js';
import { recordModelStepDiagnostic } from './agent-model-step-diagnostic.js';
import {
  appendNativeResult,
  readNativeModelOutput,
  readNativeResult,
  rejectNativePendingCalls,
  withNativeTurnWrite,
} from './agent-transcript-results.js';
import { nativeTranscriptContracts, skillDependency } from './agent-transcript-native.js';
import { appendTranscriptRuntimePolicyContext } from './agent-transcript-policy-context.js';
import type { AgentTranscriptWriteScope } from './agent-transcript-write-transaction.js';
import type { LoadedSkillResource } from './skill-runtime.adapter.js';

export class AgentTurnToolRepository {
  constructor(private readonly database: Database) {}

  async finishImageInspection(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    callOrdinal: number;
    callPositionKey: string;
    toolFingerprint: string;
    argsHash: string;
    bindingKey: string;
    detail: AgentBrainImageDetail;
    materializedBindingKeys: readonly string[];
    materializedImageDetails: Readonly<Record<string, AgentBrainImageDetail>>;
    progressHash: string;
    callCount: number;
  }): Promise<boolean> {
    return withNativeTurnWrite(this.database, input, async (scope) => {
      const parent = await readToolCall(scope, { ...input, toolName: 'inspect_image@1' });
      const binding = parent.resource_dependencies_json
        .map((entry) => attachmentSnapshotSchema.safeParse(entry))
        .find((entry) => entry.success && entry.data.binding_key === input.bindingKey);
      if (!binding?.success) return scope.abort();
      const result = { binding: binding.data, detail: input.detail, materialized: true };
      if (
        await replayToolReceipt(scope, {
          ...input,
          parent,
          toolName: 'inspect_image@1',
          status: 'succeeded',
          result,
        })
      )
        return true;
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: 1,
          update: { outputSummary: { outcome: 'tool_calls', call_count: input.callCount } },
        }),
      );
      const step = await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'tool_call',
        actor: 'tool',
        toolName: 'inspect_image@1',
        callPositionKey: input.callPositionKey,
        toolFingerprint: input.toolFingerprint,
        argsHash: input.argsHash,
        inputSummary: {
          action: 'inspect_image',
          binding_key: input.bindingKey,
          detail: input.detail,
        },
        outputSummary: {
          outcome: 'succeeded',
          materialized_image_binding_keys: [...input.materializedBindingKeys],
          materialized_image_details: input.materializedImageDetails,
          progress_hash: input.progressHash,
        },
        status: 'succeeded',
      });
      await appendNativeResult(scope, {
        parent,
        ordinal: input.callOrdinal,
        sourceStepId: step.stepId,
        status: 'succeeded',
        result,
      });
      return true;
    });
  }

  async finishTool(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    callOrdinal: number;
    loadedResources: readonly LoadedSkillResource[];
    skillId: string;
    toolName: string;
    callPositionKey: string;
    toolFingerprint: string;
    argsHash: string;
    outputSummary: Record<string, unknown>;
    progressHash: string;
    callCount: number;
    finishActivity: boolean;
  }): Promise<{ eventSeq: number | null } | null> {
    return withNativeTurnWrite(this.database, input, async (scope) => {
      const parent = await readToolCall(scope, input);
      const result = {
        skill_id: input.skillId,
        view: input.outputSummary.view,
        already_loaded: input.loadedResources.every((entry) => entry.alreadyLoaded),
        resources: input.loadedResources.map((entry) =>
          skillDependency(input.claimed.selection, entry),
        ),
      };
      if (await replayToolReceipt(scope, { ...input, parent, status: 'succeeded', result }))
        return { eventSeq: null };
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: 1,
          update: { outputSummary: { outcome: 'tool_calls', call_count: input.callCount } },
        }),
      );
      const step = await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'tool_call',
        actor: 'tool',
        skillId: input.skillId,
        toolName: input.toolName,
        callPositionKey: input.callPositionKey,
        toolFingerprint: input.toolFingerprint,
        argsHash: input.argsHash,
        inputSummary: { action: 'load_skill' },
        outputSummary: { ...input.outputSummary, progress_hash: input.progressHash },
        status: 'succeeded',
      });
      await appendNativeResult(scope, {
        parent,
        ordinal: input.callOrdinal,
        sourceStepId: step.stepId,
        status: 'succeeded',
        result,
      });
      const trace = await scope.query((transaction) =>
        transaction.query.agentTraces.findFirst({
          where: eq(agentTraces.id, input.claimed.traceId),
        }),
      );
      const skillIds = Array.isArray(trace?.skillIds)
        ? trace.skillIds.filter((item): item is string => typeof item === 'string')
        : [];
      if (!skillIds.includes(input.skillId)) {
        await scope.query((transaction) =>
          transaction
            .update(agentTraces)
            .set({ skillIds: [...skillIds, input.skillId] })
            .where(eq(agentTraces.id, input.claimed.traceId)),
        );
      }
      if (!input.finishActivity) return { eventSeq: null };
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: scope.turnId,
        eventType: 'turn.activity_finished',
        payload: {
          turn_id: scope.turnId,
          agent_trace_id: input.claimed.traceId,
          activity_id: input.llmStepId,
          activity_type: 'knowledge_loading',
          display_summary: '正在加载专业知识',
          status: 'succeeded',
        },
      });
      return { eventSeq: event.eventSeq };
    });
  }

  async finishToolFailure(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    callOrdinal: number;
    skillId?: string;
    toolName: string;
    callPositionKey: string;
    toolFingerprint: string;
    argsHash: string;
    errorCode: string;
    diagnosticCode: string;
    errorKey: string;
    progressHash: string;
    callCount: number;
  }): Promise<{ eventSeq: number } | null> {
    return withNativeTurnWrite(this.database, input, async (scope) => {
      const parent = await readToolCall(scope, input);
      if (
        await replayToolReceipt(scope, {
          ...input,
          parent,
          status: 'rejected',
          result: { public_error_code: input.errorCode },
        })
      )
        return { eventSeq: 0 };
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: 1,
          update: { outputSummary: { outcome: 'tool_calls', call_count: input.callCount } },
        }),
      );
      const failedStep: TraceStepInput = {
        stepType: 'tool_call',
        actor: 'tool',
        toolName: input.toolName,
        callPositionKey: input.callPositionKey,
        toolFingerprint: input.toolFingerprint,
        argsHash: input.argsHash,
        inputSummary: { action: 'load_skill' },
        outputSummary: {
          outcome: 'failed',
          diagnostic: { code: input.diagnosticCode },
          error_key: input.errorKey,
          progress_hash: input.progressHash,
        },
        status: 'failed',
        errorCode: input.errorCode,
      };
      if (input.skillId) failedStep.skillId = input.skillId;
      const step = await appendTraceStepWithQuery(scope.query, input.claimed.traceId, failedStep);
      await appendNativeResult(scope, {
        parent,
        ordinal: input.callOrdinal,
        sourceStepId: step.stepId,
        status: 'rejected',
        result: { public_error_code: input.errorCode },
        closeRemaining: true,
      });
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: scope.turnId,
        eventType: 'turn.activity_finished',
        payload: {
          turn_id: scope.turnId,
          agent_trace_id: input.claimed.traceId,
          activity_id: input.llmStepId,
          activity_type: 'knowledge_loading',
          display_summary: '正在加载专业知识',
          status: 'failed',
          public_error_code: input.errorCode,
        },
      });
      return { eventSeq: event.eventSeq };
    });
  }

  /**
   * Close a Brain tool batch that violates the batch-shape policy (mixed tool classes, unknown
   * tool, or over the per-response call cap) without terminating the turn: the semantic batch is
   * closed with a rejected result (remaining members `not_executed`), a bounded diagnostic step is
   * recorded, and the caller feeds a bounded observation back to the next model round.
   */
  async recordIllegalToolBatch(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    errorCode: string;
    callCount: number;
    errorKey: string;
    progressHash: string;
    repairAttempt: number;
  }): Promise<boolean> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      const rejection = await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'observation',
        actor: 'system',
        inputSummary: { policy: 'tool_batch_shape' },
        outputSummary: {
          policy: 'tool_batch_shape',
          outcome: 'tool_batch_rejected',
          call_count: input.callCount,
          error_key: input.errorKey,
          progress_hash: input.progressHash,
          repair_attempt: input.repairAttempt,
        },
        status: 'failed',
        errorCode: input.errorCode,
      });
      await rejectNativePendingCalls(scope, {
        errorCode: input.errorCode,
        sourceStepId: rejection.stepId,
        llmStepId: input.llmStepId,
      });
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: { outputSummary: { outcome: 'tool_calls', call_count: input.callCount } },
        }),
      );
      await appendTranscriptRuntimePolicyContext(scope, {
        stepId: rejection.stepId,
        outcome: {
          type: 'illegal_tool_batch',
          error_code: 'AGENT_TOOL_NOT_ALLOWED',
          call_count: input.callCount,
        },
        repairAttempt: input.repairAttempt,
        contracts: nativeTranscriptContracts,
      });
      return true;
    });
  }

  async startKnowledgeActivity(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    activityId: string;
  }): Promise<{ eventSeq: number } | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return null;
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.activity_started',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          activity_id: input.activityId,
          activity_type: 'knowledge_loading',
          display_summary: '正在加载专业知识',
          status: 'started',
        },
      });
      return { eventSeq: event.eventSeq };
    });
  }

  async finishKnowledgeActivity(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    activityId: string;
    publicErrorCode: string;
    status: 'failed' | 'blocked';
  }): Promise<{ eventSeq: number } | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return null;
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.activity_finished',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          activity_id: input.activityId,
          activity_type: 'knowledge_loading',
          display_summary: '正在加载专业知识',
          status: input.status,
          public_error_code: input.publicErrorCode,
        },
      });
      return { eventSeq: event.eventSeq };
    });
  }
}

async function readToolCall(
  scope: AgentTranscriptWriteScope,
  input: {
    llmStepId: string;
    callOrdinal: number;
    callCount: number;
    toolName: string;
    argsHash: string;
    callPositionKey: string;
  },
): Promise<AgentTranscriptItem> {
  const parent = await readNativeModelOutput(scope, input.llmStepId);
  const payload = parent.payload_json;
  if (
    payload.type !== 'assistant_output' ||
    payload.mode !== 'tools' ||
    payload.calls.length !== input.callCount
  )
    return scope.abort();
  const call = payload.calls[input.callOrdinal];
  if (!call || call.name !== input.toolName || call.arguments_digest !== input.argsHash)
    return scope.abort();
  const step = await scope.query((tx) =>
    tx.query.agentTraceSteps.findFirst({
      where: eq(agentTraceSteps.id, input.llmStepId),
      columns: { stepNo: true },
    }),
  );
  if (
    !step ||
    callPositionKey({
      turnId: scope.turnId,
      continuationNo: scope.continuationNo,
      llmStepNo: step.stepNo,
      callIndex: input.callOrdinal,
    }) !== input.callPositionKey
  )
    return scope.abort();
  return parent;
}

async function replayToolReceipt(
  scope: AgentTranscriptWriteScope,
  input: {
    claimed: ClaimedAgentTurn;
    parent: AgentTranscriptItem;
    callOrdinal: number;
    toolName: string;
    toolFingerprint: string;
    callPositionKey: string;
    argsHash: string;
    status: 'succeeded' | 'rejected';
    result: unknown;
  },
) {
  const receipt = await readNativeResult(scope, input.parent, input.callOrdinal);
  if (!receipt) return false;
  const payload = receipt.payload_json;
  if (
    payload.type !== 'tool_result' ||
    payload.result.type !== 'inline' ||
    payload.status !== input.status ||
    canonicalSha256(payload.result.value) !== canonicalSha256(input.result)
  )
    return scope.abort();
  const step = await scope.query((tx) =>
    tx.query.agentTraceSteps.findFirst({
      where: and(
        eq(agentTraceSteps.id, receipt.source_trace_step_id!),
        eq(agentTraceSteps.traceId, input.claimed.traceId),
      ),
    }),
  );
  if (
    !step ||
    step.stepType !== 'tool_call' ||
    step.actor !== 'tool' ||
    step.toolName !== input.toolName ||
    step.argsHash !== input.argsHash ||
    step.toolFingerprint !== input.toolFingerprint ||
    step.callPositionKey !== input.callPositionKey ||
    step.status !== (input.status === 'succeeded' ? 'succeeded' : 'failed')
  )
    return scope.abort();
  if (input.status === 'rejected' && input.parent.payload_json.type === 'assistant_output') {
    for (
      let ordinal = input.callOrdinal + 1;
      ordinal < input.parent.payload_json.calls.length;
      ordinal += 1
    ) {
      const remaining = await readNativeResult(scope, input.parent, ordinal);
      if (
        remaining?.payload_json.type !== 'tool_result' ||
        remaining.payload_json.status !== 'not_executed' ||
        remaining.source_trace_step_id !== step.id
      )
        return scope.abort();
    }
  }
  return true;
}
