import { randomUUID } from 'node:crypto';

import { DelayedError, Worker, type Job } from 'bullmq';

import {
  callPositionKey,
  agentTaskBudget,
  authoringCandidateKeys,
  mergeAuthoredPromptBatch,
  loadSkillArgumentsSchema,
  inspectImageArgumentsSchema,
  checkLoopGuard,
  AgentBrainCallError,
  crossUploadGroupScope,
  parseAgentBrainStepOutcome,
  recordCompletedObservation,
  recordPolicyObservation,
  toolFingerprint,
  validatePublicText,
  type AgentBrainPort,
  type AgentBrainDiagnostic,
  type AgentBrainImageDetail,
  type AgentBrainImageResolver,
  type AgentBrainStepInput,
  type AgentBrainStepOutcome,
  type AgentTranscriptCompactionItem,
  type LoopState,
} from '@ecom-forge/agent';
import { agentTurns, and, eq, inArray, sql, type Database } from '@ecom-forge/db';
import {
  candidatePlanSchema,
  compilePlan,
  creativeProfileRequiresDistinctPrompts,
  resolveCreativeExecutionProfile,
  createImageCapabilityRegistry,
  type CompilerContext,
} from '@ecom-forge/compiler';
import type { CapabilityRegistry } from '@ecom-forge/compiler';
import {
  calculateAgentBrainExposure,
  estimateAgentSessionCompactionInputTokens,
  DeterministicFakeAgentBrain,
  imageCreativePromptMaxCharacters,
} from '@ecom-forge/provider';
import { createBullMqConnection, parseQueuePayload, type QueuePayload } from '@ecom-forge/queue';
import {
  canonicalSha256,
  compareMoney,
  type EventWakePublisher,
  type AgentPublicErrorCode,
  type AgentPublicSummary,
  type AgentGuardrailType,
} from '@ecom-forge/shared';
import {
  creativeDirectionPlanError,
  turnCreativeDirection,
} from '../agent/session-creative-direction.js';
import type { Redis } from 'ioredis';

import type { WorkerConfig } from '../config/worker-config.js';
import { assertSupportedAgentExecutionFormat } from '../config/runtime-defaults.js';
import { emitTranscriptMetric, transcriptMetricValue } from '../agent/agent-transcript-metrics.js';
import type { ActiveWorkTracker, WorkerWriteFence } from '../lifecycle/processing-fence.js';
import type { WorkerLifecycleLogger } from '../lifecycle/worker-lifecycle.js';
import { errorDetailLine, stableErrorCode } from '../provider/provider-telemetry.js';
import { AgentTurnRepository, type ClaimedAgentTurn } from '../agent/agent-turn.repository.js';
import { AgentPublicDraft } from '../agent/agent-public-draft.js';
import { agentBrainPublicFailure } from '../agent/agent-brain-public-failure.js';
import { contextActivitySummary } from '../agent/agent-turn-activity.repository.js';
import { AgentLlmCostRepository } from '../agent/agent-llm-cost.repository.js';
import { validateAuthoringBatchOutcome } from '../agent/agent-authoring-outcome.js';
import {
  MAX_MODEL_OUTPUT_REPAIRS,
  MAX_PUBLIC_TEXT_REPAIRS,
} from '../agent/agent-transcript-policy-context.js';
import { AgentCompilerRepository } from '../agent/agent-compiler.repository.js';
import { CompilerContextService } from '../agent/compiler-context.service.js';
import { AgentQuoteService } from '../agent/agent-quote.service.js';
import {
  resolveSkillDefaultOutputCount,
  SkillRuntimeAdapter,
  type LoadedSkillResource,
} from '../agent/skill-runtime.adapter.js';
import { ApprovedAgentBrainRouter } from '../agent/approved-agent-brain.router.js';
import { ApprovedModerationDispatcher } from '../agent/approved-moderation.dispatcher.js';
import { ContentSafetyPreflightService } from '../agent/content-safety-preflight.service.js';
import { AgentImageContextService } from '../agent/agent-image-context.service.js';
import { AgentImagePayloadCache } from '../agent/agent-image-payload-cache.js';
import { AgentSessionImageCandidateService } from '../agent/agent-session-image-candidate.service.js';
import {
  appendNativeTranscriptPrelude,
  createNativeTranscriptCapture,
} from '../agent/agent-transcript-native.js';
import {
  createNativeTranscriptReader,
  NativeTranscriptDependencies,
} from '../agent/agent-transcript-native-reader.js';
import {
  readTranscriptSummarySource,
  verifyTranscriptSummarySource,
} from '../agent/agent-transcript-summary-source.js';
import { projectNativeTranscriptMessages } from '../agent/agent-transcript-brain-view.js';
import {
  readNativeTranscriptRecovery,
  restoreNativeTranscriptRuntimeState,
} from '../agent/agent-transcript-recovery.js';
import {
  AgentPreflightPendingError,
  AgentPreflightNotDispatchedError,
  agentRetryDelayMs,
  isRetryableAgentBrainNotDispatched,
  isSafeAgentProcessingRetry,
  waitForAgentRetry,
  type AgentProcessingPhase,
} from '../agent/agent-processing-retry.js';
import {
  buildTranscriptSummaryCheckpoint,
  planTranscriptCompaction,
} from '../agent/agent-transcript-summary.js';

type AgentQueuePayload = Extract<
  QueuePayload,
  { job_type: 'agent.continue' | 'agent.quote.submit' | 'agent.quote.expire' }
>;

/** Product directive: transient brain-delivery failures retry up to 3 times. */
const MAX_CONSECUTIVE_BRAIN_DELIVERY_FAILURES = 4;

export class AgentProcessorWorker {
  private readonly worker: Worker<AgentQueuePayload>;
  private readonly repository: AgentTurnRepository;
  private readonly llmCosts: AgentLlmCostRepository;
  private readonly brain: AgentBrainPort;
  private readonly compilerRepository: AgentCompilerRepository;
  private readonly compilerContext: CompilerContextService;
  private readonly capabilityRegistry: CapabilityRegistry;
  private readonly quotes: AgentQuoteService;
  private readonly contentSafety: ContentSafetyPreflightService;
  private readonly imageContext: AgentImageContextService;
  private readonly sessionImageCandidates: AgentSessionImageCandidateService;

  constructor(
    private readonly database: Database,
    private readonly redis: Redis,
    private readonly config: WorkerConfig,
    private readonly activeWork: ActiveWorkTracker,
    private readonly writeFence: WorkerWriteFence,
    private readonly eventWakePublisher: EventWakePublisher,
    brain?: AgentBrainPort,
    capabilityRegistry: CapabilityRegistry = createImageCapabilityRegistry(),
    routedModelIds: ReadonlySet<string> = new Set(),
    private readonly logger?: WorkerLifecycleLogger,
  ) {
    if (!config.agentProcessorEnabled) {
      throw new Error('Agent processor is disabled');
    }
    this.repository = new AgentTurnRepository(database);
    this.llmCosts = new AgentLlmCostRepository(database);
    this.compilerRepository = new AgentCompilerRepository(database);
    this.capabilityRegistry = capabilityRegistry;
    this.compilerContext = new CompilerContextService(
      database,
      config,
      capabilityRegistry.version,
      routedModelIds,
    );
    this.quotes = new AgentQuoteService(database, eventWakePublisher);
    const moderation = new ApprovedModerationDispatcher(database, redis, config, writeFence);
    this.contentSafety = new ContentSafetyPreflightService(
      database,
      moderation.dispatch,
      config.agentProcessingLeaseMs,
      config.appEnv,
    );
    this.imageContext = new AgentImageContextService(database, config);
    this.sessionImageCandidates = new AgentSessionImageCandidateService(database);
    this.brain =
      brain ??
      (config.agentBrainAdapter === 'fake'
        ? new DeterministicFakeAgentBrain()
        : new ApprovedAgentBrainRouter(
            database,
            redis,
            config.redisPrefix,
            config.providerCredentialEncryptionKeys ?? '',
            config.providerRelayOrigins,
            fetch,
            config.appEnv === 'local' || config.appEnv === 'test',
            config.agentBrainReasoningEffort,
          ));
    this.worker = new Worker<AgentQueuePayload>('agent', (job) => this.process(job), {
      connection: createBullMqConnection(config.redisUrl),
      prefix: config.redisPrefix,
      concurrency: 1,
      lockDuration: config.agentProcessingLeaseMs + config.agentProcessingRenewMs,
      autorun: true,
    });
  }

  pauseNewWork(): Promise<void> {
    return this.worker.pause(true).then(() => undefined);
  }

  close(force: boolean): Promise<void> {
    return this.worker.close(force).then(() => undefined);
  }

  private process(job: Job<AgentQueuePayload>): Promise<void> {
    return this.activeWork.run(async () => {
      const payload = parseQueuePayload(job.data);
      if (payload.job_type === 'agent.quote.submit') {
        this.writeFence.assertWritesAllowed();
        await this.quotes.submit(payload);
        return;
      }
      if (payload.job_type === 'agent.quote.expire') {
        this.writeFence.assertWritesAllowed();
        await this.quotes.expire(payload);
        return;
      }
      if (payload.job_type !== 'agent.continue') throw new Error('Agent queue payload is invalid');
      const claimed = await this.repository.claim({
        turnId: payload.turn_id,
        sessionId: payload.session_id,
        traceId: payload.trace_id,
        userMessageId: payload.user_message_id,
        continuationNo: payload.continuation_no,
        payloadRevision: payload.turn_revision,
        leaseMs: this.config.agentProcessingLeaseMs,
        now: new Date(),
      });
      if (!claimed) {
        const retryAt = await this.repository.activeLeaseRetryAt({
          turnId: payload.turn_id,
          sessionId: payload.session_id,
          continuationNo: payload.continuation_no,
          now: new Date(),
        });
        if (!retryAt) return;
        await job.moveToDelayed(Math.max(Date.now() + 100, retryAt.getTime() + 100), job.token);
        throw new DelayedError();
      }
      let revision = claimed.revision;
      const runtime = new SkillRuntimeAdapter(this.database, this.redis, this.config.redisPrefix);
      let processingPhase: AgentProcessingPhase = 'claimed';
      try {
        // Fail closed (stop consuming, do not guess a legacy path) when the frozen execution
        // format is not one this worker can actually execute. Readiness advertises the same set.
        assertSupportedAgentExecutionFormat(claimed.executionFormat ?? '');
        this.writeFence.assertWritesAllowed();
        processingPhase = 'transcript_prelude';
        await appendNativeTranscriptPrelude(this.database, claimed);
        await this.refreshNativeTranscript(claimed);
        if (await this.stopRecoveredTurn(claimed, revision)) return;
        processingPhase = claimed.contextInitialized ? 'skill_context_restore' : 'skill_core_load';
        const loaded = claimed.contextInitialized
          ? await runtime.restore(claimed.selection, claimed.loadedResourceSnapshotIds)
          : await runtime.loadCore(claimed.selection);
        claimed.effectiveSkillDefaultOutputCount = resolveSkillDefaultOutputCount(
          claimed.selection,
          loaded,
        );
        processingPhase = 'skill_budget_check';
        this.assertCoreKnowledgeBudget(loaded);
        processingPhase = 'session_image_candidates_resolve';
        if (!claimed.contextInitialized) {
          try {
            claimed.sessionImageCandidates = await this.sessionImageCandidates.resolve(claimed);
          } catch (error) {
            if (
              !(error instanceof Error) ||
              error.message !== 'SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED'
            )
              throw error;
            claimed.sessionImageCandidates = [];
            claimed.sessionImageCandidatesUnavailable = true;
          }
        }
        if (
          claimed.modelSnapshot.adapter === 'approved' &&
          claimed.attachments.length + (claimed.sessionImageCandidates?.length ?? 0) > 0 &&
          !claimed.modelSnapshot.capability_contract.input_modalities.includes('image')
        ) {
          throw new Error('AGENT_BRAIN_IMAGE_INPUT_UNSUPPORTED');
        }
        processingPhase = 'image_context_resolve';
        const authorizedImages =
          claimed.modelSnapshot.capability_contract.input_modalities.includes('image')
            ? await this.imageContext.resolveImages(claimed, this.writeFence.signal)
            : [];
        const imagePayloadCache = new AgentImagePayloadCache(
          this.config.agentBrainMaxMaterializedImageBytes,
        );
        const resolveAuthorizedImage: AgentBrainImageResolver = async (image, detail) => {
          const cacheKey = `${image.binding_key}:${image.content_hash}`;
          return imagePayloadCache.getOrResolve(cacheKey, detail, () =>
            this.imageContext.resolveImage(claimed, image, detail, this.writeFence.signal),
          );
        };
        processingPhase = 'product_facts_resolve';
        const confirmedProductFactsContext =
          await this.imageContext.resolveConfirmedProductFactsContext(claimed);
        const confirmedProductFacts = confirmedProductFactsContext?.facts;
        const confirmedProductFactDependency = confirmedProductFactsContext?.dependency;
        processingPhase = 'session_memory_prepare';
        const memory = await this.prepareSessionMemory(
          claimed,
          revision,
          loaded,
          authorizedImages,
          confirmedProductFacts,
        );
        if (!memory) return;
        revision = memory.revision;
        claimed.revision = revision;
        if (!claimed.contextInitialized) {
          processingPhase = 'context_snapshot_persist';
          const contextSnapshot = {
            session_id: claimed.sessionId,
            turn_id: claimed.turnId,
            continuation_no: claimed.continuationNo,
            user_message_id: claimed.userMessageId,
            skill_selection_hash: canonicalSha256(claimed.selection),
            session_summary_version: claimed.sessionSummaryVersion,
            session_summary_hash: claimed.transcriptSummary
              ? canonicalSha256(claimed.transcriptSummary)
              : null,
            resource_snapshots: loaded.map((item) => ({
              skill_id: item.skillId,
              resource_snapshot_id: item.resource.resource_snapshot_id,
              resource_hash: item.resource.resource_hash,
              token_count: item.tokenCount,
            })),
            session_image_candidates: claimed.sessionImageCandidates ?? [],
            session_image_candidates_hash: canonicalSha256(claimed.sessionImageCandidates ?? []),
            session_image_candidates_unavailable:
              claimed.sessionImageCandidatesUnavailable === true,
            budgets: this.publicBudgets(claimed.modelSnapshot, claimed),
          };
          const persisted = await this.repository.persistContext({
            claimed,
            revision,
            contextSnapshot,
            preloaded: loaded.map((item) => ({
              skillId: item.skillId,
              resourceId: item.resource.resource_snapshot_id,
              resourceHash: item.resource.resource_hash,
              tokenCount: item.tokenCount,
            })),
            projectKnowledgeLoading: claimed.isFirstSessionTurn,
          });
          if (!persisted) return;
          revision = persisted.revision;
          claimed.revision = revision;
          if (persisted.eventSeq !== null) {
            await this.publishWake(claimed.turnId, persisted.eventSeq);
          }
        }
        processingPhase = 'agent_loop';
        await this.runLoop(
          claimed,
          revision,
          runtime,
          loaded,
          authorizedImages,
          confirmedProductFacts,
          confirmedProductFactDependency,
          resolveAuthorizedImage,
        );
      } catch (error) {
        // Nested Brain calls renew the same owner's lease and advance its CAS revision.
        revision = claimed.revision;
        if (error instanceof AgentPreflightPendingError) {
          if (this.writeFence.signal.aborted) return;
          const released = await this.repository.releaseForRetry({ claimed, revision });
          if (!released) return;
          await job.moveToDelayed(
            Math.max(
              Date.now() + this.config.agentProcessingRetryBaseMs,
              error.retryAt?.getTime() ?? 0,
            ),
            job.token,
          );
          this.logger?.info({
            event: 'agent_content_safety_wait_scheduled',
            turn_id_hash: canonicalSha256(claimed.turnId),
            trace_id_hash: canonicalSha256(claimed.traceId),
          });
          throw new DelayedError();
        }
        const processingDetail = errorDetailLine(error);
        this.logger?.error({
          event: 'agent_turn_processing_failed',
          turn_id_hash: canonicalSha256(claimed.turnId),
          trace_id_hash: canonicalSha256(claimed.traceId),
          error_code: stableErrorCode(error),
          // Controlled identifiers only (codes / zod paths / SQLSTATE); the field is omitted
          // entirely when the failure carries none, so nothing caller-controlled reaches logs.
          ...(processingDetail ? { error_detail: processingDetail } : {}),
          phase: processingPhase,
        });
        if (this.writeFence.signal.aborted) return;
        const attempts = job.opts.attempts ?? 1;
        const hasRemainingQueueAttempt = job.attemptsMade + 1 < attempts;
        if (
          hasRemainingQueueAttempt &&
          isSafeAgentProcessingRetry({ error, phase: processingPhase })
        ) {
          const released = await this.repository.releaseForRetry({ claimed, revision });
          if (released) {
            this.logger?.info({
              event: 'agent_turn_retry_scheduled',
              turn_id_hash: canonicalSha256(claimed.turnId),
              trace_id_hash: canonicalSha256(claimed.traceId),
              phase: processingPhase,
              retry_no: job.attemptsMade + 1,
            });
            throw error;
          }
          return;
        }
        const guardrailType = this.failureGuardrailType(error, claimed);
        const blocked = await this.repository.block({
          claimed,
          revision,
          errorCode: this.publicErrorCode(error),
          summary: this.publicSummary(error),
          ...(guardrailType ? { guardrailType } : {}),
        });
        if (blocked) await this.publishWake(claimed.turnId, blocked.eventSeq);
      }
    });
  }

  /**
   * Native (`transcript_v1`) memory preparation. When the full context (tools, Skill, images and
   * controlled payloads included) crosses the soft threshold, the largest contiguous, closed,
   * non-active prefix of the transcript is compressed into a strict v2 checkpoint. The active turn
   * is never summarized and a single turn is never split; if the active turn alone exceeds the hard
   * window the turn fails closed. A failed compaction keeps the previous summary and the
   * uncompacted window with no deterministic fallback.
   */
  private async prepareSessionMemory(
    claimed: ClaimedAgentTurn,
    initialRevision: number,
    loaded: LoadedSkillResource[],
    authorizedImages: AgentBrainStepInput['authorized_images'],
    confirmedProductFacts: AgentBrainStepInput['confirmed_product_facts'],
    materializedImageBindingKeys: readonly string[] = [],
    materializedImageDetails: Readonly<Record<string, AgentBrainImageDetail>> = {},
  ): Promise<{ revision: number } | null> {
    if (claimed.transcriptCaptureVersion !== 1)
      throw new Error('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
    const modelSnapshot = claimed.modelSnapshot;
    const hardInputLimit = this.contextWindowTokens(modelSnapshot) - 1;
    if (hardInputLimit <= 0) throw new Error('AGENT_BUDGET_EXCEEDED');
    const softInputLimit = Math.max(
      1,
      Math.min(
        this.config.agentAutoCompactTokenLimit ?? Math.floor(hardInputLimit * 0.8),
        Math.floor(hardInputLimit * 0.8),
      ),
    );
    const countNativeInput = () =>
      this.brain.countInputTokens(
        this.brainInput(
          claimed,
          loaded,
          authorizedImages,
          confirmedProductFacts,
          claimed.loopState,
          claimed.inputTokenTotal,
          claimed.outputTokenTotal,
          materializedImageBindingKeys,
          materializedImageDetails,
        ),
        modelSnapshot,
      );
    const fullInputTokens = await countNativeInput();
    if (!Number.isSafeInteger(fullInputTokens) || fullInputTokens < 0) {
      throw new Error('AGENT_INPUT_TOKEN_COUNT_INVALID');
    }
    if (fullInputTokens <= softInputLimit) return { revision: initialRevision };
    if (claimed.loopState.rounds >= this.taskBudget(claimed).rounds) {
      throw new Error('AGENT_BUDGET_EXCEEDED');
    }
    const previousSummary = claimed.transcriptSummary?.content;
    const compactionHardInputLimit = this.contextWindowTokens(modelSnapshot) - 1;
    if (!this.brain.summarizeSession) {
      if (fullInputTokens <= hardInputLimit) return { revision: initialRevision };
      throw new Error('AGENT_SESSION_COMPACTION_UNAVAILABLE');
    }
    const countCompactionInput = (items: readonly AgentTranscriptCompactionItem[]) =>
      estimateAgentSessionCompactionInputTokens(
        {
          messages: [],
          transcript_items: [...items],
          ...(previousSummary ? { previous_summary: previousSummary } : {}),
        },
        modelSnapshot,
      );
    const terminalTurns = await this.database
      .select({ id: agentTurns.id })
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.userId, claimed.userId),
          eq(agentTurns.sessionId, claimed.sessionId),
          sql`${agentTurns.endedAt} is not null`,
          inArray(agentTurns.status, ['done', 'blocked', 'failed', 'cancelled', 'superseded']),
        ),
      );
    const plan = await planTranscriptCompaction({
      items: claimed.transcriptItems ?? [],
      activeTurnId: claimed.turnId,
      terminalTurnIds: new Set(terminalTurns.map((turn) => turn.id)),
      fits: (projection) => countCompactionInput(projection) <= compactionHardInputLimit,
    });
    if (!plan) {
      // Nothing closed can be compacted. Fail closed when even the active turn exceeds the window;
      // never summarize an incomplete turn or split a user/assistant/tool boundary.
      if (fullInputTokens > hardInputLimit) throw new Error('AGENT_SESSION_CONTEXT_TOO_LARGE');
      return { revision: initialRevision };
    }
    const previousSource = claimed.transcriptSummary
      ? await readTranscriptSummarySource(this.database, {
          userId: claimed.userId,
          sessionId: claimed.sessionId,
          activeTurnId: claimed.turnId,
          throughSequence: claimed.transcriptSummary.covered_through_sequence,
        })
      : undefined;
    if (claimed.transcriptSummary && previousSource) {
      verifyTranscriptSummarySource(claimed.transcriptSummary, previousSource);
      if (!previousSource.authorized)
        throw new Error('AGENT_SESSION_SUMMARY_DEPENDENCY_UNAVAILABLE');
    }
    const compactionInput: Parameters<NonNullable<AgentBrainPort['summarizeSession']>>[0] = {
      ...(previousSummary ? { previous_summary: previousSummary } : {}),
      messages: [],
      transcript_items: [...plan.projection],
    };
    const requestedInputTokens = countCompactionInput(plan.projection);
    const requestedMaxOutputTokens = Math.min(
      2_048,
      modelSnapshot.capability_contract.max_output_tokens,
      this.contextWindowTokens(modelSnapshot) - requestedInputTokens,
      this.taskBudget(claimed).outputTokens - claimed.outputTokenTotal,
    );
    if (requestedMaxOutputTokens <= 0) throw new Error('AGENT_SESSION_COMPACTION_TOO_LARGE');
    const turnBudgetCost = this.turnCostBudget(modelSnapshot);
    const exposureCost = calculateAgentBrainExposure({
      pricing: modelSnapshot.pricing,
      requestedInputTokens,
      requestedMaxOutputTokens,
    });
    if (!claimed.transcriptGeneration) throw new Error('AGENT_TRANSCRIPT_GENERATION_MISSING');
    const expectedGeneration = claimed.transcriptGeneration;
    const reservation = await this.llmCosts.reserve({
      claimed,
      revision: initialRevision,
      round: claimed.loopState.rounds + 1,
      purpose: 'session_compaction',
      modelSnapshot,
      exposureCost,
      turnBudgetCost,
      requestedInputTokens,
      requestedMaxOutputTokens,
      nativeFence: { expectedGeneration },
    });
    if (!reservation) return null;
    if (reservation.kind === 'budget_exceeded') throw new Error('AGENT_BUDGET_EXCEEDED');
    const execution = await this.runSessionSummaryWithLeaseRenewal(
      claimed,
      initialRevision,
      compactionInput,
      reservation.step.stepNo,
      requestedMaxOutputTokens,
    );
    if (!execution) return null;
    const revision = execution.revision;
    claimed.revision = revision;
    claimed.loopState.rounds += 1;
    if (execution.kind === 'unknown') {
      const recorded = await this.llmCosts.markUnknown({
        claimed,
        revision,
        stepId: reservation.step.stepId,
        errorCode: execution.errorCode,
        ...(execution.diagnostic ? { diagnostic: execution.diagnostic } : {}),
      });
      if (!recorded) throw new Error('AGENT_SESSION_COMPACTION_FAILED');
      claimed.consecutiveBrainDeliveryFailures += 1;
      claimed.lastBrainCallOutcomeUnknown = true;
      await this.blockForUnavailableBrain(claimed, revision, execution);
      return null;
    }
    if (execution.kind === 'not_dispatched') {
      const released = await this.llmCosts.releaseNotDispatched({
        claimed,
        revision,
        step: reservation.step,
      });
      if (!released) throw new Error('AGENT_SESSION_COMPACTION_FAILED');
      claimed.consecutiveBrainDeliveryFailures += 1;
      // Keep the previous summary and the uncompacted window; no deterministic fallback.
      return { revision };
    }
    claimed.consecutiveBrainDeliveryFailures = 0;
    const checkpoint = buildTranscriptSummaryCheckpoint({
      ...(claimed.transcriptSummary && previousSource
        ? {
            previous: {
              checkpoint: claimed.transcriptSummary,
              sourceItems: previousSource.sourceItems,
            },
          }
        : {}),
      summaryVersion: claimed.sessionSummaryVersion + 1,
      historyGeneration: (BigInt(expectedGeneration) + 1n).toString(),
      content: execution.outcome.summary,
      coveredItems: plan.coveredItems,
      sourceItems: plan.sourceItems,
      coveredFromSequence: plan.coveredFromSequence,
      coveredThroughSequence: plan.coveredThroughSequence,
      modelSnapshot,
      usage: execution.outcome.usage,
    });
    const settled = await this.llmCosts.settleTranscriptSummary({
      claimed,
      revision,
      step: reservation.step,
      outcome: execution.outcome,
      summary: checkpoint,
      expectedSummaryVersion: claimed.sessionSummaryVersion,
      expectedGeneration,
      modelSnapshot,
      turnBudgetCost,
    });
    if (!settled) return null;
    if (settled.budgetExceeded || settled.pricingDrift) throw new Error('AGENT_BUDGET_EXCEEDED');
    claimed.inputTokenTotal += execution.outcome.usage.input_tokens;
    claimed.outputTokenTotal += execution.outcome.usage.output_tokens;
    claimed.sessionSummaryVersion = settled.currentSummary?.summary_version ?? 0;
    if (settled.currentSummary) claimed.transcriptSummary = settled.currentSummary;
    else delete claimed.transcriptSummary;
    claimed.transcriptGeneration = settled.transcriptGeneration;
    // Publishing advanced the generation: refresh the fence and re-read the now-bounded window so
    // the current call sees the new coverage instead of a stale (or skipped) range.
    await this.refreshNativeTranscript(claimed);
    return { revision };
  }

  private async stopRecoveredTurn(claimed: ClaimedAgentTurn, revision: number): Promise<boolean> {
    if (claimed.lastBrainCallOutcomeUnknown) {
      await this.blockForUnavailableBrain(claimed, revision);
      return true;
    }
    const rejectedOutputs = claimed.observations.filter(
      (item) =>
        item.tool_name === 'runtime_policy@1' &&
        [
          'AGENT_BRAIN_TOOL_INPUT_INVALID',
          'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
          'AGENT_TOOL_NOT_ALLOWED',
        ].includes(String(item.summary.public_error_code)),
    );
    const failure: {
      errorCode: string;
      summary: AgentPublicSummary;
      guardrailType: AgentGuardrailType;
    } | null = claimed.lastBrainCallBudgetExceeded
      ? {
          errorCode: 'AGENT_BUDGET_EXCEEDED',
          summary: '当前对话的模型预算已用尽，请开始新的请求',
          guardrailType: 'cost_budget',
        }
      : claimed.publicTextRejections > MAX_PUBLIC_TEXT_REPAIRS
        ? {
            errorCode: 'AGENT_MODEL_UNAVAILABLE',
            summary: '创作助手暂时无法生成安全回复，请稍后重试',
            guardrailType: 'public_text_policy',
          }
        : rejectedOutputs.length > MAX_MODEL_OUTPUT_REPAIRS
          ? {
              errorCode: String(rejectedOutputs.at(-1)!.summary.public_error_code),
              summary: '模型连续返回无效输出，已停止本轮处理，请重新发送需求',
              guardrailType: 'invalid_model_output',
            }
          : null;
    if (!failure) return false;
    const result = await this.repository.block({ claimed, revision, ...failure });
    if (result) await this.publishWake(claimed.turnId, result.eventSeq);
    return true;
  }

  private async runLoop(
    claimed: ClaimedAgentTurn,
    revision: number,
    runtime: SkillRuntimeAdapter,
    preloaded: LoadedSkillResource[],
    authorizedImages: AgentBrainStepInput['authorized_images'],
    confirmedProductFacts: AgentBrainStepInput['confirmed_product_facts'],
    confirmedProductFactDependency: unknown,
    resolveAuthorizedImage: AgentBrainImageResolver,
  ): Promise<void> {
    const loaded = [...preloaded];
    const observations: AgentBrainStepInput['observations'] = [...claimed.observations];
    const materializedImageBindingKeys = new Set(claimed.materializedImageBindingKeys ?? []);
    const materializedImageDetails: Record<string, AgentBrainImageDetail> = {
      ...(claimed.materializedImageDetails ?? {}),
    };
    if (claimed.lastBrainCallOutcomeUnknown) {
      await this.blockForUnavailableBrain(claimed, revision);
      return;
    }
    let loopState: LoopState = claimed.loopState;
    let inputTokens = claimed.inputTokenTotal;
    let outputTokens = claimed.outputTokenTotal;
    let publicTextRejections = claimed.publicTextRejections;
    let consecutiveBrainDeliveryFailures = claimed.consecutiveBrainDeliveryFailures;
    let modelOutputRejections = observations.filter(
      (item) =>
        item.tool_name === 'runtime_policy@1' &&
        [
          'AGENT_BRAIN_TOOL_INPUT_INVALID',
          'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
          'AGENT_TOOL_NOT_ALLOWED',
        ].includes(String(item.summary.public_error_code)),
    ).length;
    let shouldPrepareMemory = false;
    for (;;) {
      // The Brain-call timer is inactive while transcript, cost, and policy writes run between
      // rounds. Renew before the next round so a slow sequence cannot outlive its owner lease.
      const renewedRevision = await this.repository.renew({
        turnId: claimed.turnId,
        owner: claimed.owner,
        revision,
        now: new Date(),
        leaseMs: this.config.agentProcessingLeaseMs,
      });
      if (renewedRevision === null) return;
      revision = renewedRevision;
      claimed.revision = revision;
      if (publicTextRejections > MAX_PUBLIC_TEXT_REPAIRS) {
        const result = await this.repository.block({
          claimed,
          revision,
          errorCode: 'AGENT_MODEL_UNAVAILABLE',
          summary: '创作助手暂时无法生成安全回复，请稍后重试',
          guardrailType: 'public_text_policy',
        });
        if (result) await this.publishWake(claimed.turnId, result.eventSeq);
        return;
      }
      await this.refreshNativeTranscript(claimed);
      const pendingExecution = claimed.pendingTranscriptExecution;
      if (consecutiveBrainDeliveryFailures >= MAX_CONSECUTIVE_BRAIN_DELIVERY_FAILURES) {
        await this.blockForUnavailableBrain(claimed, revision);
        return;
      }
      const guard = checkLoopGuard(
        loopState,
        this.loopBudget(claimed),
        loopState.consecutiveErrorKey ? { errorKey: loopState.consecutiveErrorKey } : undefined,
      );
      if (guard && !pendingExecution) {
        const result = await this.repository.block({
          claimed,
          revision,
          errorCode:
            guard === 'round_budget' || guard === 'tool_budget'
              ? 'AGENT_LOOP_LIMIT_EXCEEDED'
              : guard === 'repeated_tool_call'
                ? 'AGENT_REPEATED_TOOL_CALL'
                : guard === 'no_progress'
                  ? 'AGENT_NO_PROGRESS_LOOP'
                  : 'AGENT_REPEATED_TOOL_ERROR',
          summary: '当前尝试已停止，请补充信息或调整要求后重试',
          guardrailType: guard,
        });
        if (result) await this.publishWake(claimed.turnId, result.eventSeq);
        return;
      }
      claimed.observations = observations;
      claimed.loopState = loopState;
      claimed.inputTokenTotal = inputTokens;
      claimed.outputTokenTotal = outputTokens;
      if (shouldPrepareMemory && !pendingExecution) {
        const memory = await this.prepareSessionMemory(
          claimed,
          revision,
          loaded,
          authorizedImages,
          confirmedProductFacts,
          [...materializedImageBindingKeys],
          materializedImageDetails,
        );
        if (!memory) return;
        revision = memory.revision;
        claimed.revision = revision;
        loopState = claimed.loopState;
        inputTokens = claimed.inputTokenTotal;
        outputTokens = claimed.outputTokenTotal;
        consecutiveBrainDeliveryFailures = claimed.consecutiveBrainDeliveryFailures;
        if (checkLoopGuard(loopState, this.loopBudget(claimed))) {
          shouldPrepareMemory = false;
          continue;
        }
      }
      shouldPrepareMemory = true;
      if (outputTokens >= this.taskBudget(claimed).outputTokens && !pendingExecution) {
        const result = await this.repository.block({
          claimed,
          revision,
          errorCode: 'AGENT_BUDGET_EXCEEDED',
          summary: '当前对话的模型预算已用尽，请开始新的请求',
          guardrailType: 'token_budget',
        });
        if (result) await this.publishWake(claimed.turnId, result.eventSeq);
        return;
      }
      const modelSnapshot = claimed.modelSnapshot;
      if (modelSnapshot.adapter !== this.config.agentBrainAdapter) {
        throw new Error('AGENT_MODEL_ADAPTER_MISMATCH');
      }
      let llmStep: { stepId: string; stepNo: number };
      let outcome: AgentBrainStepOutcome;
      let draftPublishedThisStep = false;
      if (pendingExecution) {
        llmStep = pendingExecution.step;
        outcome = pendingExecution.outcome;
        if (
          pendingExecution.pricingDrift ||
          compareMoney(pendingExecution.budgetUsed, this.turnCostBudget(modelSnapshot)) > 0
        ) {
          const result = await this.repository.block({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            errorCode: 'AGENT_BUDGET_EXCEEDED',
            summary: '当前对话的模型预算已用尽，请开始新的请求',
            guardrailType: pendingExecution.pricingDrift ? 'pricing_drift' : 'cost_budget',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        this.logger?.info({
          event: 'agent_transcript_pending_call_recovery',
          format: 'transcript_v1',
          type: outcome.type,
          result: 'resumed',
          completed_call_count: pendingExecution.completedOrdinals.length,
        });
        emitTranscriptMetric({
          metric: 'transcript_pending_call_recovery',
          format: 'transcript_v1',
          result: 'recovered',
          value: pendingExecution.completedOrdinals.length,
        });
      } else {
        const brainInput = this.brainInput(
          claimed,
          loaded,
          authorizedImages,
          confirmedProductFacts,
          loopState,
          inputTokens,
          outputTokens,
          [...materializedImageBindingKeys],
          materializedImageDetails,
        );
        const transcript = createNativeTranscriptCapture({
          claimed,
          loaded,
          authorizedImages,
          phase: claimed.authoringPlan ? 'authoring' : 'planning',
          ...(confirmedProductFactDependency
            ? { confirmedFactDependency: confirmedProductFactDependency }
            : {}),
        });
        const requestedInputTokens = await this.brain.countInputTokens(brainInput, modelSnapshot);
        if (!Number.isSafeInteger(requestedInputTokens) || requestedInputTokens < 0) {
          throw new Error('AGENT_INPUT_TOKEN_COUNT_INVALID');
        }
        const requestedInputLimit = this.contextWindowTokens(modelSnapshot) - 1;
        if (requestedInputTokens > requestedInputLimit) {
          const result = await this.repository.block({
            claimed,
            revision,
            errorCode: 'AGENT_BUDGET_EXCEEDED',
            summary: '当前请求内容超过模型上下文限制，请减少内容后重试',
            guardrailType: 'token_budget',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        const requestedMaxOutputTokens = Math.min(
          this.config.agentBrainStepMaxOutputTokens,
          modelSnapshot.capability_contract.max_output_tokens,
          this.contextWindowTokens(modelSnapshot) - requestedInputTokens,
          this.taskBudget(claimed).outputTokens - outputTokens,
        );
        if (requestedMaxOutputTokens <= 0) {
          const result = await this.repository.block({
            claimed,
            revision,
            errorCode: 'AGENT_BUDGET_EXCEEDED',
            summary: '当前对话的模型预算已用尽，请开始新的请求',
            guardrailType: 'token_budget',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        brainInput.remaining_budget.step_output_tokens = requestedMaxOutputTokens;
        this.logger?.info({
          event: 'agent_brain_output_budget',
          trace_id: claimed.traceId,
          step_phase: claimed.authoringPlan ? 'authoring' : 'planning',
          task_units: this.taskBudget(claimed).units,
          max_output_token_total: this.taskBudget(claimed).outputTokens,
          output_token_total: outputTokens,
          requested_max_output_tokens: requestedMaxOutputTokens,
          authoring_completed_count: claimed.authoringCompletedKeys?.length ?? 0,
        });
        const turnCostBudget = this.turnCostBudget(modelSnapshot);
        const exposureCost = calculateAgentBrainExposure({
          pricing: modelSnapshot.pricing,
          requestedInputTokens,
          requestedMaxOutputTokens,
        });
        const contextDisplaySummary = contextActivitySummary({
          completedBrainRounds: loopState.rounds,
          followsImageInspection:
            materializedImageBindingKeys.size > 0 &&
            observations.at(-1)?.tool_name === 'inspect_image@1' &&
            observations.at(-1)?.status === 'succeeded',
        });
        const contextActivityId = randomUUID();
        const contextStarted = await this.repository.startActivity({
          claimed,
          revision,
          activityId: contextActivityId,
          activityType: 'context_reading',
          displaySummary: contextDisplaySummary,
        });
        if (!contextStarted) return;
        await this.publishWake(claimed.turnId, contextStarted.eventSeq);
        const reservation = await this.llmCosts.reserve({
          claimed,
          revision,
          round: loopState.rounds + 1,
          modelSnapshot,
          exposureCost,
          turnBudgetCost: turnCostBudget,
          requestedInputTokens,
          requestedMaxOutputTokens,
          transcript,
        });
        if (!reservation) return;
        if (reservation.kind === 'budget_exceeded') {
          const contextBlocked = await this.repository.finishActivity({
            claimed,
            revision,
            activityId: contextActivityId,
            activityType: 'context_reading',
            displaySummary: contextDisplaySummary,
            status: 'blocked',
          });
          if (contextBlocked) await this.publishWake(claimed.turnId, contextBlocked.eventSeq);
          const result = await this.repository.block({
            claimed,
            revision,
            errorCode: 'AGENT_BUDGET_EXCEEDED',
            summary: '当前对话的模型预算已用尽，请开始新的请求',
            guardrailType: 'cost_budget',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        const reservedStep = reservation.step;
        llmStep = reservedStep;
        const execution = await this.runBrainWithLeaseRenewal(
          claimed,
          revision,
          brainInput,
          llmStep.stepNo,
          llmStep.stepId,
          loaded.map((item) => item.content),
          modelSnapshot,
          requestedMaxOutputTokens,
          resolveAuthorizedImage,
        );
        if (!execution) return;
        draftPublishedThisStep = execution.draftPublished;
        revision = execution.revision;
        claimed.revision = revision;
        let acceptedOutcome = execution.kind === 'outcome' ? execution.outcome : undefined;
        if (
          acceptedOutcome?.type === 'candidate_plan' ||
          acceptedOutcome?.type === 'authoring_request'
        ) {
          const error = creativeDirectionPlanError(claimed, acceptedOutcome.plan);
          if (error)
            acceptedOutcome = {
              type: 'invalid_tool_input',
              error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
              tool: 'agent_candidate_plan',
              paths: ['creative_direction_profile_id'],
              detail: error,
              usage: acceptedOutcome.usage,
            };
        }
        if (acceptedOutcome?.type === 'authoring_batch') {
          acceptedOutcome = await validateAuthoringBatchOutcome({
            outcome: acceptedOutcome,
            draft: claimed.authoringPlan,
            completedKeys: claimed.authoringCompletedKeys ?? [],
            rejectsRepeatedPrompt: (plan) => {
              const candidate = candidatePlanSchema.safeParse(plan);
              if (!candidate.success) return false;
              const profile = resolveCreativeExecutionProfile({
                primarySkillId: claimed.selection.primary_skill_id,
                ...(claimed.selection.execution_policy
                  ? { executionPolicy: claimed.selection.execution_policy }
                  : {}),
                intent: candidate.data.intent.kind,
              });
              return profile !== null && creativeProfileRequiresDistinctPrompts(profile);
            },
          });
        }
        const publicTexts =
          acceptedOutcome?.type === 'respond' || acceptedOutcome?.type === 'chat_text'
            ? [acceptedOutcome.text]
            : acceptedOutcome?.type === 'request_clarification'
              ? [acceptedOutcome.question, ...(acceptedOutcome.suggestions ?? [])]
              : acceptedOutcome?.type === 'tool_calls' && acceptedOutcome.commentary
                ? [acceptedOutcome.commentary]
                : [];
        const rejectedText = publicTexts
          .map((text) =>
            validatePublicText(
              text,
              loaded.map((item) => item.content),
            ),
          )
          .find((checked) => !checked.ok);
        if (acceptedOutcome && rejectedText && !rejectedText.ok) {
          acceptedOutcome = {
            type: 'public_text_rejected',
            error_code: 'AGENT_PUBLIC_TEXT_REJECTED',
            rule: rejectedText.rule,
            usage: acceptedOutcome.usage,
          };
        }
        if (acceptedOutcome?.type === 'chat_text') {
          const missingKnowledge = this.missingKnowledgeForTerminal(claimed, loaded, 'chat_text');
          acceptedOutcome =
            missingKnowledge.length > 0
              ? {
                  type: 'invalid_tool_input',
                  error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID',
                  tool: 'chat_text',
                  paths: ['required_skill_knowledge'],
                  detail: `Load the required Skill before replying: ${missingKnowledge.join(', ')}.`,
                  usage: acceptedOutcome.usage,
                }
              : { ...acceptedOutcome, text: acceptedOutcome.text.normalize('NFC') };
        }
        if (acceptedOutcome?.type === 'respond') {
          acceptedOutcome = { ...acceptedOutcome, text: acceptedOutcome.text.normalize('NFC') };
        }
        if (acceptedOutcome?.type === 'tool_calls' && acceptedOutcome.commentary) {
          acceptedOutcome = {
            ...acceptedOutcome,
            commentary: acceptedOutcome.commentary.normalize('NFC'),
          };
        }
        if (acceptedOutcome?.type === 'request_clarification') {
          acceptedOutcome = {
            ...acceptedOutcome,
            question: acceptedOutcome.question.normalize('NFC'),
            suggestions: acceptedOutcome.suggestions?.map((item) => item.normalize('NFC')),
          };
        }
        if (
          execution.draftPublished &&
          (execution.kind !== 'outcome' ||
            (!['respond', 'chat_text'].includes(acceptedOutcome!.type) &&
              !(acceptedOutcome?.type === 'tool_calls' && acceptedOutcome.commentary)))
        ) {
          const cleared = await this.repository.clearResponseDraft({
            claimed,
            revision,
            stepId: llmStep.stepId,
          });
          if (cleared) await this.publishWake(claimed.turnId, cleared.eventSeq);
        }
        const contextFinished = await this.repository.finishActivity({
          claimed,
          revision,
          activityId: contextActivityId,
          activityType: 'context_reading',
          displaySummary: contextDisplaySummary,
          status:
            execution.kind === 'outcome' &&
            acceptedOutcome?.type !== 'invalid_tool_input' &&
            acceptedOutcome?.type !== 'public_text_rejected' &&
            acceptedOutcome?.type !== 'invalid_terminal_output'
              ? 'succeeded'
              : 'failed',
        });
        if (!contextFinished) return;
        await this.publishWake(claimed.turnId, contextFinished.eventSeq);
        loopState.rounds += 1;
        if (execution.kind === 'unknown') {
          const recorded = await this.llmCosts.markUnknown({
            claimed,
            revision,
            stepId: llmStep.stepId,
            errorCode: execution.errorCode,
            ...(execution.diagnostic ? { diagnostic: execution.diagnostic } : {}),
          });
          if (!recorded || this.writeFence.signal.aborted) return;
          consecutiveBrainDeliveryFailures += 1;
          claimed.consecutiveBrainDeliveryFailures = consecutiveBrainDeliveryFailures;
          // The request may have reached the provider. A new request would be a
          // duplicate charge, so unknown delivery is terminal for this turn.
          await this.blockForUnavailableBrain(claimed, revision, execution);
          return;
        }
        if (execution.kind === 'not_dispatched') {
          const released = await this.llmCosts.releaseNotDispatched({
            claimed,
            revision,
            step: reservedStep,
            errorCode: execution.errorCode,
          });
          if (!released) return;
          consecutiveBrainDeliveryFailures += 1;
          claimed.consecutiveBrainDeliveryFailures = consecutiveBrainDeliveryFailures;
          if (
            !isRetryableAgentBrainNotDispatched(execution.errorCode) ||
            consecutiveBrainDeliveryFailures >= MAX_CONSECUTIVE_BRAIN_DELIVERY_FAILURES
          ) {
            await this.blockForUnavailableBrain(claimed, revision);
            return;
          }
          const delayMs = agentRetryDelayMs({
            attempt: consecutiveBrainDeliveryFailures,
            baseMs: this.config.agentBrainRetryBaseDelayMs,
            maxMs: this.config.agentBrainRetryMaxDelayMs,
          });
          this.logger?.info({
            event: 'agent_brain_retry_backoff',
            trace_id_hash: canonicalSha256(claimed.traceId),
            step_no: llmStep.stepNo,
            retry_no: consecutiveBrainDeliveryFailures,
            delay_ms: delayMs,
            error_code: execution.errorCode,
          });
          await waitForAgentRetry({ delayMs, signal: this.writeFence.signal });
          if (this.writeFence.signal.aborted) return;
          continue;
        }
        consecutiveBrainDeliveryFailures = 0;
        claimed.consecutiveBrainDeliveryFailures = 0;
        outcome = acceptedOutcome!;
        const settled = await this.llmCosts.settle({
          claimed,
          revision,
          step: reservedStep,
          outcome,
          modelSnapshot,
          turnBudgetCost: turnCostBudget,
          transcript,
          maxOutputTokenTotal: this.taskBudget(claimed).outputTokens,
          commentaryProtectedTexts: loaded.map((item) => item.content),
          publishRespond:
            outcome.type === 'respond' &&
            this.missingKnowledgeForTerminal(claimed, loaded, 'respond').length === 0,
        });
        if (!settled) return;
        inputTokens += outcome.usage.input_tokens;
        outputTokens += outcome.usage.output_tokens;
        claimed.inputTokenTotal = inputTokens;
        claimed.outputTokenTotal = outputTokens;
        if (settled.budgetExceeded || settled.pricingDrift) {
          const result = await this.repository.block({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            errorCode: 'AGENT_BUDGET_EXCEEDED',
            summary: '当前对话的模型预算已用尽，请开始新的请求',
            guardrailType: settled.pricingDrift ? 'pricing_drift' : 'cost_budget',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        if (settled.eventSeq !== undefined) {
          await this.publishWake(claimed.turnId, settled.eventSeq);
          if (outcome.type === 'chat_text' || outcome.type === 'respond') return;
        }
      }
      if (outputTokens > this.taskBudget(claimed).outputTokens) {
        const result = await this.repository.block({
          claimed,
          revision,
          llmStepId: llmStep.stepId,
          errorCode: 'AGENT_BUDGET_EXCEEDED',
          summary: '当前对话的模型预算已用尽，请开始新的请求',
          guardrailType: 'token_budget',
        });
        if (result) await this.publishWake(claimed.turnId, result.eventSeq);
        return;
      }
      if (outcome.type === 'public_text_rejected') {
        publicTextRejections += 1;
        continue;
      }
      if (outcome.type === 'invalid_tool_input') {
        modelOutputRejections += 1;
        observations.push({
          tool_name: 'runtime_policy@1',
          status: 'failed',
          summary: {
            public_error_code: outcome.error_code,
            tool: outcome.tool,
            paths: outcome.paths,
            // Schema categories and safe guidance support repair without echoing rejected values.
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
            retryable: modelOutputRejections <= MAX_MODEL_OUTPUT_REPAIRS,
            repair_attempt: modelOutputRejections,
            remaining_repair_attempts: Math.max(
              0,
              MAX_MODEL_OUTPUT_REPAIRS - modelOutputRejections + 1,
            ),
            required_action: 'correct_tool_arguments_or_choose_allowed_action',
          },
        });
        if (modelOutputRejections > MAX_MODEL_OUTPUT_REPAIRS) {
          const result = await this.repository.block({
            claimed,
            revision,
            errorCode: outcome.error_code,
            summary: '创作方案未能形成完整结构，本轮已停止，请重新发送要求',
            guardrailType: 'invalid_model_output',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        continue;
      }
      if (outcome.type === 'invalid_terminal_output') {
        modelOutputRejections += 1;
        observations.push({
          tool_name: 'runtime_policy@1',
          status: 'failed',
          summary: {
            public_error_code: outcome.error_code,
            reason: outcome.reason,
            paths: outcome.paths,
            retryable: modelOutputRejections <= MAX_MODEL_OUTPUT_REPAIRS,
            repair_attempt: modelOutputRejections,
            remaining_repair_attempts: Math.max(
              0,
              MAX_MODEL_OUTPUT_REPAIRS - modelOutputRejections + 1,
            ),
            required_action:
              outcome.reason === 'free_text_without_tool_call'
                ? 'call_one_supported_tool'
                : outcome.reason === 'mixed_text_and_tool_calls'
                  ? 'choose_text_or_tools_not_both'
                  : 'return_nonempty_text_or_call_one_supported_tool',
          },
        });
        if (modelOutputRejections > MAX_MODEL_OUTPUT_REPAIRS) {
          const result = await this.repository.block({
            claimed,
            revision,
            errorCode: outcome.error_code,
            summary: '模型连续返回无效输出，已停止本轮处理，请重新发送需求',
            guardrailType: 'invalid_model_output',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        continue;
      }
      const missingKnowledge = this.missingKnowledgeForTerminal(claimed, loaded, outcome.type);
      if (missingKnowledge.length > 0) {
        if (draftPublishedThisStep) {
          const cleared = await this.repository.clearResponseDraft({
            claimed,
            revision,
            stepId: llmStep.stepId,
          });
          if (cleared) await this.publishWake(claimed.turnId, cleared.eventSeq);
        }
        const progressHash = this.progressHash(loaded);
        const errorKey = canonicalSha256({
          error_code: 'AGENT_SKILL_KNOWLEDGE_REQUIRED',
          missing_skill_ids: missingKnowledge,
        });
        const recorded = await this.repository.recordKnowledgeRequirement({
          claimed,
          revision,
          llmStepId: llmStep.stepId,
          missingSkillIds: missingKnowledge,
          errorKey,
          progressHash,
        });
        if (!recorded) return;
        loopState = recordPolicyObservation(loopState, { progressHash, errorKey });
        observations.push({
          tool_name: 'runtime_policy@1',
          status: 'failed',
          summary: {
            public_error_code: 'AGENT_SKILL_KNOWLEDGE_REQUIRED',
            missing_skill_ids: missingKnowledge,
          },
        });
        continue;
      }
      if (
        pendingExecution &&
        (outcome.type === 'respond' || outcome.type === 'request_clarification')
      ) {
        const publicTexts =
          outcome.type === 'respond'
            ? [outcome.text]
            : [outcome.question, ...(outcome.suggestions ?? [])];
        const rejectedText = publicTexts
          .map((text) =>
            validatePublicText(
              text,
              loaded.map((item) => item.content),
            ),
          )
          .find((checked) => !checked.ok);
        if (rejectedText && !rejectedText.ok) {
          if (publicTextRejections >= MAX_PUBLIC_TEXT_REPAIRS) {
            const result = await this.repository.block({
              claimed,
              revision,
              llmStepId: llmStep.stepId,
              errorCode: 'AGENT_MODEL_UNAVAILABLE',
              summary: '创作助手暂时无法生成安全回复，请稍后重试',
              guardrailType: 'public_text_policy',
            });
            if (result) await this.publishWake(claimed.turnId, result.eventSeq);
            return;
          }
          const recorded = await this.repository.recordPublicTextRejection({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            rule: rejectedText.rule,
          });
          if (!recorded) return;
          publicTextRejections += 1;
          continue;
        }
        if (outcome.type === 'respond') {
          // Only a legacy settled response can reach recovery without a publication receipt.
          const result = await this.repository.completeResponse({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            text: outcome.text.normalize('NFC'),
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        outcome = {
          ...outcome,
          question: outcome.question.normalize('NFC'),
          suggestions: outcome.suggestions?.map((item) => item.normalize('NFC')),
        };
      }
      if (outcome.type === 'respond' || outcome.type === 'chat_text') {
        // New text outcomes publish in the settlement transaction. A missing receipt
        // is a stale write, never a reason to publish after a separate settlement.
        return;
      }
      if (outcome.type === 'request_clarification') {
        const result = await this.repository.requestClarification({
          claimed,
          revision,
          llmStepId: llmStep.stepId,
          question: outcome.question,
          suggestions: outcome.suggestions ?? [],
        });
        if (result) await this.publishWake(claimed.turnId, result.eventSeq);
        return;
      }
      if (outcome.type === 'request_product_facts') {
        const hasProductBinding = claimed.attachments.some(
          (item) =>
            item.binding_key === outcome.source_binding_key &&
            item.kind === 'asset' &&
            item.role === 'product',
        );
        if (!hasProductBinding) {
          const progressHash = this.progressHash(loaded);
          const errorKey = canonicalSha256({
            terminal: 'agent_request_product_facts@1',
            source_binding_key: outcome.source_binding_key,
            error_code: 'REFERENCE_NOT_AVAILABLE',
          });
          const recorded = await this.repository.recordProductFactsUnavailable({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            sourceBindingKey: outcome.source_binding_key,
            errorKey,
            progressHash,
          });
          if (!recorded) return;
          loopState = recordPolicyObservation(loopState, { progressHash, errorKey });
          observations.push({
            tool_name: 'runtime_policy@1',
            status: 'failed',
            summary: {
              public_error_code: 'REFERENCE_NOT_AVAILABLE',
              detail: 'product_facts_unavailable_for_binding',
              source_binding_key: outcome.source_binding_key,
            },
          });
          continue;
        }
        const productFacts = await this.repository.requestProductFacts({
          claimed,
          revision,
          llmStepId: llmStep.stepId,
          sourceBindingKey: outcome.source_binding_key,
          candidateFacts: outcome.candidate_facts,
          evidenceDigest: canonicalSha256(outcome.evidence),
        });
        if (!productFacts) return;
        if (productFacts.status === 'requested') {
          await this.publishWake(claimed.turnId, productFacts.eventSeq);
          return;
        }
        const refreshedFacts = await this.imageContext.resolveConfirmedProductFactsContext(claimed);
        confirmedProductFacts = refreshedFacts?.facts;
        confirmedProductFactDependency = refreshedFacts?.dependency;
        observations.push({
          tool_name: 'runtime_policy@1',
          status: 'succeeded',
          summary: { product_facts: 'already_confirmed' },
        });
        continue;
      }
      if (outcome.type === 'candidate_plan') {
        await this.handleCandidatePlan(claimed, revision, llmStep.stepId, outcome.plan);
        return;
      }
      if (outcome.type === 'authoring_batch') {
        if (!claimed.authoringPlan) throw new Error('AGENT_AUTHORING_DRAFT_MISSING');
        const completed = claimed.authoringCompletedKeys ?? [];
        const pendingKeys = authoringCandidateKeys(claimed.authoringPlan).filter(
          (key) => !completed.includes(key),
        );
        const plan = mergeAuthoredPromptBatch(
          claimed.authoringPlan,
          outcome.authoring_output.arguments,
          pendingKeys.slice(0, 1),
        );
        if (pendingKeys.length === 1) {
          await this.handleCandidatePlan(claimed, revision, llmStep.stepId, plan);
          return;
        }
        if (
          !(await this.repository.saveAuthoringBatch({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
          }))
        )
          return;
        claimed.authoringPlan = plan;
        claimed.authoringCompletedKeys = [...completed, pendingKeys[0]!];
        continue;
      }
      if (outcome.type === 'authoring_request') {
        if (
          !(await this.repository.beginAuthoring({ claimed, revision, llmStepId: llmStep.stepId }))
        )
          return;
        claimed.authoringPlan = outcome.plan;
        continue;
      }
      const imageInspectionCalls = outcome.calls.filter((call) => call.name === 'inspect_image@1');
      const skillCalls = outcome.calls.filter((call) => call.name === 'load_skill@1');
      if (
        outcome.calls.length > modelSnapshot.capability_contract.max_tool_calls_per_response ||
        (imageInspectionCalls.length > 0 && skillCalls.length > 0) ||
        outcome.calls.some(
          (call) => call.name !== 'load_skill@1' && call.name !== 'inspect_image@1',
        )
      ) {
        // The tool list is stable across rounds, so the model can emit a batch that violates the
        // batch-shape policy. Close the whole semantic batch as rejected, feed a bounded
        // observation back and keep counting the batch against the loop budget instead of failing
        // the turn; a repeated violation still blocks through the invalid-output guardrail.
        modelOutputRejections += 1;
        if (modelOutputRejections > MAX_MODEL_OUTPUT_REPAIRS) {
          const result = await this.repository.block({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            errorCode: 'AGENT_TOOL_NOT_ALLOWED',
            summary: '本轮工具调用批次不符合要求，已停止，请重新发送要求',
            guardrailType: 'invalid_model_output',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        const progressHash = this.progressHash(loaded);
        const errorKey = canonicalSha256({
          error_code: 'AGENT_TOOL_NOT_ALLOWED',
          call_count: outcome.calls.length,
        });
        const recorded = await this.repository.recordIllegalToolBatch({
          claimed,
          revision,
          llmStepId: llmStep.stepId,
          errorCode: 'AGENT_TOOL_NOT_ALLOWED',
          callCount: outcome.calls.length,
          errorKey,
          progressHash,
          repairAttempt: modelOutputRejections,
        });
        if (!recorded) return;
        observations.push({
          tool_name: 'runtime_policy@1',
          status: 'failed',
          summary: {
            public_error_code: 'AGENT_TOOL_NOT_ALLOWED',
            call_count: outcome.calls.length,
            retryable: modelOutputRejections <= MAX_MODEL_OUTPUT_REPAIRS,
            repair_attempt: modelOutputRejections,
            remaining_repair_attempts: Math.max(
              0,
              MAX_MODEL_OUTPUT_REPAIRS - modelOutputRejections + 1,
            ),
            required_action: 'return_one_allowed_tool_class_or_a_single_terminal_action',
          },
        });
        continue;
      }
      if (imageInspectionCalls.length > 0) {
        for (const [callIndex, call] of imageInspectionCalls.entries()) {
          if (pendingExecution?.completedOrdinals.includes(callIndex)) continue;
          const args = inspectImageArgumentsSchema.parse(call.arguments);
          const image = authorizedImages.find((item) => item.binding_key === args.binding_key);
          if (!image || (image.image_ref ?? image.binding_key) !== args.binding_key) {
            throw new Error('AGENT_IMAGE_BINDING_INVALID');
          }
          const fingerprint = toolFingerprint({
            toolName: 'inspect_image',
            contractVersion: 1,
            normalizedArgs: args,
            bindingVersions: [image.content_hash],
          });
          // This model round is already settled. Its tools consume the tool budget; the round
          // limit is checked before requesting the next model, not halfway through this batch.
          const toolGuard = checkLoopGuard(
            loopState,
            { ...this.loopBudget(claimed), maxRounds: loopState.rounds + 1 },
            { fingerprint },
          );
          if (toolGuard) {
            const result = await this.repository.block({
              claimed,
              revision,
              llmStepId: llmStep.stepId,
              errorCode:
                toolGuard === 'repeated_tool_call'
                  ? 'AGENT_REPEATED_TOOL_CALL'
                  : 'AGENT_LOOP_LIMIT_EXCEEDED',
              summary: '相同图片查看请求重复过多，当前尝试已停止',
              guardrailType:
                toolGuard === 'repeated_tool_call' ? 'repeated_tool_call' : 'tool_budget',
            });
            if (result) await this.publishWake(claimed.turnId, result.eventSeq);
            return;
          }
          await resolveAuthorizedImage(image, args.detail);
          materializedImageBindingKeys.add(args.binding_key);
          materializedImageDetails[args.binding_key] = args.detail;
          const imageProgressHash = canonicalSha256({
            loaded_resource_snapshot_ids: loaded
              .map((item) => item.resource.resource_snapshot_id)
              .sort(),
            materialized_image_binding_keys: [...materializedImageBindingKeys].sort(),
            materialized_image_details: materializedImageDetails,
          });
          const recorded = await this.repository.finishImageInspection({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            callOrdinal: callIndex,
            callPositionKey: callPositionKey({
              turnId: claimed.turnId,
              continuationNo: claimed.continuationNo,
              llmStepNo: llmStep.stepNo,
              callIndex,
            }),
            toolFingerprint: fingerprint,
            argsHash: canonicalSha256(args),
            bindingKey: args.binding_key,
            detail: args.detail,
            materializedBindingKeys: [...materializedImageBindingKeys].sort(),
            materializedImageDetails,
            progressHash: imageProgressHash,
            callCount: outcome.calls.length,
          });
          if (!recorded) return;
          loopState = recordCompletedObservation(loopState, {
            fingerprint,
            progressHash: imageProgressHash,
          });
          observations.push({
            tool_name: 'inspect_image@1',
            status: 'succeeded',
            summary: {
              binding_key: args.binding_key,
              detail: args.detail,
              materialized: true,
            },
          });
        }
        continue;
      }
      const activity = await this.repository.startKnowledgeActivity({
        claimed,
        revision,
        activityId: llmStep.stepId,
      });
      if (!activity) return;
      await this.publishWake(claimed.turnId, activity.eventSeq);
      let knowledgeBatchFailed = false;
      for (const [callIndex, call] of outcome.calls.entries()) {
        if (pendingExecution?.completedOrdinals.includes(callIndex)) continue;
        const args = loadSkillArgumentsSchema.parse(call.arguments);
        const argsHash = canonicalSha256(args);
        const fingerprint = toolFingerprint({
          toolName: 'load_skill',
          contractVersion: 1,
          normalizedArgs: args,
          bindingVersions: loaded.map((item) => item.resource.resource_hash),
        });
        const toolGuard = checkLoopGuard(
          loopState,
          { ...this.loopBudget(claimed), maxRounds: loopState.rounds + 1 },
          { fingerprint },
        );
        if (toolGuard) {
          const finishedActivity = await this.repository.finishKnowledgeActivity({
            claimed,
            revision,
            activityId: llmStep.stepId,
            publicErrorCode: 'AGENT_REPEATED_TOOL_CALL',
            status: 'blocked',
          });
          if (!finishedActivity) return;
          await this.publishWake(claimed.turnId, finishedActivity.eventSeq);
          const result = await this.repository.block({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            errorCode: 'AGENT_REPEATED_TOOL_CALL',
            summary: '相同能力被重复调用，当前尝试已停止',
            guardrailType: 'repeated_tool_call',
          });
          if (result) await this.publishWake(claimed.turnId, result.eventSeq);
          return;
        }
        let newlyLoaded: LoadedSkillResource[];
        try {
          newlyLoaded =
            args.view === 'planning'
              ? await runtime.loadPlanning(claimed.selection, args.skill_id)
              : await runtime.loadReferences(
                  claimed.selection,
                  args.skill_id,
                  // parse() + superRefine guarantee a non-empty array for the references
                  // view; the fallback only narrows the optional type.
                  args.reference_paths ?? [],
                );
          const prospective = new Map(
            [...loaded, ...newlyLoaded].map((item) => [item.resource.resource_snapshot_id, item]),
          );
          const referenceCount = [...prospective.values()].filter((item) =>
            item.resource.resource_path.startsWith('references/'),
          ).length;
          const knowledgeTokens = [...prospective.values()].reduce(
            (total, item) => total + item.tokenCount,
            0,
          );
          if (
            referenceCount > this.config.agentMaxReferences ||
            knowledgeTokens > this.contextWindowTokens(modelSnapshot)
          ) {
            throw new Error('SKILL_RESOURCE_LIMIT_EXCEEDED');
          }
        } catch (error) {
          const errorCode = this.publicErrorCode(error);
          const diagnosticCode = stableErrorCode(error);
          const errorKey = canonicalSha256({
            tool_name: 'load_skill@1',
            args_hash: argsHash,
            error_code: errorCode,
          });
          const currentProgressHash = this.progressHash(loaded);
          const failedActivity = await this.repository.finishToolFailure({
            claimed,
            revision,
            llmStepId: llmStep.stepId,
            callOrdinal: callIndex,
            skillId: args.skill_id,
            toolName: 'load_skill@1',
            callPositionKey: callPositionKey({
              turnId: claimed.turnId,
              continuationNo: claimed.continuationNo,
              llmStepNo: llmStep.stepNo,
              callIndex,
            }),
            toolFingerprint: fingerprint,
            argsHash,
            errorCode,
            diagnosticCode,
            errorKey,
            progressHash: currentProgressHash,
            callCount: outcome.calls.length,
          });
          if (failedActivity) await this.publishWake(claimed.turnId, failedActivity.eventSeq);
          loopState = recordCompletedObservation(loopState, {
            fingerprint,
            progressHash: currentProgressHash,
            errorKey,
          });
          observations.push({
            tool_name: 'load_skill@1',
            status: 'failed',
            summary: { public_error_code: errorCode },
          });
          knowledgeBatchFailed = true;
          break;
        }
        for (const resource of newlyLoaded) {
          if (
            !loaded.some(
              (item) =>
                item.resource.resource_snapshot_id === resource.resource.resource_snapshot_id,
            )
          ) {
            loaded.push(resource);
          }
        }
        const persisted = await this.repository.finishTool({
          claimed,
          revision,
          llmStepId: llmStep.stepId,
          callOrdinal: callIndex,
          loadedResources: newlyLoaded,
          skillId: args.skill_id,
          toolName: 'load_skill@1',
          callPositionKey: callPositionKey({
            turnId: claimed.turnId,
            continuationNo: claimed.continuationNo,
            llmStepNo: llmStep.stepNo,
            callIndex,
          }),
          toolFingerprint: fingerprint,
          argsHash,
          outputSummary: {
            view: args.view,
            already_loaded: newlyLoaded.every((item) => item.alreadyLoaded),
            resource_snapshot_ids: newlyLoaded.map((item) => item.resource.resource_snapshot_id),
            token_count: newlyLoaded.reduce((total, item) => total + item.tokenCount, 0),
          },
          progressHash: this.progressHash(loaded),
          callCount: outcome.calls.length,
          finishActivity: callIndex === outcome.calls.length - 1,
        });
        if (!persisted) return;
        if (persisted.eventSeq !== null) {
          await this.publishWake(claimed.turnId, persisted.eventSeq);
        }
        loopState = recordCompletedObservation(loopState, {
          fingerprint,
          progressHash: this.progressHash(loaded),
        });
        observations.push({
          tool_name: 'load_skill@1',
          status: 'succeeded',
          summary: {
            skill_id: args.skill_id,
            view: args.view,
            reference_paths: args.view === 'references' ? args.reference_paths : undefined,
            already_loaded: newlyLoaded.every((item) => item.alreadyLoaded),
          },
        });
      }
      if (knowledgeBatchFailed) continue;
    }
  }

  private async handleCandidatePlan(
    claimed: ClaimedAgentTurn,
    revision: number,
    llmStepId: string,
    rawCandidate: unknown,
  ): Promise<void> {
    const candidate = candidatePlanSchema.safeParse(rawCandidate);
    if (candidate.success && claimed.modelSelection) {
      const safetyActivityId = randomUUID();
      const safetyStarted = await this.repository.startActivity({
        claimed,
        revision,
        activityId: safetyActivityId,
        activityType: 'safety_checking',
      });
      if (!safetyStarted) return;
      await this.publishWake(claimed.turnId, safetyStarted.eventSeq);
      let preflight: Awaited<ReturnType<ContentSafetyPreflightService['execute']>>;
      try {
        preflight = await this.contentSafety.execute(claimed, candidate.data);
      } catch (error) {
        const safetyFailed = await this.repository.finishActivity({
          claimed,
          revision,
          activityId: safetyActivityId,
          activityType: 'safety_checking',
          status: 'failed',
        });
        if (safetyFailed) await this.publishWake(claimed.turnId, safetyFailed.eventSeq);
        throw error;
      }
      const safetyFinished = await this.repository.finishActivity({
        claimed,
        revision,
        activityId: safetyActivityId,
        activityType: 'safety_checking',
        status:
          preflight.status === 'passed'
            ? 'succeeded'
            : preflight.status === 'blocked'
              ? 'blocked'
              : preflight.status === 'pending'
                ? 'cancelled'
                : 'failed',
      });
      if (!safetyFinished) return;
      await this.publishWake(claimed.turnId, safetyFinished.eventSeq);
      if (preflight.status === 'pending') throw new AgentPreflightPendingError(preflight.retryAt);
      if (preflight.status === 'not_dispatched') throw new AgentPreflightNotDispatchedError();
      if (preflight.status === 'blocked') {
        const result = await this.repository.block({
          claimed,
          revision,
          llmStepId,
          errorCode: 'CONTENT_SAFETY_BLOCKED',
          summary: '内容未通过安全审核，无法继续生成。',
          guardrailType: 'content_safety',
        });
        if (result) await this.publishWake(claimed.turnId, result.eventSeq);
        return;
      }
      if (preflight.status === 'outcome_unknown') {
        const result = await this.repository.block({
          claimed,
          revision,
          llmStepId,
          errorCode: 'CONTENT_SAFETY_UNAVAILABLE',
          summary: '内容安全审核暂时无法完成，请稍后重试。',
          guardrailType: 'content_safety',
        });
        if (result) await this.publishWake(claimed.turnId, result.eventSeq);
        return;
      }
    }
    const planActivityId = randomUUID();
    const planStarted = await this.repository.startActivity({
      claimed,
      revision,
      activityId: planActivityId,
      activityType: 'plan_preparing',
    });
    if (!planStarted) return;
    await this.publishWake(claimed.turnId, planStarted.eventSeq);
    let compiled: ReturnType<typeof compilePlan>;
    let context: CompilerContext | undefined;
    try {
      context = candidate.success ? await this.compilerContext.build(claimed) : undefined;
      compiled = compilePlan({
        candidate: rawCandidate,
        context: context ?? {},
        registry: this.capabilityRegistry,
      });
    } catch (error) {
      const planFailed = await this.repository.finishActivity({
        claimed,
        revision,
        activityId: planActivityId,
        activityType: 'plan_preparing',
        status: 'failed',
      });
      if (planFailed) await this.publishWake(claimed.turnId, planFailed.eventSeq);
      throw error;
    }
    const needsCrossGroupClarification =
      compiled.status === 'rejected' &&
      compiled.code === 'clarification_required' &&
      compiled.details.some(
        (detail) => detail.rule_id === 'cross_upload_group_confirmation_required',
      );
    if (needsCrossGroupClarification && candidate.success && context) {
      const scope = crossUploadGroupScope(candidate.data, context.bindings);
      if (!scope) throw new Error('AGENT_CROSS_GROUP_SCOPE_INVALID');
      const planFinished = await this.repository.finishActivity({
        claimed,
        revision,
        activityId: planActivityId,
        activityType: 'plan_preparing',
        status: 'cancelled',
      });
      if (!planFinished) return;
      await this.publishWake(claimed.turnId, planFinished.eventSeq);
      const result = await this.repository.requestClarification({
        claimed,
        revision,
        llmStepId,
        question: `这次计划使用 ${scope.groupCount} 组上传中的 ${scope.sourceCount} 张照片，生成 ${scope.outputCount} 张作品。要同时处理这些上传组吗？`,
        suggestions: ['只处理最近上传的照片', '同时处理这些上传组'],
        scopeDigest: scope.digest,
      });
      if (result) await this.publishWake(claimed.turnId, result.eventSeq);
      return;
    }
    const planFinished = await this.repository.finishActivity({
      claimed,
      revision,
      activityId: planActivityId,
      activityType: 'plan_preparing',
      status: compiled.status === 'compiled' ? 'succeeded' : 'blocked',
    });
    if (!planFinished) return;
    await this.publishWake(claimed.turnId, planFinished.eventSeq);
    const result =
      compiled.status === 'compiled'
        ? await this.compilerRepository.persistCompiled({
            claimed,
            revision,
            llmStepId,
            compiled,
          })
        : await this.compilerRepository.persistRejected({
            claimed,
            revision,
            llmStepId,
            rejection: compiled,
          });
    if (result) await this.publishWake(claimed.turnId, result.eventSeq);
  }

  private async blockForUnavailableBrain(
    claimed: ClaimedAgentTurn,
    revision: number,
    failure?: { errorCode: string; diagnostic?: AgentBrainDiagnostic },
  ): Promise<void> {
    const result = await this.repository.block({
      claimed,
      revision,
      errorCode: 'AGENT_MODEL_UNAVAILABLE',
      summary: failure
        ? agentBrainPublicFailure(failure.errorCode, failure.diagnostic)
        : '创作助手暂时不可用，请稍后重试',
    });
    if (result) await this.publishWake(claimed.turnId, result.eventSeq);
  }

  private brainInput(
    claimed: ClaimedAgentTurn,
    loaded: LoadedSkillResource[],
    authorizedImages: AgentBrainStepInput['authorized_images'],
    confirmedProductFacts: AgentBrainStepInput['confirmed_product_facts'],
    loopState: LoopState,
    inputTokens: number,
    outputTokens: number,
    materializedImageBindingKeys: readonly string[] = [],
    materializedImageDetails: Readonly<Record<string, AgentBrainImageDetail>> = {},
  ): AgentBrainStepInput {
    if (claimed.transcriptCaptureVersion !== 1 || !claimed.transcriptGeneration)
      throw new Error('AGENT_TRANSCRIPT_CAPTURE_REQUIRED');
    const generationPreferences = this.brainGenerationPreferences(claimed);
    const creativeDirection = turnCreativeDirection(claimed);
    const defaultOutputCount = claimed.effectiveSkillDefaultOutputCount;
    if (
      typeof defaultOutputCount !== 'number' ||
      !Number.isInteger(defaultOutputCount) ||
      defaultOutputCount < 1 ||
      defaultOutputCount > 16
    ) {
      throw new Error('SKILL_DEFAULT_OUTPUT_COUNT_UNAVAILABLE');
    }
    // Prompt authoring is an image-generation concern, not a property of the
    // selected Brain adapter. Keep ordinary/general Agent turns on the normal
    // tool loop, while image-capable turns may opt into the authoring handoff.
    const promptAuthoring =
      claimed.modelSnapshot.adapter === 'approved' &&
      claimed.requiredGenerationCapabilities.some(
        (capability) => capability === 'image.generate' || capability === 'image.edit',
      );
    return {
      current_message: claimed.message,
      prompt_authoring: promptAuthoring,
      ...(claimed.authoringPlan ? { authoring_plan: claimed.authoringPlan } : {}),
      ...(claimed.authoringPlan
        ? {
            authoring_candidate_keys: authoringCandidateKeys(claimed.authoringPlan)
              .filter((key) => !(claimed.authoringCompletedKeys ?? []).includes(key))
              .slice(0, 1),
          }
        : {}),
      execution_format: 'transcript_v1',
      transcript_generation: claimed.transcriptGeneration,
      transcript_messages: claimed.transcriptMessages ?? [],
      ...(claimed.transcriptSummary ? { session_summary: claimed.transcriptSummary.content } : {}),
      ...(generationPreferences ? { generation_preferences: generationPreferences } : {}),
      ...(creativeDirection ? { creative_direction: creativeDirection } : {}),
      authorized_images: authorizedImages,
      ...(claimed.sessionImageCandidatesUnavailable
        ? { session_image_candidates_unavailable: true }
        : {}),
      materialized_image_binding_keys: [...new Set(materializedImageBindingKeys)].sort(),
      materialized_image_details: Object.fromEntries(
        Object.entries(materializedImageDetails).filter(([bindingKey]) =>
          materializedImageBindingKeys.includes(bindingKey),
        ),
      ),
      ...(confirmedProductFacts ? { confirmed_product_facts: confirmedProductFacts } : {}),
      skill_selection: {
        ...(claimed.selection.execution_policy
          ? { execution_policy: claimed.selection.execution_policy }
          : {}),
        primary_skill_id: claimed.selection.primary_skill_id,
        primary_name: claimed.selection.primary_name,
        default_output_count: defaultOutputCount,
        preset_names: claimed.selection.preset_selections.map((item) => item.name),
        required_capabilities: claimed.requiredGenerationCapabilities,
      },
      loaded_skills: loaded.map((item) => ({
        skill_id: item.skillId,
        name: item.name,
        content: item.content,
        resource_path: item.resource.resource_path,
      })),
      optional_auxiliary_catalog: claimed.selection.optional_auxiliary.map((item) => ({
        skill_id: item.skill_id,
        name: item.name,
      })),
      required_auxiliary_catalog: claimed.selection.required_auxiliary.map((item) => ({
        skill_id: item.skill_id,
        name: item.name,
      })),
      // Native tool and policy results are already ordered transcript messages. A second
      // observation channel would let trace diagnostics change model semantics after recovery.
      observations: [],
      enabled_tools: [
        {
          name: 'inspect_image',
          contract_version: 1,
          description: 'Inspect one authorized opaque image reference.',
        },
        {
          name: 'load_skill',
          contract_version: 1,
          description: 'Load allowed optional Skill knowledge or references.',
        },
      ],
      remaining_budget: {
        rounds: this.taskBudget(claimed).rounds - loopState.rounds,
        tool_calls: this.taskBudget(claimed).toolCalls - loopState.toolCalls,
        input_tokens: this.contextWindowTokens(claimed.modelSnapshot),
        output_tokens: this.taskBudget(claimed).outputTokens - outputTokens,
        step_output_tokens: Math.min(
          this.config.agentBrainStepMaxOutputTokens,
          claimed.modelSnapshot.capability_contract.max_output_tokens,
          this.taskBudget(claimed).outputTokens - outputTokens,
        ),
      },
    };
  }

  private async refreshNativeTranscript(claimed: ClaimedAgentTurn): Promise<void> {
    if (claimed.transcriptCaptureVersion !== 1) return;
    if (!claimed.transcriptGeneration) throw new Error('AGENT_TRANSCRIPT_GENERATION_MISSING');
    if (
      claimed.transcriptSummary &&
      !(await new NativeTranscriptDependencies(this.database).authorize(
        claimed.userId,
        claimed.transcriptSummary.resource_dependencies,
        claimed.sessionId,
      ))
    )
      throw new Error('AGENT_SESSION_SUMMARY_DEPENDENCY_UNAVAILABLE');
    // A durable v2 checkpoint bounds the model window: read only the coverage that follows it.
    const firstSequence = claimed.transcriptSummary
      ? (BigInt(claimed.transcriptSummary.covered_through_sequence) + 1n).toString()
      : '1';
    const window = await createNativeTranscriptReader(this.database).readCurrentWindow({
      userId: claimed.userId,
      sessionId: claimed.sessionId,
      expectedGeneration: claimed.transcriptGeneration,
      firstSequence,
      requireClosed: false,
    });
    claimed.transcriptItems = window.items;
    claimed.transcriptMessages = projectNativeTranscriptMessages(
      window.items,
      claimed.userMessageId,
    );
    const runtimeState = restoreNativeTranscriptRuntimeState(
      window.items,
      claimed,
      claimed.loadedResourceSnapshotIds,
    );
    claimed.loadedResourceSnapshotIds = runtimeState.loadedResourceSnapshotIds;
    claimed.materializedImageBindingKeys = runtimeState.materializedImageBindingKeys;
    claimed.materializedImageDetails = runtimeState.materializedImageDetails;
    // Bounded projection-token sample (bytes/4 estimate); never the raw projected content.
    emitTranscriptMetric({
      metric: 'transcript_projection_tokens',
      format: 'transcript_v1',
      type: 'window',
      result: 'ok',
      value: transcriptMetricValue(
        Buffer.byteLength(JSON.stringify(claimed.transcriptMessages ?? []), 'utf8') / 4,
      ),
    });
    const recovery = await readNativeTranscriptRecovery(this.database, window.items, claimed);
    if (recovery.authoringPlan) claimed.authoringPlan = recovery.authoringPlan;
    else delete claimed.authoringPlan;
    claimed.authoringCompletedKeys = recovery.authoringCompletedKeys;
    if (recovery.pending) claimed.pendingTranscriptExecution = recovery.pending;
    else delete claimed.pendingTranscriptExecution;
  }

  private brainGenerationPreferences(
    claimed: ClaimedAgentTurn,
  ): AgentBrainStepInput['generation_preferences'] {
    const preferences = claimed.generationPreferences;
    if (!preferences) return undefined;
    const supportedAspectRatios = claimed.modelSelection?.image.supported_aspect_ratios;
    if (
      preferences.aspect_ratio === 'auto' &&
      (!supportedAspectRatios || supportedAspectRatios.length === 0)
    ) {
      throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
    }
    if (
      preferences.aspect_ratio !== 'auto' &&
      supportedAspectRatios &&
      !supportedAspectRatios.includes(preferences.aspect_ratio)
    ) {
      throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
    }
    return {
      aspect_ratio: preferences.aspect_ratio,
      resolution_tier: preferences.resolution_tier,
      supported_aspect_ratios: supportedAspectRatios ?? [preferences.aspect_ratio],
      max_prompt_characters: imageCreativePromptMaxCharacters(
        claimed.modelSelection?.image.max_prompt_characters,
      ),
    };
  }

  private async runBrainWithLeaseRenewal(
    claimed: ClaimedAgentTurn,
    initialRevision: number,
    input: AgentBrainStepInput,
    stepNo: number,
    stepId: string,
    privateSkillContent: readonly string[],
    modelSnapshot: ClaimedAgentTurn['modelSnapshot'],
    requestedMaxOutputTokens: number,
    resolveAuthorizedImage: AgentBrainImageResolver,
  ) {
    let revision = initialRevision;
    let ownershipLost = false;
    let renewal = Promise.resolve();
    const leaseAbort = new AbortController();
    const publicDraft = new AgentPublicDraft(
      privateSkillContent,
      async (draftSeq, textDelta) => {
        if (ownershipLost || this.writeFence.signal.aborted || leaseAbort.signal.aborted) {
          return false;
        }
        const requestedRevision = revision;
        let appended = await this.repository.appendResponseDraft({
          claimed,
          revision: requestedRevision,
          stepId,
          draftSeq,
          textDelta,
        });
        if (!appended && !ownershipLost) {
          await renewal;
          if (revision !== requestedRevision && !ownershipLost) {
            appended = await this.repository.appendResponseDraft({
              claimed,
              revision,
              stepId,
              draftSeq,
              textDelta,
            });
          }
        }
        if (!appended) {
          ownershipLost = true;
          leaseAbort.abort(new Error('AGENT_PROCESSING_LEASE_LOST'));
          return false;
        }
        await this.publishWake(claimed.turnId, appended.eventSeq).catch(() => undefined);
        return true;
      },
      async () => {
        const requestedRevision = revision;
        let cleared = await this.repository.clearResponseDraft({
          claimed,
          revision: requestedRevision,
          stepId,
        });
        if (!cleared && !ownershipLost) {
          await renewal;
          if (revision !== requestedRevision && !ownershipLost) {
            cleared = await this.repository.clearResponseDraft({ claimed, revision, stepId });
          }
        }
        if (cleared) {
          await this.publishWake(claimed.turnId, cleared.eventSeq).catch(() => undefined);
        }
      },
    );
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        if (ownershipLost) return;
        const next = await this.repository.renew({
          turnId: claimed.turnId,
          owner: claimed.owner,
          revision,
          now: new Date(),
          leaseMs: this.config.agentProcessingLeaseMs,
        });
        if (next === null) {
          ownershipLost = true;
          leaseAbort.abort(new Error('AGENT_PROCESSING_LEASE_LOST'));
          return;
        }
        revision = next;
        claimed.revision = revision;
      });
    }, this.config.agentProcessingRenewMs);
    timer.unref();
    try {
      const requestTimeoutMs = Math.min(
        this.config.agentRequestTimeoutMs,
        modelSnapshot.quota.terminal_timeout_ms,
      );
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      let outcome;
      try {
        outcome = parseAgentBrainStepOutcome(
          await this.brain.runStep(input, {
            abortSignal: AbortSignal.any([timeout, this.writeFence.signal, leaseAbort.signal]),
            deadline: new Date(Date.now() + requestTimeoutMs),
            idempotencyKey: canonicalSha256({
              trace_id: claimed.traceId,
              continuation_no: claimed.continuationNo,
              step_no: stepNo,
            }),
            modelSnapshot,
            requestedMaxOutputTokens,
            traceId: claimed.traceId,
            onPublicTextDraft: (text) => publicDraft.accept(text),
            resolveAuthorizedImage,
            maxConcurrentImageMaterializations:
              this.config.agentBrainImageMaterializationConcurrency,
          }),
        );
      } catch (error) {
        clearInterval(timer);
        await renewal;
        if (ownershipLost || this.writeFence.signal.aborted) return null;
        await publicDraft.discard();
        const diagnostic = error instanceof AgentBrainCallError ? error.diagnostic : undefined;
        // Only a request the transport proved never left the machine may be released and retried.
        // A provider timeout or 5xx response means the request may already have been processed:
        // keep its exposure and terminate the turn (`docs/04` three-state contract).
        if (error instanceof AgentBrainCallError && error.delivery === 'not_dispatched') {
          return {
            kind: 'not_dispatched' as const,
            revision,
            errorCode: error.message,
            draftPublished: false,
          };
        }
        const errorCode =
          error instanceof AgentBrainCallError ? error.message : 'AGENT_CALL_OUTCOME_UNKNOWN';
        this.logger?.error({
          event: 'agent_brain_call_unknown',
          trace_id_hash: canonicalSha256(claimed.traceId),
          step_no: stepNo,
          error_code: errorCode,
          ...(diagnostic ? { diagnostic } : {}),
        });
        return {
          kind: 'unknown' as const,
          revision,
          errorCode,
          draftPublished: false,
          ...(diagnostic ? { diagnostic } : {}),
        };
      }
      clearInterval(timer);
      await renewal;
      if (ownershipLost) return null;
      return { kind: 'outcome' as const, outcome, revision, draftPublished: publicDraft.published };
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  private async runSessionSummaryWithLeaseRenewal(
    claimed: ClaimedAgentTurn,
    initialRevision: number,
    input: Parameters<NonNullable<AgentBrainPort['summarizeSession']>>[0],
    stepNo: number,
    requestedMaxOutputTokens: number,
  ) {
    const summarizeSession = this.brain.summarizeSession?.bind(this.brain);
    if (!summarizeSession) {
      return { kind: 'not_dispatched' as const, revision: initialRevision };
    }
    let revision = initialRevision;
    let ownershipLost = false;
    let renewal = Promise.resolve();
    const leaseAbort = new AbortController();
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        if (ownershipLost) return;
        const next = await this.repository.renew({
          turnId: claimed.turnId,
          owner: claimed.owner,
          revision,
          now: new Date(),
          leaseMs: this.config.agentProcessingLeaseMs,
        });
        if (next === null) {
          ownershipLost = true;
          leaseAbort.abort(new Error('AGENT_PROCESSING_LEASE_LOST'));
          return;
        }
        revision = next;
        claimed.revision = revision;
      });
    }, this.config.agentProcessingRenewMs);
    timer.unref();
    try {
      const requestTimeoutMs = Math.min(
        this.config.agentRequestTimeoutMs,
        claimed.modelSnapshot.quota.terminal_timeout_ms,
      );
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      try {
        const outcome = await summarizeSession(input, {
          abortSignal: AbortSignal.any([timeout, this.writeFence.signal, leaseAbort.signal]),
          deadline: new Date(Date.now() + requestTimeoutMs),
          idempotencyKey: canonicalSha256({
            trace_id: claimed.traceId,
            continuation_no: claimed.continuationNo,
            step_no: stepNo,
            purpose: 'session_compaction',
          }),
          modelSnapshot: claimed.modelSnapshot,
          requestedMaxOutputTokens,
          traceId: claimed.traceId,
        });
        clearInterval(timer);
        await renewal;
        if (ownershipLost) return null;
        return { kind: 'outcome' as const, outcome, revision };
      } catch (error) {
        clearInterval(timer);
        await renewal;
        if (ownershipLost || this.writeFence.signal.aborted) return null;
        if (error instanceof AgentBrainCallError && error.delivery === 'not_dispatched') {
          return { kind: 'not_dispatched' as const, revision, errorCode: error.message };
        }
        const diagnostic = error instanceof AgentBrainCallError ? error.diagnostic : undefined;
        const errorCode =
          error instanceof AgentBrainCallError ? error.message : 'AGENT_CALL_OUTCOME_UNKNOWN';
        this.logger?.error({
          event: 'agent_brain_summary_unknown',
          trace_id_hash: canonicalSha256(claimed.traceId),
          step_no: stepNo,
          error_code: errorCode,
          ...(diagnostic ? { diagnostic } : {}),
        });
        return {
          kind: 'unknown' as const,
          revision,
          errorCode,
          ...(diagnostic ? { diagnostic } : {}),
        };
      }
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  private missingKnowledgeForTerminal(
    claimed: ClaimedAgentTurn,
    loaded: LoadedSkillResource[],
    outcomeType:
      | 'respond'
      | 'chat_text'
      | 'request_clarification'
      | 'request_product_facts'
      | 'candidate_plan'
      | 'authoring_request'
      | 'authoring_batch'
      | 'tool_calls',
  ): string[] {
    if (outcomeType === 'tool_calls') return [];
    const loadedPlanning = new Set(
      loaded
        .filter((item) => item.resource.resource_path === 'SKILL.md')
        .map((item) => item.skillId),
    );
    const missing = loadedPlanning.has(claimed.selection.primary_skill_id)
      ? []
      : [claimed.selection.primary_skill_id];
    if (
      outcomeType === 'candidate_plan' ||
      outcomeType === 'authoring_request' ||
      outcomeType === 'authoring_batch'
    ) {
      for (const required of claimed.selection.required_auxiliary) {
        if (!loadedPlanning.has(required.skill_id)) missing.push(required.skill_id);
      }
    }
    return missing.sort();
  }

  private assertCoreKnowledgeBudget(resources: LoadedSkillResource[]): void {
    const tokenCount = resources.reduce((total, item) => total + item.tokenCount, 0);
    if (tokenCount > this.config.agentMaxInputTokens) {
      throw new Error('AGENT_BUDGET_EXCEEDED');
    }
  }

  private turnCostBudget(modelSnapshot: ClaimedAgentTurn['modelSnapshot']): string {
    return compareMoney(
      this.config.agentMaxEstimatedCostCny,
      modelSnapshot.quota.max_turn_estimated_cost_cny,
    ) <= 0
      ? this.config.agentMaxEstimatedCostCny
      : modelSnapshot.quota.max_turn_estimated_cost_cny;
  }

  private contextWindowTokens(modelSnapshot: ClaimedAgentTurn['modelSnapshot']): number {
    return Math.max(
      1,
      Math.min(
        this.config.agentMaxInputTokens,
        modelSnapshot.capability_contract.max_context_tokens,
        modelSnapshot.quota.max_turn_input_tokens,
      ),
    );
  }

  private progressHash(resources: LoadedSkillResource[]): string {
    return canonicalSha256({
      loaded_resource_snapshot_ids: resources
        .map((item) => item.resource.resource_snapshot_id)
        .sort(),
    });
  }

  private taskBudget(claimed: ClaimedAgentTurn) {
    const inspectionCount = new Set(
      [...claimed.attachments, ...(claimed.sessionImageCandidates ?? [])].map(
        (image, index) => image.binding_key ?? `unresolved:${index}`,
      ),
    ).size;
    return agentTaskBudget({
      attachmentCount: claimed.attachments.length,
      inspectionCount,
      nodeCount: claimed.authoringPlan ? authoringCandidateKeys(claimed.authoringPlan).length : 0,
      baseRounds: this.config.agentMaxLlmRounds,
      baseToolCalls: this.config.agentMaxToolCalls,
      stepOutputTokens: Math.min(
        this.config.agentBrainStepMaxOutputTokens,
        claimed.modelSnapshot.capability_contract.max_output_tokens,
      ),
      maxOutputTokens: this.config.agentMaxOutputTokens,
      inspectionBatchSize: claimed.modelSnapshot.capability_contract.max_tool_calls_per_response,
    });
  }

  private loopBudget(claimed: ClaimedAgentTurn) {
    return {
      maxRounds: this.taskBudget(claimed).rounds,
      maxToolCalls: this.taskBudget(claimed).toolCalls,
      maxSameFingerprintExecutions: 2,
      maxNoProgress: 3,
      maxSameError: 3,
    };
  }

  private publicBudgets(
    modelSnapshot: ClaimedAgentTurn['modelSnapshot'],
    claimed?: ClaimedAgentTurn,
  ) {
    const contextWindowTokens = this.contextWindowTokens(modelSnapshot);
    return {
      max_llm_rounds: claimed ? this.taskBudget(claimed).rounds : this.config.agentMaxLlmRounds,
      max_tool_calls: claimed ? this.taskBudget(claimed).toolCalls : this.config.agentMaxToolCalls,
      context_window_tokens: contextWindowTokens,
      auto_compact_token_limit: Math.min(
        this.config.agentAutoCompactTokenLimit ?? Math.floor(contextWindowTokens * 0.8),
        Math.floor(contextWindowTokens * 0.8),
      ),
      // Compatibility field: this is the active context window, not a cumulative input budget.
      max_input_tokens: contextWindowTokens,
      max_output_tokens: claimed
        ? this.taskBudget(claimed).outputTokens
        : this.config.agentMaxOutputTokens,
      max_references: this.config.agentMaxReferences,
    };
  }

  private publicErrorCode(error: unknown): AgentPublicErrorCode {
    // A public code alone is not diagnosable, so emit the bounded real cause next to it when it
    // carries controlled identifiers; without this the trace shows only the fallback code and
    // operations cannot tell a provider outage from a schema or contract failure.
    const detail = errorDetailLine(error);
    this.logger?.error({
      event: 'agent_turn_failure_classified',
      error_code: stableErrorCode(error),
      ...(detail ? { error_detail: detail } : {}),
    });
    if (error instanceof Error) {
      if (error.message === 'SKILL_VERSION_DRIFT') return 'SKILL_VERSION_DRIFT';
      if (error.message === 'SKILL_RESOURCE_LIMIT_EXCEEDED') {
        return 'SKILL_RESOURCE_LIMIT_EXCEEDED';
      }
      if (
        error.message === 'AGENT_BUDGET_EXCEEDED' ||
        error.message === 'AGENT_SESSION_CONTEXT_TOO_LARGE' ||
        error.message === 'AGENT_SESSION_COMPACTION_UNAVAILABLE' ||
        error.message === 'AGENT_SESSION_COMPACTION_TOO_LARGE'
      ) {
        return 'AGENT_BUDGET_EXCEEDED';
      }
      if (error.message === 'AGENT_TOOL_NOT_ALLOWED') return 'AGENT_TOOL_NOT_ALLOWED';
      // Content-safety routing failures must stay attributable instead of masquerading as a
      // model failure (`docs/06`: CONTENT_SAFETY_UNAVAILABLE, HTTP 503).
      if (error.message === 'CONTENT_SAFETY_UNAVAILABLE') return 'CONTENT_SAFETY_UNAVAILABLE';
      if (error.message === 'CONTENT_SAFETY_BLOCKED') return 'CONTENT_SAFETY_BLOCKED';
    }
    // Intentional fallback: everything reaching this point is an unrecoverable internal fault
    // (CAS violations, repository drift, queue ownership) that the user can never act on.
    // Internally these keep their specific error.name/message on the trace step; publicly they
    // all present as the model-failure code registered in `docs/06`. Do not add feature flows
    // that rely on this fallback — give them an explicit branch above instead.
    return 'AGENT_MODEL_UNAVAILABLE';
  }

  private failureGuardrailType(
    error: unknown,
    claimed: ClaimedAgentTurn,
  ): 'token_budget' | undefined {
    if (!(error instanceof Error)) return undefined;
    if (
      error.message === 'AGENT_SESSION_CONTEXT_TOO_LARGE' ||
      error.message === 'AGENT_SESSION_COMPACTION_UNAVAILABLE' ||
      error.message === 'AGENT_SESSION_COMPACTION_TOO_LARGE'
    ) {
      return 'token_budget';
    }
    if (
      error.message === 'AGENT_BUDGET_EXCEEDED' &&
      claimed.outputTokenTotal >= this.taskBudget(claimed).outputTokens
    ) {
      return 'token_budget';
    }
    return undefined;
  }

  private publicSummary(error: unknown): AgentPublicSummary {
    const code = this.publicErrorCode(error);
    if (code === 'SKILL_VERSION_DRIFT') return '所选 Skill 已更新，请刷新后重新选择';
    if (code === 'SKILL_RESOURCE_LIMIT_EXCEEDED') {
      return '所选知识内容超过当前运行限制，请减少范围后重试';
    }
    if (code === 'AGENT_BUDGET_EXCEEDED') return '当前对话预算已用尽，请开始新的请求';
    if (code === 'AGENT_TOOL_NOT_ALLOWED') return '当前状态不允许使用该能力';
    if (code === 'CONTENT_SAFETY_BLOCKED') return '内容未通过安全审核，无法继续生成。';
    if (code === 'CONTENT_SAFETY_UNAVAILABLE') return '内容安全审核暂时无法完成，请稍后重试。';
    return '创作助手暂时不可用，请稍后重试';
  }

  private publishWake(turnId: string, eventSeq: number): Promise<void> {
    return this.eventWakePublisher.publish({
      schema_version: 1,
      scope_type: 'turn',
      scope_id: turnId,
      event_seq: eventSeq,
    });
  }
}
