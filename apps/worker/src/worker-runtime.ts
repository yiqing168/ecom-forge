import { randomUUID } from 'node:crypto';

import { assets, count, createDatabaseClient, eq } from '@ecom-forge/db';
import {
  createBullMqConnection,
  QueueIntentRepository,
  QUEUE_RECOVERY_SCHEMA_VERSION,
  QUEUE_SCHEMA_VERSION,
  SUPPORTED_QUEUE_SCHEMA_VERSIONS,
  builtinSkillCatalogKey,
} from '@ecom-forge/queue';
import { getBuiltinSkillCatalog } from '@ecom-forge/skills';

import type { WorkerConfig } from './config/worker-config.js';
import { WORKER_RUNTIME_DEFAULTS } from './config/runtime-defaults.js';
import { setTranscriptMetricsSink } from './agent/agent-transcript-metrics.js';
import { WorkerHeartbeatRepository } from './database/heartbeat.repository.js';
import { RedisEventWakePublisher } from './events/redis-event-wake.publisher.js';
import { ActiveWorkTracker, WorkerWriteFence } from './lifecycle/processing-fence.js';
import {
  WorkerSingleton,
  WorkerSingletonAlreadyRunningError,
  WorkerSingletonLeaseLostError,
} from './lifecycle/worker-singleton.js';
import {
  WorkerLifecycle,
  type DrainableWorkerResources,
  type WorkerLifecycleLogger,
} from './lifecycle/worker-lifecycle.js';
import { TestProcessorWorkers } from './processors/test-processors.js';
import { AgentProcessorWorker } from './processors/agent-processor.js';
import { AssetProcessorWorker } from './processors/asset-processor.js';
import { SkillPackageValidationProcessor } from './processors/skill-package-validation-processor.js';
import { LocalQuarantineResourceReader } from './skill-package/quarantine-resource.reader.js';
import { SkillRiskDeadlineSweeper } from './skill-package/skill-risk-deadline.sweeper.js';
import { SettlementProcessorWorker } from './processors/settlement-processor.js';
import { ProviderProcessorWorkers } from './processors/provider-processors.js';
import { ProviderCredentialValidationService } from './provider/provider-credential-validation.service.js';
import { ModelPocService } from './provider/model-poc.service.js';
import { StorageCredentialValidationService } from './storage/storage-credential-validation.service.js';
import { QueueDispatcher } from './queue/dispatcher.js';
import { BullMqQueuePublisher } from './queue/queue-publisher.js';
import { ensureQueueRecoveryReady, QueueReconciler } from './queue/reconciler.js';
import { QueueLeaseSweeper } from './queue/sweeper.js';
import { AgentTranscriptLifecycleSweeper } from './agent/agent-transcript-lifecycle.sweeper.js';
import { AgentTurnRecoverySweeper } from './agent/agent-turn-recovery.sweeper.js';

const REDACTED = '[redacted]';
// Key-name driven: lifecycle events never emit secrets, full prompts, signed URLs or image bytes,
// but a stray sensitive value must be masked before it reaches stdout/stderr.
const SENSITIVE_KEY_PATTERN =
  /prompt|authorization|token|api_?key|secret|url|signature|image|binary|detail/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(nested),
      ]),
    );
  }
  return value;
}

export class ConsoleWorkerLogger implements WorkerLifecycleLogger {
  info(event: Record<string, unknown>): void {
    console.log(JSON.stringify(redact({ ...event, level: 'info' })));
  }

  error(event: Record<string, unknown>): void {
    console.error(JSON.stringify(redact({ ...event, level: 'error' })));
  }
}

export class WorkerRuntime {
  readonly workerId = randomUUID();

  private readonly databaseResource;
  private readonly redis;
  private readonly publisher;
  private readonly dispatcher;
  private readonly sweeper;
  private readonly reconciler;
  private readonly heartbeat;
  private readonly eventWakePublisher;
  private readonly skillRiskDeadlineSweeper;
  private readonly transcriptLifecycleSweeper;
  private readonly agentTurnRecoverySweeper;
  private readonly singleton;
  private readonly activeWork = new ActiveWorkTracker();
  private readonly writeFence = new WorkerWriteFence();
  private readonly metadata: Record<string, unknown>;
  private processors: TestProcessorWorkers | undefined;
  private settlementProcessor: SettlementProcessorWorker | undefined;
  private providerProcessors: ProviderProcessorWorkers | undefined;
  private agentProcessor: AgentProcessorWorker | undefined;
  private assetProcessor: AssetProcessorWorker | undefined;
  private skillPackageValidationProcessor: SkillPackageValidationProcessor | undefined;
  private storageCredentialValidation: StorageCredentialValidationService | undefined;
  private lifecycle: WorkerLifecycle | undefined;
  private dispatchTimer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private skillRiskTimer: NodeJS.Timeout | undefined;
  private dispatchRunning = false;
  private sweepRunning = false;
  private lastAgentRecoveryExhaustedLogAt = 0;
  private skillRiskRunning = false;
  private heartbeatRunning = false;
  private stopped = false;
  private queueResourcesClosed = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: WorkerLifecycleLogger = new ConsoleWorkerLogger(),
  ) {
    this.databaseResource = createDatabaseClient({
      databaseUrl: config.databaseUrl,
      maxConnections: config.databasePoolMax,
      statementTimeoutMs: config.databaseStatementTimeoutMs,
      transactionTimeoutMs: config.databaseTransactionTimeoutMs,
      applicationName: 'ecom-forge-worker',
    });
    this.redis = createBullMqConnection(config.redisUrl);
    this.singleton = new WorkerSingleton(
      this.redis,
      config.redisPrefix,
      this.workerId,
      Math.max(30, Math.ceil((config.heartbeatIntervalMs * 3) / 1_000)),
    );
    this.eventWakePublisher = new RedisEventWakePublisher(this.redis, config.redisPrefix);
    this.publisher = new BullMqQueuePublisher(config);
    const intents = new QueueIntentRepository(this.databaseResource.db);
    this.dispatcher = new QueueDispatcher(
      intents,
      this.publisher,
      config,
      () => this.writeFence.isWriteAllowed(),
      logger,
    );
    this.sweeper = new QueueLeaseSweeper(intents, config);
    this.reconciler = new QueueReconciler(
      this.databaseResource.db,
      this.databaseResource.client,
      this.redis,
      intents,
      this.publisher,
      config,
    );
    this.heartbeat = new WorkerHeartbeatRepository(this.databaseResource.db);
    this.skillRiskDeadlineSweeper = new SkillRiskDeadlineSweeper(this.databaseResource.db);
    this.transcriptLifecycleSweeper = new AgentTranscriptLifecycleSweeper(
      this.databaseResource.db,
      WORKER_RUNTIME_DEFAULTS.transcriptArchiveSweepBatchSize,
    );
    this.agentTurnRecoverySweeper = new AgentTurnRecoverySweeper(
      this.databaseResource.db,
      this.publisher,
    );
    // Transcript metrics reuse the worker logger; only bounded labels are emitted.
    setTranscriptMetricsSink({ info: (event) => this.logger.info(event) });
    this.metadata = {
      app_env: config.appEnv,
      queue_schema_version: QUEUE_SCHEMA_VERSION,
      queue_recovery_schema_version: QUEUE_RECOVERY_SCHEMA_VERSION,
      supported_queue_schema_versions: [...SUPPORTED_QUEUE_SCHEMA_VERSIONS],
      // Version enums only (no content). Only formats this binary can actually execute/capture.
      supported_agent_execution_formats: [
        ...WORKER_RUNTIME_DEFAULTS.supportedAgentExecutionFormats,
      ],
      supported_transcript_schema_versions: [
        ...WORKER_RUNTIME_DEFAULTS.supportedTranscriptSchemaVersions,
      ],
      test_processor_enabled: config.testProcessorEnabled,
      settlement_processor_enabled: config.settlementProcessorEnabled,
      provider_processor_mode: config.providerProcessorMode,
      agent_processor_enabled: config.agentProcessorEnabled,
      agent_brain_adapter: config.agentBrainAdapter,
      skill_package_validation_enabled: config.appEnv === 'local' || config.appEnv === 'test',
      asset_processing_enabled: config.storageEnabled,
      dispatch_batch_size: config.dispatchBatchSize,
    };
  }

  async start(): Promise<void> {
    if (!(await this.singleton.acquire())) {
      this.logger.error({
        event: 'worker_singleton_already_running',
        worker_id: this.workerId,
      });
      throw new WorkerSingletonAlreadyRunningError();
    }
    const builtinSkillCatalog = await getBuiltinSkillCatalog();
    const skillCatalogTtlSeconds = Math.max(
      30,
      Math.ceil((this.config.heartbeatIntervalMs * 3) / 1_000),
    );
    await this.redis.set(
      builtinSkillCatalogKey(this.config.redisPrefix),
      builtinSkillCatalog.catalogVersion,
      'EX',
      skillCatalogTtlSeconds,
    );
    this.metadata.builtin_skill_catalog_version = builtinSkillCatalog.catalogVersion;
    this.logger.info({
      event: 'worker_skill_catalog_ready',
      worker_id: this.workerId,
      catalog_version: builtinSkillCatalog.catalogVersion,
    });
    if (!(await this.ensureQueueControlPlaneReady())) {
      throw new Error('Queue recovery is not ready');
    }
    if (this.config.settlementProcessorEnabled) {
      this.settlementProcessor = new SettlementProcessorWorker(
        this.databaseResource.db,
        this.config,
        this.activeWork,
        this.writeFence,
        this.eventWakePublisher,
      );
    }
    if (this.config.testProcessorEnabled) {
      this.processors = new TestProcessorWorkers(
        this.databaseResource.db,
        this.config,
        this.activeWork,
        this.writeFence,
        this.eventWakePublisher,
      );
    }
    if (this.config.providerProcessorMode !== 'disabled') {
      this.providerProcessors = new ProviderProcessorWorkers(
        this.databaseResource.db,
        this.redis,
        this.config,
        this.activeWork,
        this.writeFence,
        this.eventWakePublisher,
        undefined,
        this.logger,
      );
    }
    if (this.config.agentProcessorEnabled) {
      this.agentProcessor = new AgentProcessorWorker(
        this.databaseResource.db,
        this.redis,
        this.config,
        this.activeWork,
        this.writeFence,
        this.eventWakePublisher,
        undefined,
        undefined,
        undefined,
        this.logger,
      );
    }
    if (this.config.storageEnabled) {
      this.assetProcessor = new AssetProcessorWorker(
        this.databaseResource.db,
        this.config,
        this.activeWork,
        this.writeFence,
        this.logger,
      );
    }
    if (this.config.appEnv === 'local' || this.config.appEnv === 'test') {
      this.storageCredentialValidation = new StorageCredentialValidationService(
        this.databaseResource.db,
        this.config,
        this.config.dispatchLeaseMs,
      );
      this.skillPackageValidationProcessor = new SkillPackageValidationProcessor(
        this.databaseResource.db,
        this.config,
        this.activeWork,
        this.writeFence,
        new LocalQuarantineResourceReader(this.config.localUploadRoot),
        this.config.providerProcessorMode === 'fake_validation' ||
          this.config.providerRealPocEnabled
          ? new ProviderCredentialValidationService(
              this.databaseResource.db,
              this.config,
              this.config.dispatchLeaseMs,
            )
          : undefined,
        this.storageCredentialValidation,
        this.config.providerProcessorMode === 'fake_validation' ||
          this.config.providerRealPocEnabled
          ? new ModelPocService(this.databaseResource.db, this.config, this.config.dispatchLeaseMs)
          : undefined,
      );
    }
    const drainable: DrainableWorkerResources = {
      pauseNewWork: () => this.pauseNewWork(),
      close: (force) => this.closeQueueResources(force),
    };
    this.lifecycle = new WorkerLifecycle(
      this.workerId,
      this.heartbeat,
      drainable,
      this.activeWork,
      this.writeFence,
      this.config.drainTimeoutMs,
      this.metadata,
      this.logger,
    );
    await this.writeHeartbeat('healthy');
    this.startLoops();
    this.logger.info({ event: 'worker_ready', worker_id: this.workerId });
  }

  async shutdown(): Promise<{ timedOut: boolean }> {
    if (!this.lifecycle) {
      try {
        await this.closeQueueResources(true);
      } finally {
        await this.closeInfrastructure();
      }
      return { timedOut: false };
    }
    try {
      return await this.lifecycle.shutdown();
    } finally {
      try {
        await this.closeQueueResources(true);
      } finally {
        await this.closeInfrastructure();
      }
    }
  }

  private startLoops(): void {
    this.dispatchTimer = setInterval(() => this.scheduleDispatch(), this.config.dispatchPollMs);
    this.sweepTimer = setInterval(
      () => this.scheduleSweep(),
      Math.max(this.config.dispatchPollMs * 5, 1_000),
    );
    this.heartbeatTimer = setInterval(
      () => this.scheduleHeartbeat(),
      this.config.heartbeatIntervalMs,
    );
    this.skillRiskTimer = setInterval(() => this.scheduleSkillRiskSweep(), 60_000);
    this.scheduleDispatch();
    this.scheduleSweep();
    this.scheduleSkillRiskSweep();
  }

  private scheduleDispatch(): void {
    if (this.dispatchRunning || this.stopped) return;
    this.dispatchRunning = true;
    void this.activeWork
      .run(async () => {
        if (!(await this.ensureQueueControlPlaneReady())) return;
        const summary = await this.dispatcher.dispatchOnce();
        if (summary.claimed > 0) {
          this.logger.info({ event: 'queue_dispatch_cycle', worker_id: this.workerId, ...summary });
        }
      })
      .catch((error: unknown) => {
        this.logFailure('queue_dispatch_failed', error);
      })
      .finally(() => {
        this.dispatchRunning = false;
      });
  }

  private scheduleSweep(): void {
    if (this.sweepRunning || this.stopped) return;
    this.sweepRunning = true;
    void this.activeWork
      .run(async () => {
        const recovered = await this.sweeper.recoverOnce();
        const agentTurnRecovery = await this.agentTurnRecoverySweeper.sweep();
        if (
          agentTurnRecovery.exhausted > 0 &&
          Date.now() - this.lastAgentRecoveryExhaustedLogAt >= 60_000
        ) {
          this.lastAgentRecoveryExhaustedLogAt = Date.now();
          this.logger.error({
            event: 'agent_turn_recovery_exhausted',
            worker_id: this.workerId,
            exhausted: agentTurnRecovery.exhausted,
          });
        }
        const providerRecovery = await this.providerProcessors?.sweepRecovery(this.workerId);
        const storageProbesDeleted =
          (await this.storageCredentialValidation?.sweepResidualProbes()) ?? 0;
        const transcriptCleanup = await this.transcriptLifecycleSweeper.sweep();
        if (
          recovered > 0 ||
          agentTurnRecovery.requeued > 0 ||
          providerRecovery?.callbackScheduled ||
          providerRecovery?.callbackExpired ||
          providerRecovery?.staleDispatching ||
          providerRecovery?.stalePolling ||
          providerRecovery?.contentReviewsExpired ||
          providerRecovery?.outcomeUnknownReleased ||
          storageProbesDeleted > 0 ||
          transcriptCleanup.sessions > 0 ||
          transcriptCleanup.failed > 0
        ) {
          this.logger.info({
            event: 'queue_dispatch_lease_recovered',
            worker_id: this.workerId,
            recovered,
            agent_turns_requeued: agentTurnRecovery.requeued,
            callback_scheduled: providerRecovery?.callbackScheduled ?? 0,
            callback_expired: providerRecovery?.callbackExpired ?? 0,
            provider_dispatching_recovered: providerRecovery?.staleDispatching ?? 0,
            provider_polling_recovered: providerRecovery?.stalePolling ?? 0,
            content_reviews_expired: providerRecovery?.contentReviewsExpired ?? 0,
            outcome_unknown_released: providerRecovery?.outcomeUnknownReleased ?? 0,
            storage_validation_probes_deleted: storageProbesDeleted,
            transcript_sessions_cleaned: transcriptCleanup.sessions,
            transcript_items_deleted: transcriptCleanup.items,
            transcript_payloads_deleted: transcriptCleanup.payloads,
            transcript_cleanup_failed: transcriptCleanup.failed,
            transcript_cleanup_failures: transcriptCleanup.failures,
          });
        }
      })
      .catch((error: unknown) => {
        this.logFailure('queue_sweeper_failed', error);
      })
      .finally(() => {
        this.sweepRunning = false;
      });
  }

  private scheduleSkillRiskSweep(): void {
    if (this.skillRiskRunning || this.stopped) return;
    this.skillRiskRunning = true;
    void this.activeWork
      .run(async () => {
        this.writeFence.assertWritesAllowed();
        const blocked = await this.skillRiskDeadlineSweeper.sweep();
        if (blocked > 0) {
          this.logger.info({
            event: 'skill_risk_deadline_blocked',
            worker_id: this.workerId,
            blocked,
          });
        }
      })
      .catch((error: unknown) => {
        this.logFailure('skill_risk_sweeper_failed', error);
      })
      .finally(() => {
        this.skillRiskRunning = false;
      });
  }

  private scheduleHeartbeat(): void {
    if (this.stopped || this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    void this.writeHeartbeat('healthy')
      .catch((error: unknown) => {
        this.logFailure('worker_heartbeat_failed', error);
        if (error instanceof WorkerSingletonLeaseLostError) {
          this.stopped = true;
          this.dispatcher.pauseClaims();
          this.writeFence.disableWrites();
          this.logger.error({
            event: 'worker_singleton_lease_lost',
            worker_id: this.workerId,
          });
          void this.shutdown()
            .then(() => {
              process.exitCode = 1;
            })
            .catch((shutdownError: unknown) => {
              this.logFailure('worker_shutdown_after_lease_loss_failed', shutdownError);
              process.exitCode = 1;
            });
        }
      })
      .finally(() => {
        this.heartbeatRunning = false;
      });
  }

  private async pauseNewWork(): Promise<void> {
    this.stopped = true;
    this.dispatcher.pauseClaims();
    this.clearLoops();
    await this.processors?.pauseNewWork();
    await this.settlementProcessor?.pauseNewWork();
    await this.providerProcessors?.pauseNewWork();
    await this.agentProcessor?.pauseNewWork();
    await this.assetProcessor?.pauseNewWork();
    await this.skillPackageValidationProcessor?.pauseNewWork();
  }

  private async ensureQueueControlPlaneReady(): Promise<boolean> {
    this.dispatcher.pauseClaims();
    const recovery = await ensureQueueRecoveryReady(this.reconciler);
    if (recovery.reconciliation) {
      this.logger.info({
        event: 'queue_reconciliation_completed',
        worker_id: this.workerId,
        ...recovery.reconciliation,
      });
    }
    if (!recovery.ready || this.stopped) {
      if (!recovery.ready) {
        this.logger.error({
          event: 'queue_control_plane_not_ready',
          worker_id: this.workerId,
        });
      }
      return false;
    }
    this.dispatcher.resumeClaims();
    return true;
  }

  private async closeQueueResources(force: boolean): Promise<void> {
    if (this.queueResourcesClosed) return;
    this.queueResourcesClosed = true;
    this.clearLoops();
    try {
      await this.processors?.close(force);
      await this.settlementProcessor?.close(force);
      await this.providerProcessors?.close(force);
      await this.agentProcessor?.close(force);
      await this.assetProcessor?.close(force);
      await this.skillPackageValidationProcessor?.close(force);
    } finally {
      await this.publisher.close();
    }
  }

  private async closeInfrastructure(): Promise<void> {
    await this.singleton.release().catch(() => false);
    if (this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
    await this.databaseResource.client.end();
  }

  private clearLoops(): void {
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.skillRiskTimer) clearInterval(this.skillRiskTimer);
  }

  private async writeHeartbeat(status: 'healthy' | 'draining' | 'stopped'): Promise<void> {
    // Lease ownership is the write authority. Confirm it before advertising this process as live.
    await this.singleton.assertRenewed();
    let assetProcessingBacklog: number | undefined;
    if (this.config.storageEnabled) {
      const [row] = await this.databaseResource.db
        .select({ value: count() })
        .from(assets)
        .where(eq(assets.status, 'processing'));
      assetProcessingBacklog = Number(row?.value ?? 0);
      this.logger.info({
        event: 'asset_processing_backlog_observed',
        metric: 'asset_processing_backlog',
        value: assetProcessingBacklog,
      });
    }
    await this.heartbeat.write({
      id: this.workerId,
      workerType: 'queue-worker',
      status,
      lastSeenAt: new Date(),
      metadata: {
        ...this.metadata,
        ...(assetProcessingBacklog === undefined
          ? {}
          : { asset_processing_backlog: assetProcessingBacklog }),
      },
    });
    const builtinSkillCatalog = await getBuiltinSkillCatalog();
    await this.redis.set(
      builtinSkillCatalogKey(this.config.redisPrefix),
      builtinSkillCatalog.catalogVersion,
      'EX',
      Math.max(30, Math.ceil((this.config.heartbeatIntervalMs * 3) / 1_000)),
    );
  }

  private logFailure(event: string, error: unknown): void {
    this.logger.error({
      event,
      worker_id: this.workerId,
      error_code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
    });
  }
}
