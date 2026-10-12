import {
  agentTraces,
  agentTraceSteps,
  agentTurnConfirmations,
  agentTurns,
  and,
  artifacts,
  asc,
  assets,
  chatMessages,
  chatSessions,
  eq,
  inArray,
  productFactSets,
  products,
  tasks,
  type Database,
} from '@ecom-forge/db';
import { agentConfirmedFactDependencySchema } from '@ecom-forge/agent';
import {
  AGENT_IMAGE_FAILURES,
  canonicalSha256,
  type AgentPublicSummary,
  type AgentGuardrailType,
} from '@ecom-forge/shared';

import {
  appendOutboxEventInTransaction,
  appendOutboxEventWithQuery,
} from '../database/outbox.repository.js';
import { appendTraceStepWithQuery, splitPublicText } from './agent-turn.repository-helpers.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';
import { compareWorkflowArtifactOrder } from './workflow-artifact-order.js';
import { recordModelStepDiagnostic } from './agent-model-step-diagnostic.js';
import {
  appendNativeTerminalReceipt,
  readNativeCandidatePlan,
  readNativeModelOutput,
  rejectNativePendingCalls,
  replayNativeTerminalReceipt,
  withNativeTurnWrite,
} from './agent-transcript-results.js';
import type { AgentTranscriptWriteScope } from './agent-transcript-write-transaction.js';
import { resolveSessionCreativeDirection } from './session-creative-direction.js';

function extractCreativeNote(paramsSnapshot: unknown): string | null {
  if (!paramsSnapshot || typeof paramsSnapshot !== 'object') return null;
  const value = (paramsSnapshot as Record<string, unknown>).creative_note;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 600) : null;
}

export function buildArtifactAttachments(
  taskRows: readonly { id: string; paramsSnapshot: unknown }[],
  artifactRows: readonly { id: string; taskId: string }[],
) {
  const noteByTaskId = new Map(
    taskRows.map((task) => [task.id, extractCreativeNote(task.paramsSnapshot)]),
  );
  return artifactRows.map((artifact, position) => {
    const creativeNote = noteByTaskId.get(artifact.taskId);
    return {
      kind: 'artifact' as const,
      object_id: artifact.id,
      role: 'other' as const,
      position,
      ...(creativeNote ? { creative_note: creativeNote } : {}),
    };
  });
}

export async function publishNativeResponseInScope(
  scope: AgentTranscriptWriteScope,
  turn: typeof agentTurns.$inferSelect,
  input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    text: string;
    mode?: 'respond' | 'chat_text';
  },
): Promise<{ eventSeq: number }> {
  const output = await readNativeModelOutput(scope, input.llmStepId);
  if (input.mode === 'chat_text') {
    if (
      output.payload_json.type !== 'assistant_output' ||
      output.payload_json.mode !== 'text' ||
      output.payload_json.text !== input.text
    )
      return scope.abort();
  } else {
    const payload = output.payload_json;
    if (payload.type !== 'assistant_output' || payload.mode !== 'terminal') return scope.abort();
    const call = payload.calls[0];
    if (
      payload.calls.length !== 1 ||
      call?.name !== 'agent_respond@1' ||
      call.arguments.type !== 'inline' ||
      canonicalSha256(call.arguments.value) !== canonicalSha256({ text: input.text })
    )
      return scope.abort();
  }
  const [message] = await scope.query((transaction) =>
    transaction
      .insert(chatMessages)
      .values({
        sessionId: turn.sessionId,
        turnId: turn.id,
        role: 'assistant',
        content: input.text,
        attachments: [],
      })
      .returning({ id: chatMessages.id }),
  );
  if (!message) throw new Error('Agent response message insert returned no row');
  if (input.mode !== 'chat_text') {
    await appendNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', {
      type: 'message_published',
      message_id: message.id,
      content_digest: canonicalSha256({ text: input.text }),
    });
  }
  await scope.query((transaction) =>
    recordModelStepDiagnostic(transaction, {
      ...input,
      transcriptCaptureVersion: turn.transcriptCaptureVersion,
      update: { outputSummary: { outcome: input.mode ?? 'respond', message_id: message.id } },
    }),
  );
  await scope.query((transaction) =>
    transaction
      .update(agentTraces)
      .set({ status: 'succeeded', endedAt: new Date() })
      .where(eq(agentTraces.id, input.claimed.traceId)),
  );
  const chunks = splitPublicText(input.text);
  for (const [index, delta] of chunks.entries()) {
    await appendOutboxEventWithQuery(scope.query, {
      scopeType: 'turn',
      scopeId: turn.id,
      eventType: 'turn.message_delta',
      payload: {
        turn_id: turn.id,
        agent_trace_id: input.claimed.traceId,
        message_id: message.id,
        delta_seq: index + 1,
        text_delta: delta,
        is_final: index === chunks.length - 1,
      },
    });
  }
  await appendOutboxEventWithQuery(scope.query, {
    scopeType: 'turn',
    scopeId: turn.id,
    eventType: 'turn.status_changed',
    payload: {
      turn_id: turn.id,
      agent_trace_id: input.claimed.traceId,
      previous_user_status: 'thinking',
      user_status: 'completed',
    },
  });
  const completed = await appendOutboxEventWithQuery(scope.query, {
    scopeType: 'turn',
    scopeId: turn.id,
    eventType: 'turn.completed',
    payload: {
      turn_id: turn.id,
      agent_trace_id: input.claimed.traceId,
      message_id: message.id,
      user_status: 'completed',
    },
  });
  const [updated] = await scope.query((transaction) =>
    transaction
      .update(agentTurns)
      .set({
        status: 'done',
        revision: turn.revision + 1,
        processingOwner: null,
        processingLeaseExpiresAt: null,
        endedAt: new Date(),
      })
      .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
      .returning({ id: agentTurns.id }),
  );
  if (!updated) throw new Error('AGENT_TURN_TERMINAL_CAS_FAILED');
  return { eventSeq: completed.eventSeq };
}

export class AgentTurnTerminalRepository {
  constructor(private readonly database: Database) {}

  async completeResponse(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    text: string;
    mode?: 'respond' | 'chat_text';
  }): Promise<{ eventSeq: number } | null> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      return publishNativeResponseInScope(scope, turn, input);
    });
  }

  /**
   * Workflow 终态（settlement 事务内）把已提交的 Agent turn 推向终态。
   * 只处理仍处于 waiting_provider_confirmation 的 turn，保证重放幂等；
   * 其余状态（用户中断、guardrail 阻断等）由各自路径负责终态。
   */
  async completeForWorkflowOutcome(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: { workflowRunId: string; outcome: 'succeeded' | 'failed' },
  ): Promise<{ turnId: string; eventSeq: number } | null> {
    // `05` unified lock order: locate the owning session without a lock, take the session lock,
    // then lock the turn. A turn-first order here could ring against API turn creation and the
    // transcript write transactions, which both lock the session before the turn.
    const [probe] = await transaction
      .select({ sessionId: agentTurns.sessionId })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.workflowRunId, input.workflowRunId),
          eq(agentTurns.status, 'waiting_provider_confirmation'),
        ),
      )
      .limit(1);
    if (!probe) return null;
    const [sessionFence] = await transaction
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.id, probe.sessionId))
      .for('no key update');
    if (!sessionFence) return null;
    const [turn] = await transaction
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.workflowRunId, input.workflowRunId),
          eq(agentTurns.status, 'waiting_provider_confirmation'),
        ),
      )
      .for('update')
      .limit(1);
    if (!turn) return null;

    const [trace] = await transaction
      .select({ id: agentTraces.id })
      .from(agentTraces)
      .where(eq(agentTraces.turnId, turn.id))
      .limit(1);
    const traceId = trace?.id ?? null;

    const workflowTaskRows = await transaction
      .select({
        id: tasks.id,
        paramsSnapshot: tasks.paramsSnapshot,
        createdAt: tasks.createdAt,
        errorCode: tasks.errorCode,
      })
      .from(tasks)
      .where(eq(tasks.workflowRunId, input.workflowRunId))
      .orderBy(asc(tasks.createdAt), asc(tasks.id));
    const workflowTaskIds = workflowTaskRows.map((row) => row.id);
    const publishedArtifacts =
      workflowTaskIds.length > 0
        ? await transaction.query.artifacts.findMany({
            where: and(
              inArray(artifacts.taskId, workflowTaskIds),
              inArray(artifacts.visibility, ['private', 'shared', 'public']),
            ),
            columns: { id: true, taskId: true, metaJson: true, createdAt: true },
          })
        : [];
    const taskCreatedAtById = new Map(
      workflowTaskRows.map((task) => [task.id, task.createdAt] as const),
    );
    publishedArtifacts.sort((left, right) =>
      compareWorkflowArtifactOrder(
        {
          ...left,
          taskCreatedAt: taskCreatedAtById.get(left.taskId) ?? left.createdAt,
        },
        {
          ...right,
          taskCreatedAt: taskCreatedAtById.get(right.taskId) ?? right.createdAt,
        },
      ),
    );
    const hasDeliveredArtifacts = publishedArtifacts.length > 0;
    const userOutcome =
      input.outcome === 'succeeded' || hasDeliveredArtifacts ? 'succeeded' : 'failed';
    const imageFailure = workflowTaskRows.some(
      (task) => task.errorCode === 'PROVIDER_OUTCOME_UNKNOWN_EXPIRED',
    )
      ? AGENT_IMAGE_FAILURES.unknownReleased
      : AGENT_IMAGE_FAILURES.failed;

    const text =
      input.outcome === 'succeeded'
        ? publishedArtifacts.length > 0
          ? `已生成 ${publishedArtifacts.length} 张图片。`
          : '图片已生成。'
        : publishedArtifacts.length > 0
          ? `已生成 ${publishedArtifacts.length} 张图片，其他图片未能完成；未完成部分的积分已退回。`
          : imageFailure.summary;
    const [message] = await transaction
      .insert(chatMessages)
      .values({
        sessionId: turn.sessionId,
        turnId: turn.id,
        role: 'assistant',
        content: text,
        attachments: buildArtifactAttachments(workflowTaskRows, publishedArtifacts),
      })
      .returning({ id: chatMessages.id });
    if (!message) throw new Error('Workflow outcome message insert returned no row');

    const now = new Date();
    if (traceId) {
      await transaction
        .update(agentTraces)
        .set({
          status: userOutcome === 'succeeded' ? 'succeeded' : 'failed',
          endedAt: now,
        })
        .where(eq(agentTraces.id, traceId));
    }

    const chunks = splitPublicText(text);
    for (const [index, delta] of chunks.entries()) {
      await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.message_delta',
        payload: {
          turn_id: turn.id,
          agent_trace_id: traceId,
          message_id: message.id,
          delta_seq: index + 1,
          text_delta: delta,
          is_final: index === chunks.length - 1,
        },
      });
    }
    await appendOutboxEventInTransaction(transaction, {
      scopeType: 'turn',
      scopeId: turn.id,
      eventType: 'turn.status_changed',
      payload: {
        turn_id: turn.id,
        agent_trace_id: traceId,
        previous_user_status: 'thinking',
        user_status: userOutcome === 'succeeded' ? 'completed' : 'failed',
      },
    });
    const terminal = await appendOutboxEventInTransaction(transaction, {
      scopeType: 'turn',
      scopeId: turn.id,
      eventType: userOutcome === 'succeeded' ? 'turn.completed' : 'turn.failed',
      payload: {
        turn_id: turn.id,
        agent_trace_id: traceId,
        ...(userOutcome === 'succeeded'
          ? { message_id: message.id, user_status: 'completed' as const }
          : {
              ...imageFailure,
              user_status: 'failed' as const,
            }),
      },
    });
    const [updated] = await transaction
      .update(agentTurns)
      .set({
        status: userOutcome === 'succeeded' ? 'done' : 'failed',
        revision: turn.revision + 1,
        processingOwner: null,
        processingLeaseExpiresAt: null,
        endedAt: now,
      })
      .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
      .returning({ id: agentTurns.id });
    if (!updated) throw new Error('AGENT_TURN_TERMINAL_CAS_FAILED');
    return { turnId: turn.id, eventSeq: terminal.eventSeq };
  }

  async recordPublicTextRejection(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    rule: string;
  }): Promise<boolean> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      const result = { public_error_code: 'AGENT_PUBLIC_TEXT_REJECTED' };
      if (await replayNativeTerminalReceipt(scope, input.llmStepId, 'rejected', result))
        return true;
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'rejected', result);
      await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'guardrail',
        actor: 'system',
        inputSummary: { guardrail_type: 'public_text_policy' },
        outputSummary: { action: 'repair_requested', rule: input.rule },
        status: 'failed',
        errorCode: 'AGENT_PUBLIC_TEXT_REJECTED',
      });
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: {
            status: 'failed',
            errorCode: 'AGENT_PUBLIC_TEXT_REJECTED',
            outputSummary: { outcome: 'rejected', rule: input.rule },
          },
        }),
      );
      return true;
    });
  }

  async recordKnowledgeRequirement(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    missingSkillIds: string[];
    errorKey: string;
    progressHash: string;
  }): Promise<boolean> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      const result = { public_error_code: 'AGENT_SKILL_KNOWLEDGE_REQUIRED' };
      if (await replayNativeTerminalReceipt(scope, input.llmStepId, 'rejected', result))
        return true;
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'rejected', result);
      await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'observation',
        actor: 'system',
        inputSummary: { policy: 'skill_knowledge_before_terminal' },
        outputSummary: {
          outcome: 'knowledge_required',
          missing_skill_ids: input.missingSkillIds,
          error_key: input.errorKey,
          progress_hash: input.progressHash,
        },
        status: 'failed',
        errorCode: 'AGENT_SKILL_KNOWLEDGE_REQUIRED',
      });
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: {
            status: 'failed',
            errorCode: 'AGENT_SKILL_KNOWLEDGE_REQUIRED',
            outputSummary: {
              outcome: 'rejected',
              reason: 'skill_knowledge_required',
            },
          },
        }),
      );
      return true;
    });
  }

  async recordProductFactsUnavailable(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    sourceBindingKey: string;
    errorKey: string;
    progressHash: string;
  }): Promise<boolean> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      const result = { public_error_code: 'REFERENCE_NOT_AVAILABLE' };
      if (await replayNativeTerminalReceipt(scope, input.llmStepId, 'rejected', result))
        return true;
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'rejected', result);
      await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'observation',
        actor: 'system',
        inputSummary: { policy: 'product_facts_requires_product_binding' },
        outputSummary: {
          outcome: 'reference_unavailable',
          source_binding_key: input.sourceBindingKey,
          error_key: input.errorKey,
          progress_hash: input.progressHash,
        },
        status: 'failed',
        errorCode: 'REFERENCE_NOT_AVAILABLE',
      });
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: {
            status: 'failed',
            errorCode: 'REFERENCE_NOT_AVAILABLE',
            outputSummary: {
              outcome: 'rejected',
              reason: 'source_binding_not_product',
            },
          },
        }),
      );
      return true;
    });
  }

  async beginAuthoring(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
  }): Promise<boolean> {
    let resolved: ClaimedAgentTurn['sessionCreativeDirection'];
    const accepted = await withNativeTurnWrite(this.database, input, async (scope) => {
      const parent = await readNativeModelOutput(scope, input.llmStepId);
      if (
        parent.payload_json.type !== 'assistant_output' ||
        parent.payload_json.mode !== 'terminal' ||
        parent.payload_json.calls[0]?.name !== 'agent_candidate_plan@1'
      )
        return scope.abort();
      const result = {
        type: 'authoring_required',
        plan_digest: parent.payload_json.calls[0].arguments_digest,
      };
      resolved = await resolveSessionCreativeDirection(
        scope,
        input.claimed,
        await readNativeCandidatePlan(scope, input.llmStepId),
        input.llmStepId,
      );
      if (await replayNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', result))
        return true;
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', result);
      return true;
    });
    if (accepted && resolved) input.claimed.sessionCreativeDirection = resolved;
    return accepted;
  }

  async saveAuthoringBatch(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
  }): Promise<boolean> {
    return withNativeTurnWrite(this.database, input, async (scope) => {
      const parent = await readNativeModelOutput(scope, input.llmStepId);
      if (
        parent.payload_json.type !== 'assistant_output' ||
        parent.payload_json.mode !== 'terminal' ||
        parent.payload_json.calls[0]?.name !== 'agent_author_prompts@1'
      )
        return scope.abort();
      const result = {
        type: 'authoring_batch_saved',
        arguments_digest: parent.payload_json.calls[0].arguments_digest,
      };
      if (await replayNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', result))
        return true;
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', result);
      return true;
    });
  }

  async requestClarification(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    question: string;
    suggestions: string[];
    scopeDigest?: string;
  }): Promise<{ eventSeq: number } | null> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      const existing = await scope.query((transaction) =>
        transaction.query.agentTurnConfirmations.findMany({
          where: eq(agentTurnConfirmations.turnId, turn.id),
        }),
      );
      const confirmationNo = existing.length + 1;
      const publicPayload = {
        schema_version: 1,
        question: input.question,
        options: input.suggestions.map((label, index) => ({ id: `option-${index + 1}`, label })),
        allow_free_text: input.scopeDigest === undefined,
        max_response_chars: 2000,
        ...(input.scopeDigest ? { scope_digest: input.scopeDigest } : {}),
      };
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const [confirmation] = await scope.query((transaction) =>
        transaction
          .insert(agentTurnConfirmations)
          .values({
            turnId: turn.id,
            userId: turn.userId,
            confirmationNo,
            type: 'clarification',
            answerSchemaVersion: 1,
            publicPayloadJson: publicPayload,
            payloadDigest: canonicalSha256(publicPayload),
            expiresAt,
          })
          .returning({ id: agentTurnConfirmations.id }),
      );
      if (!confirmation) throw new Error('Agent confirmation insert returned no row');
      await appendNativeTerminalReceipt(
        scope,
        input.llmStepId,
        'succeeded',
        input.scopeDigest
          ? {
              type: 'scope_confirmation_requested',
              confirmation_id: confirmation.id,
              payload_digest: canonicalSha256(publicPayload),
              scope_digest: input.scopeDigest,
            }
          : {
              type: 'confirmation_requested',
              confirmation_id: confirmation.id,
              payload_digest: canonicalSha256(publicPayload),
            },
      );
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: {
            outputSummary: { outcome: 'request_clarification', confirmation_id: confirmation.id },
          },
        }),
      );
      await scope.query((transaction) =>
        transaction.insert(chatMessages).values({
          sessionId: turn.sessionId,
          turnId: turn.id,
          role: 'assistant',
          content: input.question,
          attachments: [],
          pendingApproval: { confirmation_id: confirmation.id },
        }),
      );
      await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          previous_user_status: 'thinking',
          user_status: 'waiting_for_you',
        },
      });
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.confirmation_required',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          confirmation_id: confirmation.id,
          confirmation_type: 'clarification',
          confirmation_version: 1,
          public_payload: publicPayload,
          expires_at: expiresAt.toISOString(),
          user_status: 'waiting_for_you',
        },
      });
      const [updated] = await scope.query((transaction) =>
        transaction
          .update(agentTurns)
          .set({
            status: 'waiting_user_confirmation',
            revision: turn.revision + 1,
            processingOwner: null,
            processingLeaseExpiresAt: null,
          })
          .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
          .returning({ id: agentTurns.id }),
      );
      if (!updated) throw new Error('AGENT_TURN_CONFIRMATION_CAS_FAILED');
      return { eventSeq: event.eventSeq };
    });
  }

  async requestProductFacts(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    sourceBindingKey: string;
    candidateFacts: {
      product_name: string;
      primary_colors: string[];
      logos: string[];
      visible_text: string[];
      materials: string[];
      must_preserve: string[];
      unknown_fields: string[];
    };
    evidenceDigest: string;
  }): Promise<
    { status: 'ready'; factSetId: string } | { status: 'requested'; eventSeq: number } | null
  > {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      const binding = input.claimed.attachments.find(
        (item) =>
          item.binding_key === input.sourceBindingKey &&
          item.kind === 'asset' &&
          item.role === 'product',
      );
      if (!binding) throw new Error('REFERENCE_NOT_AVAILABLE');
      const [source] = await scope.query((transaction) =>
        transaction
          .select()
          .from(assets)
          .where(and(eq(assets.id, binding.object_id), eq(assets.userId, turn.userId)))
          .for('update'),
      );
      if (
        !source ||
        source.status !== 'ready' ||
        !source.contentHash ||
        source.contentHash !== binding.content_hash ||
        source.contentHash !== binding.object_version
      ) {
        throw new Error('REFERENCE_NOT_AVAILABLE');
      }
      let product: typeof products.$inferSelect | undefined;
      if (source.productId) {
        const sourceProductId = source.productId;
        [product] = await scope.query((transaction) =>
          transaction
            .select()
            .from(products)
            .where(and(eq(products.id, sourceProductId), eq(products.userId, turn.userId)))
            .for('update'),
        );
        if (!product || product.status !== 'active') throw new Error('REFERENCE_NOT_AVAILABLE');
        if (product.latestFactSetId) {
          const productId = product.id;
          const factSetId = product.latestFactSetId;
          const factSet = await scope.query((transaction) =>
            transaction.query.productFactSets.findFirst({
              where: and(
                eq(productFactSets.id, factSetId),
                eq(productFactSets.productId, productId),
                eq(productFactSets.userId, turn.userId),
              ),
            }),
          );
          if (!factSet) throw new Error('REFERENCE_NOT_AVAILABLE');
          const result = {
            type: 'facts_already_confirmed',
            dependency: agentConfirmedFactDependencySchema.parse({
              kind: 'product_fact_set',
              object_id: factSet.id,
              object_version: String(factSet.versionNo),
              content_hash: canonicalSha256(factSet.factsJson),
              owner_user_id: turn.userId,
              product_id: product.id,
              source_asset_id: factSet.sourceAssetId,
              source_version: factSet.sourceVersion,
            }),
          };
          if (!(await replayNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', result)))
            await appendNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', result);
          return { status: 'ready', factSetId: factSet.id };
        }
      }
      const existing = await scope.query((transaction) =>
        transaction.query.agentTurnConfirmations.findMany({
          where: eq(agentTurnConfirmations.turnId, turn.id),
        }),
      );
      const confirmationNo = existing.length + 1;
      const publicPayload = {
        schema_version: 1 as const,
        mode: product ? ('link_product' as const) : ('create_product' as const),
        source_asset_id: source.id,
        source_version: source.contentHash,
        candidate_facts: input.candidateFacts,
        required_fields: ['product_name', 'visible_text'] as const,
        ...(product
          ? {
              product_id: product.id,
              expected_latest_fact_set_id: product.latestFactSetId,
            }
          : {}),
      };
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const [confirmation] = await scope.query((transaction) =>
        transaction
          .insert(agentTurnConfirmations)
          .values({
            turnId: turn.id,
            userId: turn.userId,
            confirmationNo,
            type: 'product_facts',
            answerSchemaVersion: 1,
            publicPayloadJson: publicPayload,
            payloadDigest: canonicalSha256(publicPayload),
            expiresAt,
          })
          .returning({ id: agentTurnConfirmations.id }),
      );
      if (!confirmation) throw new Error('Agent product facts confirmation insert returned no row');
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', {
        type: 'confirmation_requested',
        confirmation_id: confirmation.id,
        payload_digest: canonicalSha256(publicPayload),
      });
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: {
            outputSummary: {
              outcome: 'product_facts_required',
              confirmation_id: confirmation.id,
              evidence_digest: input.evidenceDigest,
            },
          },
        }),
      );
      await scope.query((transaction) =>
        transaction.insert(chatMessages).values({
          sessionId: turn.sessionId,
          turnId: turn.id,
          role: 'assistant',
          content: '请确认商品事实后继续生成。',
          attachments: [],
          pendingApproval: { confirmation_id: confirmation.id },
        }),
      );
      await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          previous_user_status: 'thinking',
          user_status: 'waiting_for_you',
        },
      });
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.confirmation_required',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          confirmation_id: confirmation.id,
          confirmation_type: 'product_facts',
          confirmation_version: 1,
          public_payload: publicPayload,
          expires_at: expiresAt.toISOString(),
          user_status: 'waiting_for_you',
        },
      });
      const [updated] = await scope.query((transaction) =>
        transaction
          .update(agentTurns)
          .set({
            status: 'waiting_user_confirmation',
            revision: turn.revision + 1,
            processingOwner: null,
            processingLeaseExpiresAt: null,
          })
          .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
          .returning({ id: agentTurns.id }),
      );
      if (!updated) throw new Error('AGENT_TURN_PRODUCT_FACTS_CAS_FAILED');
      return { status: 'requested', eventSeq: event.eventSeq };
    });
  }

  async block(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId?: string;
    errorCode: string;
    summary: AgentPublicSummary;
    guardrailType?: AgentGuardrailType;
  }): Promise<{ eventSeq: number } | null> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      if (input.llmStepId) {
        const llmStepId = input.llmStepId;
        await scope.query((transaction) =>
          transaction
            .update(agentTraceSteps)
            .set({
              status: 'blocked',
              errorCode: input.errorCode,
              outputSummary: { outcome: 'blocked' },
            })
            .where(and(eq(agentTraceSteps.id, llmStepId), eq(agentTraceSteps.status, 'started'))),
        );
      }
      const diagnostic = await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'guardrail',
        actor: 'system',
        inputSummary: { guardrail_type: input.guardrailType ?? 'runtime_policy' },
        outputSummary: { action: 'stopped' },
        status: 'blocked',
        errorCode: input.errorCode,
      });
      await rejectNativePendingCalls(scope, {
        errorCode: input.errorCode,
        sourceStepId: diagnostic.stepId,
        ...(input.llmStepId ? { llmStepId: input.llmStepId } : {}),
      });
      await scope.query((transaction) =>
        transaction
          .update(agentTraces)
          .set({
            status: 'blocked',
            loopGuardrailHit: input.guardrailType ?? input.errorCode,
            endedAt: new Date(),
          })
          .where(eq(agentTraces.id, input.claimed.traceId)),
      );
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: input.guardrailType ? 'turn.guardrail_triggered' : 'turn.failed',
        payload: input.guardrailType
          ? {
              turn_id: turn.id,
              agent_trace_id: input.claimed.traceId,
              guardrail_type: input.guardrailType,
              action: 'stopped',
              summary: input.summary,
              user_status: 'failed',
            }
          : {
              turn_id: turn.id,
              agent_trace_id: input.claimed.traceId,
              public_error_code: input.errorCode,
              summary: input.summary,
              user_status: 'failed',
            },
      });
      const [updated] = await scope.query((transaction) =>
        transaction
          .update(agentTurns)
          .set({
            status: 'blocked',
            revision: turn.revision + 1,
            processingOwner: null,
            processingLeaseExpiresAt: null,
            endedAt: new Date(),
          })
          .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
          .returning({ id: agentTurns.id }),
      );
      if (!updated) throw new Error('AGENT_TURN_TERMINAL_CAS_FAILED');
      return { eventSeq: event.eventSeq };
    });
  }
}
