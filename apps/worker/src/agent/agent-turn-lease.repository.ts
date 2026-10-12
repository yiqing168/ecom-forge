import { randomUUID } from 'node:crypto';

import {
  agentBrainModelSnapshotSchema,
  persistedAgentTranscriptSummarySchema,
  type AgentBrainStepInput,
  type LoopState,
} from '@ecom-forge/agent';
import {
  agentTraces,
  agentTraceSteps,
  agentTurns,
  and,
  chatMessages,
  chatSessions,
  eq,
  eventOutbox,
  gt,
  inArray,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256, parseSessionCreativeDirectionSnapshot } from '@ecom-forge/shared';
import type { SkillSelectionSnapshot } from '@ecom-forge/skills';
import {
  agentModelSelectionSnapshotSchema,
  attachmentSnapshotSchema,
  executionAuthorizationSchema,
  generationPreferencesSchema,
} from '@ecom-forge/compiler';
import { z } from 'zod';

import { appendOutboxEventInTransaction } from '../database/outbox.repository.js';
import { MAX_MODEL_OUTPUT_REPAIRS } from './agent-transcript-policy-context.js';
import { appendTraceStep, lockOwnedTurn } from './agent-turn.repository-helpers.js';
import { sessionImageCandidatesSchema } from './agent-session-image-candidate.service.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';

export class AgentTurnLeaseRepository {
  constructor(private readonly database: Database) {}

  async activeLeaseRetryAt(input: {
    turnId: string;
    sessionId: string;
    continuationNo: number;
    now: Date;
  }): Promise<Date | null> {
    const turn = await this.database.query.agentTurns.findFirst({
      where: and(
        eq(agentTurns.id, input.turnId),
        eq(agentTurns.sessionId, input.sessionId),
        eq(agentTurns.continuationNo, input.continuationNo),
      ),
      columns: {
        status: true,
        runQuoteId: true,
        workflowRunId: true,
        processingOwner: true,
        processingLeaseExpiresAt: true,
      },
    });
    if (
      !turn?.processingOwner ||
      !turn.processingLeaseExpiresAt ||
      turn.processingLeaseExpiresAt.getTime() <= input.now.getTime() ||
      turn.runQuoteId !== null ||
      turn.workflowRunId !== null ||
      [
        'done',
        'blocked',
        'failed',
        'cancelled',
        'superseded',
        'waiting_user_confirmation',
      ].includes(turn.status)
    ) {
      return null;
    }
    return turn.processingLeaseExpiresAt;
  }

  async claim(input: {
    turnId: string;
    sessionId: string;
    traceId: string;
    userMessageId: string;
    continuationNo: number;
    payloadRevision: number;
    leaseMs: number;
    now: Date;
  }): Promise<ClaimedAgentTurn | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await transaction
        .select()
        .from(agentTurns)
        .where(eq(agentTurns.id, input.turnId))
        .for('update');
      if (!turn) return null;
      if (
        turn.sessionId !== input.sessionId ||
        turn.continuationNo > input.continuationNo ||
        [
          'done',
          'blocked',
          'failed',
          'cancelled',
          'superseded',
          'waiting_user_confirmation',
        ].includes(turn.status) ||
        turn.runQuoteId !== null ||
        turn.workflowRunId !== null
      ) {
        return null;
      }
      if (
        turn.continuationNo < input.continuationNo ||
        (turn.continuationNo === input.continuationNo && turn.revision < input.payloadRevision)
      ) {
        throw new Error('AGENT_QUEUE_PAYLOAD_FUTURE');
      }
      if (turn.executionFormat !== 'transcript_v1' || turn.transcriptCaptureVersion !== 1)
        throw new Error('TURN_STATE_INVALID');
      if (
        turn.processingOwner &&
        turn.processingLeaseExpiresAt &&
        turn.processingLeaseExpiresAt.getTime() > input.now.getTime()
      ) {
        return null;
      }
      const trace = await transaction.query.agentTraces.findFirst({
        where: and(eq(agentTraces.id, input.traceId), eq(agentTraces.turnId, turn.id)),
      });
      const message = await transaction.query.chatMessages.findFirst({
        where: and(
          eq(chatMessages.id, input.userMessageId),
          eq(chatMessages.turnId, turn.id),
          eq(chatMessages.sessionId, turn.sessionId),
          eq(chatMessages.role, 'user'),
        ),
      });
      const initialUserMessage = await transaction.query.chatMessages.findFirst({
        where: and(
          eq(chatMessages.turnId, turn.id),
          eq(chatMessages.sessionId, turn.sessionId),
          eq(chatMessages.role, 'user'),
        ),
        orderBy: (table, { asc: orderAsc }) => [orderAsc(table.createdAt), orderAsc(table.id)],
      });
      if (
        !trace ||
        !message ||
        !initialUserMessage ||
        trace.sessionId !== turn.sessionId ||
        trace.userId !== turn.userId ||
        !turn.skillSelectionSnapshotHash ||
        !turn.executionAuthorizationHash ||
        canonicalSha256(turn.skillSelectionSnapshotJson) !== turn.skillSelectionSnapshotHash ||
        canonicalSha256(turn.executionAuthorizationJson) !== turn.executionAuthorizationHash
      ) {
        throw new Error('AGENT_QUEUE_OWNERSHIP_INVALID');
      }
      const selection = turn.skillSelectionSnapshotJson as SkillSelectionSnapshot;
      if (
        !Array.isArray(selection.required_capabilities) ||
        selection.required_capabilities.some((capability) => typeof capability !== 'string') ||
        new Set(selection.required_capabilities).size !== selection.required_capabilities.length ||
        [...selection.required_capabilities]
          .sort()
          .some((capability, index) => capability !== selection.required_capabilities[index])
      ) {
        throw new Error('SKILL_VERSION_DRIFT');
      }
      const activityEvents = await transaction.query.eventOutbox.findMany({
        where: and(
          eq(eventOutbox.scopeType, 'turn'),
          eq(eventOutbox.scopeId, turn.id),
          inArray(eventOutbox.eventType, ['turn.activity_started', 'turn.activity_finished']),
        ),
        orderBy: (table, { asc: orderAsc }) => [orderAsc(table.eventSeq)],
      });
      const openActivities = recoverOpenActivities(activityEvents, turn.id, trace.id);
      const hasModelSelection =
        turn.modelSelectionSnapshotJson !== null && turn.modelSelectionSnapshotHash !== null;
      const hasGenerationPreferences =
        turn.generationPreferencesJson !== null && turn.generationPreferencesHash !== null;
      if (
        !hasModelSelection ||
        !hasGenerationPreferences ||
        canonicalSha256(turn.modelSelectionSnapshotJson) !== turn.modelSelectionSnapshotHash ||
        canonicalSha256(turn.generationPreferencesJson) !== turn.generationPreferencesHash
      ) {
        throw new Error('AGENT_QUEUE_OWNERSHIP_INVALID');
      }
      const modelSelection = agentModelSelectionSnapshotSchema.parse(
        turn.modelSelectionSnapshotJson,
      );
      const generationPreferences = generationPreferencesSchema.parse(
        turn.generationPreferencesJson,
      );
      const requiredGenerationCapabilities = [modelSelection.image.selected_operation];
      const owner = randomUUID();
      const revision = turn.revision + 1;
      const [claimed] = await transaction
        .update(agentTurns)
        .set({
          processingOwner: owner,
          processingLeaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
          revision,
          status: 'loading_context',
        })
        .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
        .returning({ id: agentTurns.id });
      if (!claimed) return null;
      for (const activity of openActivities) {
        await appendOutboxEventInTransaction(transaction, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.activity_finished',
          payload: {
            turn_id: turn.id,
            agent_trace_id: trace.id,
            activity_id: activity.activity_id,
            activity_type: activity.activity_type,
            display_summary: activity.display_summary,
            status: 'cancelled',
          },
        });
      }
      const abandonedModelSteps = await transaction
        .update(agentTraceSteps)
        .set({
          status: 'failed',
          errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN',
          outputSummary: { outcome: 'unknown' },
        })
        .where(
          and(
            eq(agentTraceSteps.traceId, trace.id),
            eq(agentTraceSteps.stepType, 'llm_call'),
            eq(agentTraceSteps.status, 'started'),
          ),
        )
        .returning({ id: agentTraceSteps.id });
      for (const step of abandonedModelSteps) {
        await appendOutboxEventInTransaction(transaction, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.response_draft_cleared',
          payload: { turn_id: turn.id, agent_trace_id: trace.id, step_id: step.id },
        });
      }
      const session = await transaction.query.chatSessions.findFirst({
        where: and(eq(chatSessions.id, turn.sessionId), eq(chatSessions.userId, turn.userId)),
      });
      if (!session) throw new Error('AGENT_SESSION_MISSING');
      const sessionCreativeDirection =
        session.creativeDirectionSnapshotJson === null
          ? undefined
          : parseSessionCreativeDirectionSnapshot(session.creativeDirectionSnapshotJson);
      if (
        sessionCreativeDirection === null ||
        (sessionCreativeDirection &&
          canonicalSha256(sessionCreativeDirection) !== session.creativeDirectionSnapshotHash)
      ) {
        throw new Error('AGENT_SESSION_CREATIVE_DIRECTION_INVALID');
      }
      const firstSessionTurn = await transaction.query.agentTurns.findFirst({
        where: eq(agentTurns.sessionId, turn.sessionId),
        orderBy: (table, { asc: orderAsc }) => [orderAsc(table.createdAt), orderAsc(table.id)],
        columns: { id: true },
      });
      if (!firstSessionTurn) throw new Error('AGENT_SESSION_TURN_MISSING');
      const parsedTranscriptSummary = persistedAgentTranscriptSummarySchema.safeParse(
        session.summaryJson,
      );
      if (
        (session.summaryVersion === 0 &&
          (session.summaryThroughTurnId !== null ||
            canonicalSha256(session.summaryJson) !== canonicalSha256({}))) ||
        (session.summaryVersion > 0 &&
          (!parsedTranscriptSummary.success ||
            parsedTranscriptSummary.data.summary_version !== session.summaryVersion ||
            parsedTranscriptSummary.data.history_generation !==
              session.transcriptGeneration.toString() ||
            parsedTranscriptSummary.data.source_turn_ids.at(-1) !== session.summaryThroughTurnId))
      ) {
        throw new Error('AGENT_SESSION_SUMMARY_INVALID');
      }
      const currentSummary = parsedTranscriptSummary.success
        ? parsedTranscriptSummary.data
        : undefined;
      const contextSnapshot = asRecord(turn.contextSnapshotJson);
      if (turn.contextSnapshotJson !== null) {
        const snapshot = contextSnapshot;
        const snapshotSummaryVersion = snapshot.session_summary_version;
        const snapshotSummaryHash = snapshot.session_summary_hash;
        const currentSummaryHash = currentSummary ? canonicalSha256(currentSummary) : null;
        if (
          snapshotSummaryVersion !== session.summaryVersion ||
          snapshotSummaryHash !== currentSummaryHash
        ) {
          throw new Error('AGENT_SESSION_SUMMARY_CHECKPOINT_DRIFT');
        }
      }
      if (session.summaryThroughTurnId) {
        const coveredTurn = await transaction.query.agentTurns.findFirst({
          where: and(
            eq(agentTurns.id, session.summaryThroughTurnId),
            eq(agentTurns.sessionId, turn.sessionId),
          ),
        });
        if (
          !coveredTurn?.endedAt ||
          !['done', 'blocked', 'failed', 'cancelled', 'superseded'].includes(coveredTurn.status)
        ) {
          throw new Error('AGENT_SESSION_SUMMARY_BOUNDARY_INVALID');
        }
      }
      const steps = await transaction.query.agentTraceSteps.findMany({
        where: eq(agentTraceSteps.traceId, trace.id),
        orderBy: (table, { asc: orderAsc }) => [orderAsc(table.stepNo)],
      });
      const recovered = recoverLoopState(turn.contextSnapshotJson, steps);
      const sessionImageCandidates = sessionImageCandidatesSchema.parse(
        contextSnapshot.session_image_candidates ?? [],
      );
      if (
        contextSnapshot.session_image_candidates_unavailable !== undefined &&
        (typeof contextSnapshot.session_image_candidates_unavailable !== 'boolean' ||
          (contextSnapshot.session_image_candidates_unavailable &&
            sessionImageCandidates.length > 0))
      )
        throw new Error('AGENT_SESSION_IMAGE_CANDIDATE_SNAPSHOT_INVALID');
      if (
        contextSnapshot.session_image_candidates !== undefined &&
        contextSnapshot.session_image_candidates_hash !== canonicalSha256(sessionImageCandidates)
      ) {
        throw new Error('AGENT_SESSION_IMAGE_CANDIDATE_SNAPSHOT_INVALID');
      }
      return {
        turnId: turn.id,
        sessionId: turn.sessionId,
        traceId: trace.id,
        userMessageId: message.id,
        userId: turn.userId,
        continuationNo: turn.continuationNo,
        revision,
        owner,
        message: message.content,
        attachments: z
          .array(attachmentSnapshotSchema)
          .max(12)
          .parse(initialUserMessage.attachments),
        sessionImageCandidates,
        sessionImageCandidatesUnavailable:
          contextSnapshot.session_image_candidates_unavailable === true,
        ...(currentSummary ? { transcriptSummary: currentSummary } : {}),
        sessionSummaryVersion: session.summaryVersion,
        selection,
        selectionHash: turn.skillSelectionSnapshotHash,
        requiredGenerationCapabilities,
        executionAuthorization: executionAuthorizationSchema.parse(turn.executionAuthorizationJson),
        executionAuthorizationHash: turn.executionAuthorizationHash,
        modelSelection,
        modelSelectionHash: turn.modelSelectionSnapshotHash,
        generationPreferences,
        generationPreferencesHash: turn.generationPreferencesHash,
        ...(sessionCreativeDirection ? { sessionCreativeDirection } : {}),
        loopState: recovered.loopState,
        observations: recovered.observations,
        materializedImageBindingKeys: [],
        materializedImageDetails: {},
        inputTokenTotal: trace.inputTokenTotal,
        outputTokenTotal: trace.outputTokenTotal,
        contextInitialized: turn.contextSnapshotJson !== null,
        executionFormat: turn.executionFormat,
        transcriptCaptureVersion: turn.transcriptCaptureVersion,
        transcriptGeneration: session.transcriptGeneration.toString(),
        isFirstSessionTurn: firstSessionTurn.id === turn.id,
        loadedResourceSnapshotIds: readResourceSnapshotIds(turn.contextSnapshotJson),
        publicTextRejections: steps.filter(
          (step) =>
            ['guardrail', 'llm_call'].includes(step.stepType) &&
            step.errorCode === 'AGENT_PUBLIC_TEXT_REJECTED',
        ).length,
        consecutiveBrainDeliveryFailures: recoverConsecutiveBrainDeliveryFailures(steps),
        lastBrainCallOutcomeUnknown: recoverLastBrainCallOutcomeUnknown(steps),
        lastBrainCallBudgetExceeded: recoverLastBrainCallBudgetExceeded(steps),
        modelSnapshot: agentBrainModelSnapshotSchema.parse(trace.brainModelSnapshotJson),
      };
    });
  }

  async renew(input: {
    turnId: string;
    owner: string;
    revision: number;
    now: Date;
    leaseMs: number;
  }): Promise<number | null> {
    const [updated] = await this.database
      .update(agentTurns)
      .set({
        revision: input.revision + 1,
        processingLeaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
      })
      .where(
        and(
          eq(agentTurns.id, input.turnId),
          eq(agentTurns.processingOwner, input.owner),
          eq(agentTurns.revision, input.revision),
          gt(agentTurns.processingLeaseExpiresAt, input.now),
        ),
      )
      .returning({ revision: agentTurns.revision });
    return updated?.revision ?? null;
  }

  async releaseForRetry(input: { claimed: ClaimedAgentTurn; revision: number }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return false;
      const [released] = await transaction
        .update(agentTurns)
        .set({
          processingOwner: null,
          processingLeaseExpiresAt: null,
          revision: turn.revision + 1,
        })
        .where(
          and(
            eq(agentTurns.id, input.claimed.turnId),
            eq(agentTurns.processingOwner, input.claimed.owner),
            eq(agentTurns.revision, input.revision),
            eq(agentTurns.continuationNo, input.claimed.continuationNo),
          ),
        )
        .returning({ id: agentTurns.id });
      return Boolean(released);
    });
  }

  async persistContext(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    contextSnapshot: Record<string, unknown>;
    preloaded: Array<{
      skillId: string;
      resourceId: string;
      resourceHash: string;
      tokenCount: number;
    }>;
    projectKnowledgeLoading: boolean;
  }): Promise<{ revision: number; eventSeq: number | null } | null> {
    return this.database.transaction(async (transaction) => {
      const [turn] = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return null;
      const candidates = sessionImageCandidatesSchema.parse(
        input.contextSnapshot.session_image_candidates ?? [],
      );
      if (
        input.contextSnapshot.session_image_candidates_unavailable !== undefined &&
        (typeof input.contextSnapshot.session_image_candidates_unavailable !== 'boolean' ||
          (input.contextSnapshot.session_image_candidates_unavailable && candidates.length > 0))
      )
        throw new Error('AGENT_SESSION_IMAGE_CANDIDATE_SNAPSHOT_INVALID');
      if (
        (input.contextSnapshot.session_image_candidates !== undefined ||
          input.contextSnapshot.session_image_candidates_hash !== undefined) &&
        input.contextSnapshot.session_image_candidates_hash !== canonicalSha256(candidates)
      ) {
        throw new Error('AGENT_SESSION_IMAGE_CANDIDATE_SNAPSHOT_INVALID');
      }
      const activityId = input.projectKnowledgeLoading ? randomUUID() : null;
      if (activityId) {
        await appendOutboxEventInTransaction(transaction, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.activity_started',
          payload: {
            turn_id: turn.id,
            agent_trace_id: input.claimed.traceId,
            activity_id: activityId,
            activity_type: 'knowledge_loading',
            display_summary: '正在加载专业知识',
            status: 'started',
          },
        });
      }
      for (const resource of input.preloaded) {
        await appendTraceStep(transaction, input.claimed.traceId, {
          stepType: 'observation',
          actor: 'system',
          skillId: resource.skillId,
          inputSummary: { action: 'skill_preload', resource_snapshot_id: resource.resourceId },
          outputSummary: {
            resource_hash: resource.resourceHash,
            token_count: resource.tokenCount,
          },
          status: 'succeeded',
        });
      }
      const preloadedSkillIds = [...new Set(input.preloaded.map((resource) => resource.skillId))];
      await transaction
        .update(agentTraces)
        .set({ skillIds: preloadedSkillIds })
        .where(eq(agentTraces.id, input.claimed.traceId));
      const revision = turn.revision + 1;
      const [updated] = await transaction
        .update(agentTurns)
        .set({
          status: 'detecting_intent',
          revision,
          contextSnapshotJson: input.contextSnapshot,
          contextSnapshotHash: canonicalSha256(input.contextSnapshot),
        })
        .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
        .returning({ id: agentTurns.id });
      if (!updated) return null;
      if (activityId) {
        const event = await appendOutboxEventInTransaction(transaction, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.activity_finished',
          payload: {
            turn_id: turn.id,
            agent_trace_id: input.claimed.traceId,
            activity_id: activityId,
            activity_type: 'knowledge_loading',
            display_summary: '正在加载专业知识',
            status: 'succeeded',
          },
        });
        return { revision, eventSeq: event.eventSeq };
      }
      return { revision, eventSeq: null };
    });
  }
}

type RecoveredStep = Pick<
  typeof agentTraceSteps.$inferSelect,
  | 'stepType'
  | 'status'
  | 'toolName'
  | 'toolFingerprint'
  | 'inputSummary'
  | 'outputSummary'
  | 'errorCode'
>;

export function recoverConsecutiveBrainDeliveryFailures(steps: RecoveredStep[]): number {
  let failures = 0;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.stepType !== 'llm_call') continue;
    if (
      asRecord(step.outputSummary).outcome === 'unknown' ||
      asRecord(step.outputSummary).outcome === 'not_dispatched' ||
      step.errorCode === 'AGENT_CALL_OUTCOME_UNKNOWN' ||
      step.errorCode === 'AGENT_CALL_NOT_DISPATCHED'
    ) {
      failures += 1;
      continue;
    }
    break;
  }
  return failures;
}

export function recoverLastBrainCallOutcomeUnknown(steps: RecoveredStep[]): boolean {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.stepType !== 'llm_call') continue;
    return (
      asRecord(step.outputSummary).outcome === 'unknown' ||
      step.errorCode === 'AGENT_CALL_OUTCOME_UNKNOWN'
    );
  }
  return false;
}

export function recoverLastBrainCallBudgetExceeded(steps: RecoveredStep[]): boolean {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (!step || step.stepType !== 'llm_call') continue;
    return (
      asRecord(step.outputSummary).outcome === 'chat_text_budget_rejected' &&
      step.errorCode === 'AGENT_BUDGET_EXCEEDED'
    );
  }
  return false;
}

const activityBaseSchema = z
  .object({
    turn_id: z.uuid(),
    agent_trace_id: z.uuid(),
    activity_id: z.uuid(),
    activity_type: z.enum([
      'knowledge_loading',
      'context_reading',
      'plan_preparing',
      'safety_checking',
    ]),
    display_summary: z.enum([
      '正在加载专业知识',
      '正在理解你的需求',
      '正在分析参考图片',
      '正在继续思考',
      // Historical turns must remain recoverable.
      '正在读取已授权的上下文',
      '正在准备方案',
      '正在检查安全与权限',
    ]),
  })
  .strict();
const startedActivitySchema = activityBaseSchema.extend({ status: z.literal('started') }).strict();
const finishedActivitySchema = activityBaseSchema
  .extend({
    status: z.enum(['succeeded', 'failed', 'blocked', 'cancelled']),
    public_error_code: z.string().optional(),
  })
  .strict();

const activitySummariesByType = {
  knowledge_loading: ['正在加载专业知识'],
  context_reading: [
    '正在理解你的需求',
    '正在分析参考图片',
    '正在继续思考',
    '正在读取已授权的上下文',
  ],
  plan_preparing: ['正在准备方案'],
  safety_checking: ['正在检查安全与权限'],
} as const;

function activitySummaryMatchesType(activity: z.infer<typeof activityBaseSchema>): boolean {
  const allowed: readonly string[] = activitySummariesByType[activity.activity_type];
  return allowed.includes(activity.display_summary);
}

function recoverOpenActivities(
  events: Array<{ eventType: string; payload: unknown }>,
  turnId: string,
  traceId: string,
) {
  const activities = new Map<string, z.infer<typeof startedActivitySchema>>();
  for (const event of events) {
    if (event.eventType === 'turn.activity_started') {
      const activity = startedActivitySchema.parse(event.payload);
      if (
        activity.turn_id !== turnId ||
        activity.agent_trace_id !== traceId ||
        !activitySummaryMatchesType(activity) ||
        activities.has(activity.activity_id)
      ) {
        throw new Error('AGENT_ACTIVITY_RECOVERY_INVALID');
      }
      activities.set(activity.activity_id, activity);
      continue;
    }
    const finished = finishedActivitySchema.parse(event.payload);
    const started = activities.get(finished.activity_id);
    if (
      finished.turn_id !== turnId ||
      finished.agent_trace_id !== traceId ||
      !started ||
      !activitySummaryMatchesType(finished) ||
      started.activity_type !== finished.activity_type ||
      started.display_summary !== finished.display_summary
    ) {
      throw new Error('AGENT_ACTIVITY_RECOVERY_INVALID');
    }
    activities.delete(finished.activity_id);
  }
  return [...activities.values()];
}

function recoverLoopState(
  contextSnapshot: unknown,
  steps: RecoveredStep[],
): {
  loopState: LoopState;
  observations: AgentBrainStepInput['observations'];
} {
  const initialResourceIds = readResourceSnapshotIds(contextSnapshot);
  const loadedResourceIds = new Set(initialResourceIds);
  const loopState: LoopState = {
    rounds: steps.filter((step) => step.stepType === 'llm_call').length,
    toolCalls: 0,
    fingerprintExecutions: new Map(),
    consecutiveNoProgress: 0,
    consecutiveErrorCount: 0,
    progressHash: progressHash(loadedResourceIds),
  };
  const observations: AgentBrainStepInput['observations'] = [];

  for (const step of steps) {
    if (
      step.stepType === 'llm_call' &&
      step.status === 'failed' &&
      step.errorCode === 'AGENT_BRAIN_TOOL_INPUT_INVALID'
    ) {
      const diagnostic = asRecord(asRecord(step.outputSummary).diagnostic);
      observations.push({
        tool_name: 'runtime_policy@1',
        status: 'failed',
        summary: {
          public_error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
          tool: readString(diagnostic.tool) ?? 'unknown',
          paths: readStringArray(diagnostic.paths),
          retryable: true,
        },
      });
      continue;
    }
    if (
      step.stepType === 'llm_call' &&
      step.status === 'failed' &&
      step.errorCode === 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID'
    ) {
      const diagnostic = asRecord(asRecord(step.outputSummary).diagnostic);
      observations.push({
        tool_name: 'runtime_policy@1',
        status: 'failed',
        summary: {
          public_error_code: 'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
          reason: readString(diagnostic.reason) ?? 'free_text_without_tool_call',
          paths: readStringArray(diagnostic.paths),
          retryable: true,
        },
      });
      continue;
    }
    if (
      step.stepType === 'observation' &&
      step.status === 'failed' &&
      step.errorCode === 'AGENT_SKILL_KNOWLEDGE_REQUIRED'
    ) {
      const output = asRecord(step.outputSummary);
      const missingSkillIds = readStringArray(output.missing_skill_ids);
      const persistedProgressHash =
        readString(output.progress_hash) ?? progressHash(loadedResourceIds);
      const errorKey = readString(output.error_key);
      loopState.consecutiveNoProgress =
        loopState.progressHash === persistedProgressHash ? loopState.consecutiveNoProgress + 1 : 0;
      const previousErrorKey = loopState.consecutiveErrorKey;
      if (errorKey) loopState.consecutiveErrorKey = errorKey;
      else delete loopState.consecutiveErrorKey;
      loopState.consecutiveErrorCount = errorKey
        ? previousErrorKey === errorKey
          ? loopState.consecutiveErrorCount + 1
          : 1
        : 0;
      loopState.progressHash = persistedProgressHash;
      observations.push({
        tool_name: 'runtime_policy@1',
        status: 'failed',
        summary: {
          public_error_code: 'AGENT_SKILL_KNOWLEDGE_REQUIRED',
          missing_skill_ids: missingSkillIds,
        },
      });
      continue;
    }
    if (
      step.stepType === 'observation' &&
      step.status === 'failed' &&
      step.errorCode === 'AGENT_TOOL_NOT_ALLOWED'
    ) {
      const output = asRecord(step.outputSummary);
      const repairAttempt = readInteger(output.repair_attempt) ?? MAX_MODEL_OUTPUT_REPAIRS + 1;
      observations.push({
        tool_name: 'runtime_policy@1',
        status: 'failed',
        summary: {
          public_error_code: 'AGENT_TOOL_NOT_ALLOWED',
          call_count: readInteger(output.call_count) ?? 1,
          retryable: repairAttempt <= MAX_MODEL_OUTPUT_REPAIRS,
          repair_attempt: repairAttempt,
          remaining_repair_attempts: Math.max(0, MAX_MODEL_OUTPUT_REPAIRS - repairAttempt + 1),
          required_action: 'return_one_allowed_tool_class_or_a_single_terminal_action',
        },
      });
      continue;
    }
    if (step.stepType !== 'tool_call' || !['succeeded', 'failed'].includes(step.status)) continue;
    const output = asRecord(step.outputSummary);
    for (const resourceId of readStringArray(output.resource_snapshot_ids)) {
      loadedResourceIds.add(resourceId);
    }
    const fingerprint = step.toolFingerprint ?? `missing:${step.toolName ?? 'unknown'}`;
    const persistedProgressHash =
      readString(output.progress_hash) ?? progressHash(loadedResourceIds);
    const errorKey = readString(output.error_key);
    const executions = new Map(loopState.fingerprintExecutions);
    executions.set(fingerprint, (executions.get(fingerprint) ?? 0) + 1);
    loopState.toolCalls += 1;
    loopState.fingerprintExecutions = executions;
    loopState.consecutiveNoProgress =
      loopState.progressHash === persistedProgressHash ? loopState.consecutiveNoProgress + 1 : 0;
    const previousErrorKey = loopState.consecutiveErrorKey;
    if (errorKey) loopState.consecutiveErrorKey = errorKey;
    else delete loopState.consecutiveErrorKey;
    loopState.consecutiveErrorCount = errorKey
      ? previousErrorKey === errorKey
        ? loopState.consecutiveErrorCount + 1
        : 1
      : 0;
    loopState.progressHash = persistedProgressHash;
    observations.push({
      tool_name: step.toolName ?? 'unknown@1',
      status: step.status as 'succeeded' | 'failed',
      summary: publicObservationSummary(output, step.errorCode),
    });
  }
  return {
    loopState,
    observations,
  };
}

function readResourceSnapshotIds(value: unknown): string[] {
  const record = asRecord(value);
  if (!Array.isArray(record.resource_snapshots)) return [];
  return record.resource_snapshots.flatMap((item) => {
    const id = readString(asRecord(item).resource_snapshot_id);
    return id ? [id] : [];
  });
}

function progressHash(resourceIds: ReadonlySet<string>): string {
  return canonicalSha256({ loaded_resource_snapshot_ids: [...resourceIds].sort() });
}

function publicObservationSummary(
  output: Record<string, unknown>,
  errorCode: string | null,
): Record<string, unknown> {
  return {
    view: output.view,
    already_loaded: output.already_loaded,
    resource_snapshot_ids: readStringArray(output.resource_snapshot_ids),
    public_error_code: errorCode ?? undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
