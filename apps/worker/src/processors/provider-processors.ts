import { createHash } from 'node:crypto';

import { DelayedError, Worker, type Job } from 'bullmq';
import { z } from 'zod';

import { and, eq, tasks, workflowRuns, type Database } from '@ecom-forge/db';
import {
  FakeProviderAdapter,
  ProviderGateway,
  ProviderRegistry,
  providerCapabilitySchema,
  type ProviderAdapter,
  type ProviderCallContext,
  type QuotaGate,
} from '@ecom-forge/provider';
import { createBullMqConnection, parseQueuePayload, type QueuePayload } from '@ecom-forge/queue';
import { NOOP_EVENT_WAKE_PUBLISHER, type EventWakePublisher } from '@ecom-forge/shared';
import type { Redis } from 'ioredis';

import type { WorkerConfig } from '../config/worker-config.js';
import { ApprovedModerationDispatcher } from '../agent/approved-moderation.dispatcher.js';
import { TaskAttemptRepository } from '../database/attempt.repository.js';
import { WorkflowStateRepository } from '../database/workflow-state.repository.js';
import { ApprovedImageDispatcher } from '../image/approved-image.dispatcher.js';
import { ImageOutputIngestService } from '../image/image-output-ingest.service.js';
import { ImagePipelineService } from '../image/image-pipeline.service.js';
import { createLocalFakeImageDispatcher } from '../image/local-fake-image.dispatcher.js';
import { PostModerationService } from '../image/post-moderation.service.js';
import { ContentReviewDeadlineSweeper } from '../image/content-review-deadline.sweeper.js';
import type { ActiveWorkTracker, WorkerWriteFence } from '../lifecycle/processing-fence.js';
import { ProviderAttemptService } from '../provider/provider-attempt.service.js';
import { ProviderCallbackService } from '../provider/provider-callback.service.js';
import { ProviderCircuitRepository } from '../provider/provider-circuit.repository.js';
import { OutcomeUnknownReleaseSweeper } from '../provider/outcome-unknown-release.sweeper.js';
import { RedisProviderQuotaGate } from '../provider/redis-provider-quota.gate.js';
import {
  NOOP_PROVIDER_TELEMETRY,
  stableErrorCode,
  telemetryId,
  type ProviderTelemetryLogger,
} from '../provider/provider-telemetry.js';

type GenerationTaskPayload = Extract<QueuePayload, { job_type: 'task.execute' }>;
type ModerationTaskPayload = Extract<QueuePayload, { job_type: 'moderation.execute' }>;
type ProviderTaskPayload = GenerationTaskPayload | ModerationTaskPayload;
type ProviderQueuePayload = Extract<
  QueuePayload,
  { job_type: 'provider.callback.process' | 'provider.poll' }
>;

const fakeValidationParamsSchema = z.strictObject({
  capability: providerCapabilitySchema,
  provider_input: z.unknown(),
  request_digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export class ProviderProcessorWorkers {
  private readonly workers: Worker[];
  private readonly attempts: ProviderAttemptService;
  private readonly attemptRepository: TaskAttemptRepository;
  private readonly callbacks: ProviderCallbackService;
  private readonly workflowStates: WorkflowStateRepository;
  private readonly imagePipeline: ImagePipelineService | undefined;
  private readonly postModeration: PostModerationService | undefined;
  private readonly contentReviewDeadlines: ContentReviewDeadlineSweeper | undefined;
  private readonly outcomeUnknownReleases: OutcomeUnknownReleaseSweeper | undefined;

  constructor(
    private readonly database: Database,
    redis: Redis,
    private readonly config: WorkerConfig,
    private readonly activeWork: ActiveWorkTracker,
    private readonly writeFence: WorkerWriteFence,
    eventWakePublisher: EventWakePublisher = NOOP_EVENT_WAKE_PUBLISHER,
    adapter: ProviderAdapter = new FakeProviderAdapter('succeeded'),
    private readonly telemetry: ProviderTelemetryLogger = NOOP_PROVIDER_TELEMETRY,
    quotaGate?: QuotaGate,
  ) {
    if (config.providerProcessorMode === 'disabled') {
      throw new Error('Provider processors require an enabled processor mode');
    }
    if (config.providerProcessorMode === 'fake_validation' && adapter.provider !== 'fake') {
      throw new Error('S07 fake validation requires a fake Provider adapter');
    }
    const circuits = new ProviderCircuitRepository(
      database,
      () => new Date(),
      () => writeFence.assertWritesAllowed(),
      telemetry,
    );
    const gateway = new ProviderGateway(new ProviderRegistry([adapter]), {
      mode: config.appEnv === 'test' ? 'test' : 'poc',
      circuitGate: circuits,
      quotaGate:
        quotaGate ??
        new RedisProviderQuotaGate(redis, config.redisPrefix, () => new Date(), telemetry),
      telemetry,
    });
    this.attempts = new ProviderAttemptService(
      database,
      gateway,
      () => new Date(),
      writeFence,
      circuits,
      eventWakePublisher,
    );
    this.attemptRepository = new TaskAttemptRepository(database);
    this.callbacks = new ProviderCallbackService(
      database,
      () => new Date(),
      circuits,
      eventWakePublisher,
    );
    this.workflowStates = new WorkflowStateRepository(database, eventWakePublisher);
    if (
      config.providerProcessorMode === 'real' ||
      config.providerProcessorMode === 'fake_validation'
    ) {
      const moderation = new ApprovedModerationDispatcher(database, redis, config, writeFence);
      const imageDispatcher =
        config.providerProcessorMode === 'real'
          ? new ApprovedImageDispatcher(database, redis, config, writeFence, undefined, telemetry)
              .dispatch
          : createLocalFakeImageDispatcher(config);
      this.imagePipeline = new ImagePipelineService(
        database,
        imageDispatcher,
        new ImageOutputIngestService(database, config, writeFence),
        writeFence,
        telemetry,
      );
      this.postModeration = new PostModerationService(
        database,
        moderation.dispatchPost,
        config,
        writeFence,
        eventWakePublisher,
      );
      this.contentReviewDeadlines = new ContentReviewDeadlineSweeper(database, config, writeFence);
      this.outcomeUnknownReleases = new OutcomeUnknownReleaseSweeper(
        database,
        config,
        writeFence,
        eventWakePublisher,
      );
    }
    const sharedOptions = {
      connection: createBullMqConnection(config.redisUrl),
      prefix: config.redisPrefix,
      autorun: true,
    };
    this.workers = [
      new Worker<GenerationTaskPayload>('task', (job) => this.processTask(job), {
        ...sharedOptions,
        concurrency: config.providerImageTaskConcurrency,
      }),
      new Worker<ModerationTaskPayload>('moderation', (job) => this.processTask(job), {
        ...sharedOptions,
        concurrency: 1,
      }),
      new Worker<ProviderQueuePayload>(
        'provider-callback',
        (job) => this.processCallbackOrPoll(job),
        { ...sharedOptions, concurrency: 1 },
      ),
    ];
  }

  pauseNewWork(): Promise<void> {
    return Promise.all(this.workers.map((worker) => worker.pause(true))).then(() => undefined);
  }

  close(force: boolean): Promise<void> {
    return Promise.all(this.workers.map((worker) => worker.close(force))).then(() => undefined);
  }

  async sweepRecovery(traceId: string): Promise<{
    callbackScheduled: number;
    callbackExpired: number;
    staleDispatching: number;
    stalePolling: number;
    contentReviewsExpired: number;
    outcomeUnknownReleased: number;
  }> {
    const now = Date.now();
    const before = new Date(
      now - this.config.providerRequestTimeoutMs - this.config.dispatchLeaseMs,
    );
    const imageBefore = new Date(
      now - this.config.imageProviderRequestTimeoutMs - this.config.dispatchLeaseMs,
    );
    const [
      callbacks,
      staleDispatching,
      stalePolling,
      contentReviewsExpired,
      outcomeUnknownReleased,
    ] = await Promise.all([
      this.callbacks.scheduleRetryableUnmatched({
        limit: this.config.dispatchBatchSize,
        traceId,
      }),
      this.attempts.recoverStaleDispatching({
        before,
        imageBefore,
        limit: this.config.dispatchBatchSize,
      }),
      this.attempts.recoverStalePolling({
        before,
        limit: this.config.dispatchBatchSize,
      }),
      this.contentReviewDeadlines?.sweep() ?? Promise.resolve(0),
      this.outcomeUnknownReleases?.sweep() ?? Promise.resolve(0),
    ]);
    return {
      callbackScheduled: callbacks.scheduled,
      callbackExpired: callbacks.expired,
      staleDispatching,
      stalePolling,
      contentReviewsExpired,
      outcomeUnknownReleased,
    };
  }

  private processTask(job: Job<ProviderTaskPayload>): Promise<void> {
    return this.activeWork.run(async () => {
      const startedAt = Date.now();
      const payload = parseQueuePayload(job.data);
      if (payload.job_type !== 'task.execute' && payload.job_type !== 'moderation.execute') {
        throw new Error('Provider task queue received a non-task payload');
      }
      const [owned] = await this.database
        .select({ task: tasks, userId: workflowRuns.userId })
        .from(tasks)
        .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
        .where(
          and(
            eq(tasks.id, payload.task_id),
            eq(tasks.workflowRunId, payload.workflow_run_id),
            eq(workflowRuns.userId, payload.user_id),
          ),
        )
        .limit(1);
      if (!owned || ['succeeded', 'failed', 'cancelled', 'blocked'].includes(owned.task.status)) {
        return;
      }
      if (payload.job_type === 'moderation.execute' && owned.task.type !== 'moderation.image') {
        throw new Error('Moderation queue received a non-moderation task');
      }
      if (owned.task.type === 'image.generate' || owned.task.type === 'image.edit') {
        if (payload.job_type !== 'task.execute') {
          throw new Error('Moderation queue cannot execute an image generation task');
        }
        if (!this.imagePipeline) throw new Error('Image pipeline is not enabled');
        await this.imagePipeline.execute(payload);
        return;
      }
      if (owned.task.type === 'moderation.image') {
        if (!this.postModeration) throw new Error('Post moderation pipeline is not enabled');
        await this.postModeration.execute(payload);
        return;
      }
      if (owned.task.type !== 's07.fake.provider_validation') {
        throw new Error('Provider fake validation worker rejected an unsupported task type');
      }
      if (payload.job_type !== 'task.execute') {
        throw new Error('Moderation queue cannot execute a Provider validation task');
      }
      const params = fakeValidationParamsSchema.parse(owned.task.paramsSnapshot);
      this.writeFence.assertWritesAllowed();
      if (owned.task.status === 'queued') {
        await this.workflowStates.advanceTask({
          taskId: owned.task.id,
          workflowRunId: owned.task.workflowRunId,
          userId: owned.userId,
          from: 'queued',
          to: 'running',
          now: new Date(),
        });
      } else if (owned.task.status !== 'running') {
        throw new Error(`Task status ${owned.task.status} is not eligible for Provider validation`);
      }

      const allocation = await this.attemptRepository.allocate({
        taskId: owned.task.id,
        provider: 'fake',
        maxAttempts: 3,
      });
      if (payload.task_attempt_id && payload.task_attempt_id !== allocation.attempt.id) {
        throw new Error('Provider task payload attempt does not match database truth');
      }
      this.writeFence.assertWritesAllowed();
      try {
        const result = await this.attempts.submit({
          attemptId: allocation.attempt.id,
          capability: params.capability,
          providerInput: params.provider_input,
          context: this.context(
            `provider-submit:${allocation.attempt.id}`,
            params.request_digest,
            payload.trace_id,
          ),
        });
        this.telemetry.info({
          event: 'provider_submit_completed',
          metric: 'provider_submit_total',
          trace_id: payload.trace_id,
          task_id_hash: telemetryId(owned.task.id),
          attempt_id: allocation.attempt.id,
          provider: allocation.attempt.provider,
          model_version: owned.task.modelVersion,
          outcome: result.action === 'recorded' ? result.outcome.kind : result.action,
          duration_ms: Date.now() - startedAt,
        });
      } catch (error) {
        this.telemetry.error({
          event: 'provider_submit_failed',
          metric: 'provider_submit_failure_total',
          trace_id: payload.trace_id,
          task_id_hash: telemetryId(owned.task.id),
          attempt_id: allocation.attempt.id,
          provider: allocation.attempt.provider,
          model_version: owned.task.modelVersion,
          error_code: stableErrorCode(error),
          duration_ms: Date.now() - startedAt,
        });
        throw error;
      }
    });
  }

  private processCallbackOrPoll(job: Job<ProviderQueuePayload>): Promise<void> {
    return this.activeWork.run(async () => {
      const startedAt = Date.now();
      const payload = parseQueuePayload(job.data);
      this.writeFence.assertWritesAllowed();
      if (payload.job_type === 'provider.callback.process') {
        try {
          const result = await this.callbacks.process(payload);
          this.telemetry.info({
            event: 'provider_callback_processed',
            metric: 'provider_callback_total',
            trace_id: payload.trace_id,
            callback_event_id_hash: telemetryId(payload.provider_callback_event_id),
            outcome: result.action === 'processed' ? result.outcome : result.action,
            ...(result.action === 'processed' && result.providerReportedCost !== undefined
              ? { provider_reported_cost: result.providerReportedCost }
              : {}),
            duration_ms: Date.now() - startedAt,
          });
        } catch (error) {
          this.logProviderQueueFailure('callback', payload.trace_id, error, startedAt);
          throw error;
        }
        return;
      }
      if (payload.job_type === 'provider.poll') {
        try {
          const result = await this.attempts.poll(
            payload,
            this.context(
              `provider-poll:${payload.task_attempt_id}:${payload.poll_no}`,
              createHash('sha256')
                .update(`${payload.task_attempt_id}:${payload.poll_no}`)
                .digest('hex'),
              payload.trace_id,
            ),
          );
          if (result.action === 'retry_scheduled') {
            await job.moveToDelayed(result.retryAt.getTime(), job.token);
            throw new DelayedError();
          }
          this.telemetry.info({
            event: 'provider_poll_completed',
            metric: 'provider_poll_total',
            trace_id: payload.trace_id,
            attempt_id: payload.task_attempt_id,
            poll_no: payload.poll_no,
            outcome: result.action === 'recorded' ? result.outcome.kind : result.action,
            ...(result.action === 'recorded' &&
            result.outcome.kind === 'succeeded' &&
            result.outcome.cost_summary
              ? { provider_reported_cost: result.outcome.cost_summary.amount }
              : {}),
            duration_ms: Date.now() - startedAt,
          });
        } catch (error) {
          if (!(error instanceof DelayedError)) {
            this.logProviderQueueFailure('poll', payload.trace_id, error, startedAt);
          }
          throw error;
        }
        return;
      }
      throw new Error('Provider callback queue received an unsupported payload');
    });
  }

  private logProviderQueueFailure(
    operation: 'callback' | 'poll',
    traceId: string,
    error: unknown,
    startedAt: number,
  ): void {
    this.telemetry.error({
      event: `provider_${operation}_failed`,
      metric: `provider_${operation}_failure_total`,
      trace_id: traceId,
      error_code: stableErrorCode(error),
      duration_ms: Date.now() - startedAt,
    });
  }

  private context(
    idempotencyKey: string,
    requestDigest: string,
    traceId: string,
  ): ProviderCallContext {
    return {
      idempotencyKey,
      requestDigest,
      traceId,
      deadlineAt: new Date(Date.now() + this.config.providerRequestTimeoutMs),
      signal: this.writeFence.signal,
    };
  }
}
