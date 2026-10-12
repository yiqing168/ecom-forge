import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  agentTraceSteps,
  agentTraces,
  agentTranscriptItems,
  agentTurns,
  and,
  chatSessions,
  eq,
  max,
  sql,
  type Database,
} from '@ecom-forge/db';
import {
  addMoney,
  canonicalSha256,
  canonicalJson,
  compareMoney,
  scopedAdvisoryLockKey,
  subtractMoney,
} from '@ecom-forge/shared';
import {
  persistedAgentTranscriptSummarySchema,
  validatePublicText,
  type AgentBrainDiagnostic,
  type AgentBrainModelSnapshot,
  type AgentBrainStepOutcome,
  type AgentSessionCompactionOutcome,
  type PersistedAgentTranscriptSummary,
} from '@ecom-forge/agent';
import { calculateAgentBrainActualCost } from '@ecom-forge/provider';

import { emitTranscriptMetric } from './agent-transcript-metrics.js';
import { publishCommentaryInScope } from './agent-commentary.js';
import {
  readTranscriptSummarySource,
  verifyTranscriptSummarySource,
} from './agent-transcript-summary-source.js';
import type { ClaimedAgentTurn } from './agent-turn.repository.js';
import {
  captureTranscriptModelOutput,
  verifySettledTranscriptModelOutput,
  verifyTranscriptReservedInput,
  type TranscriptModelCapture,
} from './agent-transcript-model-capture.js';
import {
  appendTranscriptRuntimePolicyContext,
  MAX_MODEL_OUTPUT_REPAIRS,
  MAX_PUBLIC_TEXT_REPAIRS,
} from './agent-transcript-policy-context.js';
import { prepareTranscriptModelInputBinding } from './agent-transcript-model-binding.js';
import {
  AgentTranscriptWriteTransactions,
  withTranscriptQueryBudget,
  type AgentTranscriptWriteScope,
} from './agent-transcript-write-transaction.js';
import { publishNativeResponseInScope } from './agent-turn-terminal.repository.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface ReservedLlmStep {
  stepId: string;
  stepNo: number;
  exposureCost: string;
}

/**
 * Digest of a model-output outcome for transcript verification.
 *
 * The optional `detail` is EXCLUDED on purpose: it is bounded repair feedback that echoes the
 * rejected model arguments, and the transcript read path rebuilds the outcome from the stored
 * item without it. A digest that covered `detail` could therefore never verify, which made
 * every repairable model error unreadable and stalled the repair round.
 */
export function transcriptOutcomeDigest(outcome: AgentBrainStepOutcome): string {
  const rest: Record<string, unknown> = { ...outcome };
  delete rest.detail;
  return canonicalSha256(rest);
}

export class AgentLlmCostRepository {
  constructor(private readonly database: Database) {}

  async reserve(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    round: number;
    modelSnapshot: AgentBrainModelSnapshot;
    exposureCost: string;
    turnBudgetCost: string;
    requestedInputTokens: number;
    requestedMaxOutputTokens: number;
    purpose?: 'agent_step' | 'session_compaction';
    transcript?: TranscriptModelCapture;
    /**
     * Native (`transcript_v1`) fence for a `session_compaction` reservation that has no transcript
     * capture. It routes the write through the same bounded, generation-fenced transcript
     * transaction as normal native steps, so a compaction never observes a changed history.
     */
    nativeFence?: { expectedGeneration: string };
  }): Promise<{ kind: 'reserved'; step: ReservedLlmStep } | { kind: 'budget_exceeded' } | null> {
    return withLlmWrite(this.database, input, async (query, turn) => {
      const [trace] = await query((transaction) =>
        transaction.select().from(agentTraces).where(ownedTrace(input.claimed)).for('update'),
      );
      if (!trace) throw new Error('AGENT_TRACE_MISSING');
      const nextBudgetUsed = addMoney(trace.estimatedCost, trace.reservedCost, input.exposureCost);
      if (compareMoney(nextBudgetUsed, input.turnBudgetCost) > 0) {
        return { kind: 'budget_exceeded' };
      }
      await query((transaction) =>
        transaction.execute(
          sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-trace', trace.id)})`,
        ),
      );
      const [current] = await query((transaction) =>
        transaction
          .select({ stepNo: max(agentTraceSteps.stepNo) })
          .from(agentTraceSteps)
          .where(eq(agentTraceSteps.traceId, trace.id)),
      );
      const stepNo = (current?.stepNo ?? 0) + 1;
      const stepId = randomUUID();
      const [step] = await query((transaction) =>
        transaction
          .insert(agentTraceSteps)
          .values({
            id: stepId,
            traceId: trace.id,
            stepNo,
            stepType: 'llm_call',
            actor: 'agent',
            inputSummary: {
              round: input.round,
              purpose: input.purpose ?? 'agent_step',
              continuation_no: turn.continuationNo,
              requested_input_tokens: input.requestedInputTokens,
              requested_max_output_tokens: input.requestedMaxOutputTokens,
              ...(input.claimed.generationPreferences?.creative_direction
                ? {
                    creative_direction: input.claimed.generationPreferences.creative_direction,
                    creative_direction_hash: canonicalSha256(
                      input.claimed.generationPreferences.creative_direction,
                    ),
                  }
                : {}),
              reserved_exposure_cost_cny: input.exposureCost,
              ...(input.transcript
                ? {
                    transcript_phase: input.transcript.phase,
                    transcript_input: prepareTranscriptModelInputBinding(
                      {
                        step_id: stepId,
                        continuation_no: turn.continuationNo,
                        resource_dependencies: input.transcript.resourceDependencies,
                      },
                      input.transcript.contracts.resourceDependencySchema,
                    ),
                  }
                : {}),
            },
            outputSummary: {},
            status: 'started',
            estimatedCost: input.exposureCost,
            modelSnapshotId: input.modelSnapshot.snapshot_id,
            modelSnapshotJson: input.modelSnapshot,
          })
          .returning({ stepId: agentTraceSteps.id }),
      );
      if (!step) throw new Error('Agent LLM step insert returned no row');
      await query((transaction) =>
        transaction
          .update(agentTraces)
          .set({ reservedCost: addMoney(trace.reservedCost, input.exposureCost) })
          .where(eq(agentTraces.id, trace.id)),
      );
      return {
        kind: 'reserved',
        step: { stepId: step.stepId, stepNo, exposureCost: input.exposureCost },
      };
    });
  }

  async settle(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    step: ReservedLlmStep;
    outcome: AgentBrainStepOutcome;
    modelSnapshot: AgentBrainModelSnapshot;
    turnBudgetCost: string;
    transcript: TranscriptModelCapture;
    maxOutputTokenTotal?: number;
    /** Worker has already validated the public text and required Skill knowledge. */
    publishRespond?: boolean;
    commentaryProtectedTexts?: readonly string[];
  }): Promise<{ budgetExceeded: boolean; pricingDrift: boolean; eventSeq?: number } | null> {
    const commentary = input.outcome.type === 'tool_calls' ? input.outcome.commentary : undefined;
    if (
      commentary &&
      (!input.commentaryProtectedTexts ||
        input.maxOutputTokenTotal === undefined ||
        !validatePublicText(commentary, input.commentaryProtectedTexts).ok)
    )
      throw new Error('AGENT_COMMENTARY_POLICY_REQUIRED');
    return withLlmWrite(this.database, input, async (query, turn, scope) => {
      const [trace] = await query((transaction) =>
        transaction.select().from(agentTraces).where(ownedTrace(input.claimed)).for('update'),
      );
      if (!trace) throw new Error('AGENT_TRACE_MISSING');
      const step = await query((transaction) =>
        transaction.query.agentTraceSteps.findFirst({
          where: and(
            eq(agentTraceSteps.id, input.step.stepId),
            eq(agentTraceSteps.traceId, trace.id),
          ),
        }),
      );
      const reservation = z
        .object({ reserved_exposure_cost_cny: z.string() })
        .safeParse(step?.inputSummary);
      if (
        !step ||
        !reservation.success ||
        step.stepNo !== input.step.stepNo ||
        step.actor !== 'agent' ||
        step.stepType !== 'llm_call' ||
        canonicalSha256(step.modelSnapshotJson) !== canonicalSha256(input.modelSnapshot) ||
        reservation.data.reserved_exposure_cost_cny !== input.step.exposureCost
      )
        throw new Error('AGENT_TRANSCRIPT_MODEL_SETTLEMENT_DRIFT');
      verifyTranscriptReservedInput(
        step.id,
        scope.continuationNo,
        step.inputSummary,
        input.transcript,
      );
      const receipt = z
        .object({ transcript_outcome_digest: z.string().regex(/^[a-f0-9]{64}$/) })
        .safeParse(step.outputSummary);
      if (
        step.status !== 'started' &&
        (!receipt.success ||
          receipt.data.transcript_outcome_digest !== transcriptOutcomeDigest(input.outcome) ||
          canonicalJson(step.tokenUsageJson) !== canonicalJson(input.outcome.usage))
      )
        throw new Error('AGENT_TRANSCRIPT_MODEL_SETTLEMENT_DRIFT');
      if (step.status !== 'started') {
        if (
          input.outcome.type === 'chat_text' &&
          step.status === 'failed' &&
          step.errorCode === 'AGENT_BUDGET_EXCEEDED' &&
          (step.outputSummary as Record<string, unknown>).outcome === 'chat_text_budget_rejected'
        ) {
          const row = await query((tx) =>
            tx.query.agentTranscriptItems.findFirst({
              where: and(
                eq(agentTranscriptItems.turnId, turn.id),
                eq(agentTranscriptItems.sourceKey, `model:${step.id}:output`),
              ),
            }),
          );
          if (row) throw new Error('AGENT_TRANSCRIPT_MODEL_OUTPUT_DRIFT');
          return null;
        }
        await verifySettledTranscriptModelOutput(scope, {
          step,
          outcome: input.outcome,
          capture: input.transcript,
        });
        return null;
      }
      const actualCost = calculateAgentBrainActualCost({
        pricing: input.modelSnapshot.pricing,
        inputTokens: input.outcome.usage.input_tokens,
        ...(input.outcome.usage.cached_input_tokens !== undefined
          ? { cachedInputTokens: input.outcome.usage.cached_input_tokens }
          : {}),
        outputTokens: input.outcome.usage.output_tokens,
      });
      const reservedCost = subtractMoney(trace.reservedCost, input.step.exposureCost);
      if (compareMoney(reservedCost, '0.00') < 0) throw new Error('AGENT_COST_RESERVATION_DRIFT');
      const estimatedCost = addMoney(trace.estimatedCost, actualCost);
      const budgetExceeded =
        compareMoney(addMoney(estimatedCost, reservedCost), input.turnBudgetCost) > 0;
      const pricingDrift = compareMoney(actualCost, input.step.exposureCost) > 0;
      if (input.outcome.type === 'chat_text' && input.maxOutputTokenTotal === undefined)
        throw new Error('AGENT_OUTPUT_TOKEN_BUDGET_MISSING');
      const tokenExceeded =
        (input.outcome.type === 'chat_text' ||
          input.outcome.type === 'respond' ||
          Boolean(commentary)) &&
        input.maxOutputTokenTotal !== undefined &&
        trace.outputTokenTotal + input.outcome.usage.output_tokens > input.maxOutputTokenTotal;
      const rejectChatText =
        input.outcome.type === 'chat_text' && (budgetExceeded || pricingDrift || tokenExceeded);
      const captured = rejectChatText
        ? null
        : await captureTranscriptModelOutput(scope, {
            step,
            outcome: input.outcome,
            capture: input.transcript,
          });
      const invalidModelOutput =
        input.outcome.type === 'invalid_tool_input' ||
        input.outcome.type === 'invalid_terminal_output' ||
        input.outcome.type === 'public_text_rejected';
      let repairAttempt: number | undefined;
      if (invalidModelOutput) {
        const previous = await query((transaction) =>
          transaction.query.agentTraceSteps.findMany({
            where: and(eq(agentTraceSteps.traceId, trace.id), eq(agentTraceSteps.status, 'failed')),
            columns: { errorCode: true, stepType: true },
          }),
        );
        const publicTextRejected = input.outcome.type === 'public_text_rejected';
        repairAttempt =
          previous.filter((candidate) =>
            publicTextRejected
              ? ['llm_call', 'guardrail'].includes(candidate.stepType) &&
                candidate.errorCode === 'AGENT_PUBLIC_TEXT_REJECTED'
              : (candidate.stepType === 'llm_call' &&
                  [
                    'AGENT_BRAIN_TOOL_INPUT_INVALID',
                    'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
                  ].includes(candidate.errorCode ?? '')) ||
                (candidate.stepType === 'observation' &&
                  candidate.errorCode === 'AGENT_TOOL_NOT_ALLOWED'),
          ).length + 1;
        if (
          repairAttempt >
          (publicTextRejected ? MAX_PUBLIC_TEXT_REPAIRS : MAX_MODEL_OUTPUT_REPAIRS) + 1
        )
          throw new Error('AGENT_MODEL_OUTPUT_REPAIR_BUDGET_DRIFT');
      }
      const [updatedStep] = await query((transaction) =>
        transaction
          .update(agentTraceSteps)
          .set({
            status: invalidModelOutput || rejectChatText ? 'failed' : 'succeeded',
            ...(input.outcome.type === 'invalid_tool_input' ||
            input.outcome.type === 'invalid_terminal_output' ||
            input.outcome.type === 'public_text_rejected'
              ? { errorCode: input.outcome.error_code }
              : rejectChatText
                ? { errorCode: 'AGENT_BUDGET_EXCEEDED' }
                : {}),
            outputSummary: {
              outcome: rejectChatText ? 'chat_text_budget_rejected' : input.outcome.type,
              transcript_outcome_digest: transcriptOutcomeDigest(input.outcome),
              ...(captured ? { transcript_output: captured.binding } : {}),
              ...(input.outcome.type === 'public_text_rejected'
                ? {
                    diagnostic: {
                      code: input.outcome.error_code,
                      rule: input.outcome.rule,
                      repair_attempt: repairAttempt,
                    },
                  }
                : input.outcome.type === 'invalid_tool_input'
                  ? {
                      diagnostic: {
                        code: input.outcome.error_code,
                        tool: input.outcome.tool,
                        paths: input.outcome.paths,
                        repair_attempt: repairAttempt,
                        ...(input.outcome.output_diagnostic
                          ? { output_diagnostic: input.outcome.output_diagnostic }
                          : {}),
                        // `detail` echoes the rejected model arguments (user content) and is
                        // deliberately NOT persisted in the trace (`docs/08`); the repair
                        // round receives it through the transcript policy context instead.
                      },
                    }
                  : input.outcome.type === 'invalid_terminal_output'
                    ? {
                        diagnostic: {
                          code: input.outcome.error_code,
                          reason: input.outcome.reason,
                          paths: input.outcome.paths,
                          repair_attempt: repairAttempt,
                          ...(input.outcome.output_diagnostic
                            ? { output_diagnostic: input.outcome.output_diagnostic }
                            : {}),
                        },
                      }
                    : {}),
            },
            tokenUsageJson: input.outcome.usage,
            estimatedCost: actualCost,
          })
          .where(
            and(
              eq(agentTraceSteps.id, input.step.stepId),
              eq(agentTraceSteps.traceId, trace.id),
              eq(agentTraceSteps.status, 'started'),
            ),
          )
          .returning({ id: agentTraceSteps.id }),
      );
      if (!updatedStep) return null;
      if (
        input.outcome.type === 'invalid_tool_input' ||
        input.outcome.type === 'invalid_terminal_output' ||
        input.outcome.type === 'public_text_rejected'
      ) {
        await appendTranscriptRuntimePolicyContext(scope, {
          stepId: input.step.stepId,
          outcome: input.outcome,
          repairAttempt: repairAttempt!,
          contracts: input.transcript.contracts,
        });
      }
      await query((transaction) =>
        transaction
          .update(agentTraces)
          .set({
            reservedCost,
            estimatedCost,
            inputTokenTotal: trace.inputTokenTotal + input.outcome.usage.input_tokens,
            outputTokenTotal: trace.outputTokenTotal + input.outcome.usage.output_tokens,
          })
          .where(eq(agentTraces.id, trace.id)),
      );
      if (input.outcome.type === 'chat_text' && !rejectChatText) {
        const published = await publishNativeResponseInScope(scope, turn, {
          claimed: input.claimed,
          revision: input.revision,
          llmStepId: step.id,
          text: input.outcome.text,
          mode: 'chat_text',
        });
        return { budgetExceeded, pricingDrift, eventSeq: published.eventSeq };
      }
      if (
        input.publishRespond &&
        input.outcome.type === 'respond' &&
        !budgetExceeded &&
        !pricingDrift &&
        !tokenExceeded
      ) {
        if (input.maxOutputTokenTotal === undefined)
          throw new Error('AGENT_OUTPUT_TOKEN_BUDGET_MISSING');
        const published = await publishNativeResponseInScope(scope, turn, {
          claimed: input.claimed,
          revision: input.revision,
          llmStepId: step.id,
          text: input.outcome.text,
          mode: 'respond',
        });
        return { budgetExceeded: false, pricingDrift: false, eventSeq: published.eventSeq };
      }
      if (commentary && captured && !budgetExceeded && !pricingDrift && !tokenExceeded) {
        const eventSeq = await publishCommentaryInScope(
          scope,
          captured.item,
          input.claimed.traceId,
        );
        return { budgetExceeded: false, pricingDrift: false, eventSeq };
      }
      return { budgetExceeded: budgetExceeded || tokenExceeded, pricingDrift };
    });
  }

  /**
   * Publish a strict `summary v2` checkpoint for a native (`transcript_v1`) turn.
   *
   * It reuses the exact `chat_sessions` columns as the legacy v1 summary, but guards the write with
   * a CAS on session + expected summary version + expected transcript generation, re-derives the
   * content digest from the real, contiguous covered window (rejecting ID-only or v1-masquerading
   * digests), refreshes the frozen context checkpoint, and advances both `summary_version` and
   * `transcript_generation` so the next read starts from the new bounded window.
   */
  async settleTranscriptSummary(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    step: ReservedLlmStep;
    outcome: AgentSessionCompactionOutcome;
    summary: PersistedAgentTranscriptSummary;
    expectedSummaryVersion: number;
    expectedGeneration: string;
    modelSnapshot: AgentBrainModelSnapshot;
    turnBudgetCost: string;
  }): Promise<{
    budgetExceeded: boolean;
    pricingDrift: boolean;
    transcriptGeneration: string;
    published: boolean;
    currentSummary: PersistedAgentTranscriptSummary | null;
  } | null> {
    const nextGeneration = BigInt(input.expectedGeneration) + 1n;
    // A stale generation prevents publication but must still settle the known model usage.
    return this.database.transaction((transaction) =>
      withTranscriptQueryBudget(transaction, async (query) => {
        if (!(await query((tx) => lockSessionFirst(tx, input.claimed)))) return null;
        const turn = await query((tx) => lockOwnedTurn(tx, input.claimed, input.revision));
        if (!turn) return null;
        if (turn.transcriptCaptureVersion !== 1)
          throw new Error('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
        const checkLease = async () => {
          if (
            !turn.processingLeaseExpiresAt ||
            ![
              'loading_context',
              'detecting_intent',
              'validating_context',
              'clarifying',
              'planning',
              'plan_ready',
            ].includes(turn.status)
          )
            throw new Error('AGENT_SESSION_SUMMARY_TURN_STALE');
          const result = await query((tx) =>
            tx.execute(
              sql`select ${turn.processingLeaseExpiresAt!.toISOString()}::timestamptz > clock_timestamp() as valid`,
            ),
          );
          if (result[0]?.valid !== true) throw new Error('AGENT_SESSION_SUMMARY_TURN_STALE');
        };
        await checkLease();
        if (
          input.summary.summary_version !== input.expectedSummaryVersion + 1 ||
          input.summary.history_generation !== nextGeneration.toString() ||
          canonicalSha256(input.summary.content) !== canonicalSha256(input.outcome.summary) ||
          canonicalSha256(input.summary.usage) !== canonicalSha256(input.outcome.usage) ||
          canonicalSha256(input.summary.model_snapshot) !== canonicalSha256(input.modelSnapshot)
        ) {
          throw new Error('AGENT_SESSION_SUMMARY_SETTLEMENT_INVALID');
        }
        const [trace] = await query((transaction) =>
          transaction.select().from(agentTraces).where(ownedTrace(input.claimed)).for('update'),
        );
        if (!trace) throw new Error('AGENT_TRACE_MISSING');
        const storedSession = await query((tx) =>
          tx.query.chatSessions.findFirst({
            where: and(eq(chatSessions.id, turn.sessionId), eq(chatSessions.userId, turn.userId)),
          }),
        );
        if (!storedSession) throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
        const matchesCheckpoint =
          storedSession.summaryVersion === input.expectedSummaryVersion &&
          storedSession.transcriptGeneration === BigInt(input.expectedGeneration);
        let canPublish = matchesCheckpoint;
        const currentSummary =
          storedSession.summaryVersion > 0
            ? persistedAgentTranscriptSummarySchema.parse(storedSession.summaryJson)
            : null;
        const storedStep = await query((tx) =>
          tx.query.agentTraceSteps.findFirst({
            where: and(
              eq(agentTraceSteps.id, input.step.stepId),
              eq(agentTraceSteps.traceId, trace.id),
            ),
          }),
        );
        const reservation = z
          .object({
            purpose: z.literal('session_compaction'),
            reserved_exposure_cost_cny: z.string(),
            continuation_no: z.number(),
          })
          .safeParse(storedStep?.inputSummary);
        if (
          !storedStep ||
          !reservation.success ||
          storedStep.stepNo !== input.step.stepNo ||
          storedStep.actor !== 'agent' ||
          storedStep.stepType !== 'llm_call' ||
          reservation.data.continuation_no !== turn.continuationNo ||
          reservation.data.reserved_exposure_cost_cny !== input.step.exposureCost ||
          canonicalSha256(storedStep.modelSnapshotJson) !== canonicalSha256(input.modelSnapshot)
        )
          throw new Error('AGENT_SESSION_SUMMARY_SETTLEMENT_INVALID');
        if (storedStep.status !== 'started') {
          const receipt = z
            .object({ checkpoint_digest: z.string() })
            .safeParse(storedStep.outputSummary);
          if (
            storedStep.status !== 'succeeded' ||
            !receipt.success ||
            receipt.data.checkpoint_digest !== canonicalSha256(input.summary) ||
            canonicalSha256(storedStep.tokenUsageJson) !== canonicalSha256(input.outcome.usage)
          )
            throw new Error('AGENT_SESSION_SUMMARY_SETTLEMENT_INVALID');
          return null;
        }
        if (canPublish) {
          if (
            currentSummary &&
            BigInt(input.summary.covered_through_sequence) <=
              BigInt(currentSummary.covered_through_sequence)
          )
            throw new Error('AGENT_SESSION_SUMMARY_SOURCE_INVALID');
          const source = await readTranscriptSummarySource(
            transaction,
            {
              userId: turn.userId,
              sessionId: turn.sessionId,
              activeTurnId: turn.id,
              throughSequence: input.summary.covered_through_sequence,
            },
            (build) => query(() => build()),
          );
          verifyTranscriptSummarySource(input.summary, source);
          canPublish = source.authorized;
        }
        const actualCost = calculateAgentBrainActualCost({
          pricing: input.modelSnapshot.pricing,
          inputTokens: input.outcome.usage.input_tokens,
          ...(input.outcome.usage.cached_input_tokens !== undefined
            ? { cachedInputTokens: input.outcome.usage.cached_input_tokens }
            : {}),
          outputTokens: input.outcome.usage.output_tokens,
        });
        const [step] = await query((transaction) =>
          transaction
            .update(agentTraceSteps)
            .set({
              status: 'succeeded',
              outputSummary: {
                outcome: 'session_compaction',
                summary_digest: canonicalSha256(input.summary.content),
                checkpoint_digest: canonicalSha256(input.summary),
                covered_from_sequence: input.summary.covered_from_sequence,
                covered_through_sequence: input.summary.covered_through_sequence,
                published: canPublish,
              },
              tokenUsageJson: input.outcome.usage,
              estimatedCost: actualCost,
            })
            .where(
              and(
                eq(agentTraceSteps.id, input.step.stepId),
                eq(agentTraceSteps.traceId, trace.id),
                eq(agentTraceSteps.status, 'started'),
              ),
            )
            .returning({ id: agentTraceSteps.id }),
        );
        if (!step) return null;
        const summaryVersion = input.expectedSummaryVersion + 1;
        const [session] = canPublish
          ? await query((transaction) =>
              transaction
                .update(chatSessions)
                .set({
                  summaryJson: input.summary,
                  summaryVersion,
                  summaryThroughTurnId: input.summary.source_turn_ids.at(-1) ?? null,
                  transcriptGeneration: nextGeneration,
                })
                .where(
                  and(
                    eq(chatSessions.id, turn.sessionId),
                    eq(chatSessions.userId, turn.userId),
                    eq(chatSessions.summaryVersion, input.expectedSummaryVersion),
                    eq(chatSessions.transcriptGeneration, BigInt(input.expectedGeneration)),
                  ),
                )
                .returning({ id: chatSessions.id }),
            )
          : [];
        if (canPublish && !session) throw new Error('AGENT_SESSION_SUMMARY_CAS_CONFLICT');
        if (!matchesCheckpoint) {
          emitTranscriptMetric({
            metric: 'transcript_summary_cas_conflict',
            format: 'transcript_v1',
            type: 'summary',
            result: 'conflict',
            value: 1,
          });
        }
        if (turn.contextSnapshotJson !== null) {
          if (
            typeof turn.contextSnapshotJson !== 'object' ||
            Array.isArray(turn.contextSnapshotJson) ||
            !turn.contextSnapshotHash ||
            canonicalSha256(turn.contextSnapshotJson) !== turn.contextSnapshotHash
          ) {
            throw new Error('AGENT_CONTEXT_SNAPSHOT_INVALID');
          }
          const contextSnapshot = {
            ...(turn.contextSnapshotJson as Record<string, unknown>),
            session_summary_version: canPublish ? summaryVersion : storedSession.summaryVersion,
            session_summary_hash: canPublish
              ? canonicalSha256(input.summary)
              : currentSummary
                ? canonicalSha256(currentSummary)
                : null,
          };
          await query((transaction) =>
            transaction
              .update(agentTurns)
              .set({
                contextSnapshotJson: contextSnapshot,
                contextSnapshotHash: canonicalSha256(contextSnapshot),
              })
              .where(eq(agentTurns.id, turn.id)),
          );
        }
        const reservedCost = subtractMoney(trace.reservedCost, input.step.exposureCost);
        if (compareMoney(reservedCost, '0.00') < 0) throw new Error('AGENT_COST_RESERVATION_DRIFT');
        const estimatedCost = addMoney(trace.estimatedCost, actualCost);
        await query((transaction) =>
          transaction
            .update(agentTraces)
            .set({
              reservedCost,
              estimatedCost,
              inputTokenTotal: trace.inputTokenTotal + input.outcome.usage.input_tokens,
              outputTokenTotal: trace.outputTokenTotal + input.outcome.usage.output_tokens,
            })
            .where(eq(agentTraces.id, trace.id)),
        );
        await checkLease();
        return {
          budgetExceeded:
            compareMoney(addMoney(estimatedCost, reservedCost), input.turnBudgetCost) > 0,
          pricingDrift: compareMoney(actualCost, input.step.exposureCost) > 0,
          transcriptGeneration: canPublish
            ? nextGeneration.toString()
            : storedSession.transcriptGeneration.toString(),
          published: canPublish,
          currentSummary: canPublish ? input.summary : currentSummary,
        };
      }),
    );
  }

  async markUnknown(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    stepId: string;
    errorCode?: string;
    diagnostic?: AgentBrainDiagnostic;
  }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const turn = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return false;
      const [updated] = await transaction
        .update(agentTraceSteps)
        .set({
          status: 'failed',
          errorCode: input.errorCode ?? 'AGENT_CALL_OUTCOME_UNKNOWN',
          outputSummary: {
            outcome: 'unknown',
            ...(input.diagnostic ? { diagnostic: input.diagnostic } : {}),
          },
        })
        .where(
          and(
            eq(agentTraceSteps.id, input.stepId),
            eq(agentTraceSteps.traceId, input.claimed.traceId),
            eq(agentTraceSteps.status, 'started'),
          ),
        )
        .returning({ id: agentTraceSteps.id });
      return Boolean(updated);
    });
  }

  async releaseNotDispatched(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    step: ReservedLlmStep;
    /** Real delivery-failure code; kept as a diagnostic so lease recovery still counts the step. */
    errorCode?: string;
  }): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const turn = await lockOwnedTurn(transaction, input.claimed, input.revision);
      if (!turn) return false;
      const [trace] = await transaction
        .select()
        .from(agentTraces)
        .where(eq(agentTraces.id, input.claimed.traceId))
        .for('update');
      if (!trace) throw new Error('AGENT_TRACE_MISSING');
      const [updated] = await transaction
        .update(agentTraceSteps)
        .set({
          status: 'failed',
          errorCode: 'AGENT_CALL_NOT_DISPATCHED',
          outputSummary: {
            outcome: 'not_dispatched',
            ...(input.errorCode ? { diagnostic: { delivery_error_code: input.errorCode } } : {}),
          },
          estimatedCost: '0.00',
        })
        .where(
          and(
            eq(agentTraceSteps.id, input.step.stepId),
            eq(agentTraceSteps.traceId, trace.id),
            eq(agentTraceSteps.status, 'started'),
          ),
        )
        .returning({ id: agentTraceSteps.id });
      if (!updated) return false;
      const reservedCost = subtractMoney(trace.reservedCost, input.step.exposureCost);
      if (compareMoney(reservedCost, '0.00') < 0) throw new Error('AGENT_COST_RESERVATION_DRIFT');
      await transaction
        .update(agentTraces)
        .set({ reservedCost })
        .where(eq(agentTraces.id, trace.id));
      return true;
    });
  }
}

type LlmWriteQuery = <T>(build: (transaction: Transaction) => PromiseLike<T>) => Promise<T>;

function ownedTrace(claimed: ClaimedAgentTurn) {
  return and(
    eq(agentTraces.id, claimed.traceId),
    eq(agentTraces.turnId, claimed.turnId),
    eq(agentTraces.sessionId, claimed.sessionId),
    eq(agentTraces.userId, claimed.userId),
  );
}

async function withLlmWrite<T>(
  database: Database,
  input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    transcript?: TranscriptModelCapture;
    nativeFence?: { expectedGeneration: string };
  },
  work: (
    query: LlmWriteQuery,
    turn: typeof agentTurns.$inferSelect,
    scope: AgentTranscriptWriteScope,
  ) => Promise<T>,
): Promise<T | null> {
  const fence = input.transcript
    ? { expectedGeneration: input.transcript.expectedGeneration }
    : input.nativeFence;
  if (!fence) throw new Error('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
  return new AgentTranscriptWriteTransactions(database).run(
    {
      userId: input.claimed.userId,
      sessionId: input.claimed.sessionId,
      turnId: input.claimed.turnId,
      owner: input.claimed.owner,
      revision: input.revision,
      continuationNo: input.claimed.continuationNo,
      expectedGeneration: fence.expectedGeneration,
    },
    async (scope) => {
      const turn = await scope.query((tx) =>
        tx.query.agentTurns.findFirst({
          where: and(
            eq(agentTurns.id, scope.turnId),
            eq(agentTurns.sessionId, scope.sessionId),
            eq(agentTurns.userId, scope.userId),
          ),
        }),
      );
      if (!turn || turn.transcriptCaptureVersion !== 1) return scope.abort();
      return work((build) => scope.query(build), turn, scope);
    },
  );
}

/**
 * Take the owned session lock first (`05` unified lock order). Settlement transactions touch both
 * `chat_sessions` and the owned turn; the API turn-create path (`chat_sessions FOR UPDATE` ->
 * supersede `agent_turns`) locks in the same order, so a turn-first settlement could deadlock
 * with it. Returns false when the session row is missing or no longer belongs to the user.
 */
async function lockSessionFirst(
  transaction: Transaction,
  claimed: Pick<ClaimedAgentTurn, 'userId' | 'sessionId'>,
): Promise<boolean> {
  const [session] = await transaction
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, claimed.sessionId), eq(chatSessions.userId, claimed.userId)))
    .for('no key update');
  return Boolean(session);
}

async function lockOwnedTurn(
  transaction: Transaction,
  claimed: ClaimedAgentTurn,
  revision: number,
) {
  const [turn] = await transaction
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.id, claimed.turnId),
        eq(agentTurns.userId, claimed.userId),
        eq(agentTurns.sessionId, claimed.sessionId),
        eq(agentTurns.processingOwner, claimed.owner),
        eq(agentTurns.revision, revision),
        eq(agentTurns.continuationNo, claimed.continuationNo),
      ),
    )
    .for('update');
  return turn;
}
