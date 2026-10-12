import type { Redis } from 'ioredis';

import {
  QueuePayloadError,
  QUEUE_RECOVERY_SCHEMA_VERSION,
  queueRecoverySentinelKey,
  parseQueuePayload,
} from '@ecom-forge/queue';
import { advisoryLockKey } from '@ecom-forge/shared';
import {
  agentTraces,
  agentTurns,
  assets,
  and,
  chatMessages,
  desc,
  eq,
  providerCallbackEvents,
  providerCredentialValidationRuns,
  runQuotes,
  skillPackageValidationReports,
  storageValidationRuns,
  taskAttempts,
  tasks,
  workflowRuns,
  modelPocRuns,
  type Database,
} from '@ecom-forge/db';
import type { createDatabaseClient } from '@ecom-forge/db';

import type { WorkerConfig } from '../config/worker-config.js';
import type { QueuePublisher } from './queue-publisher.js';
import type { QueueIntentRepository, ReconciliationCursor } from '@ecom-forge/queue';

type DatabaseClient = ReturnType<typeof createDatabaseClient>['client'];

export interface ReconciliationSummary {
  status: 'completed' | 'already_ready' | 'not_owner';
  scanned: number;
  rebuilt: number;
  skippedTerminal: number;
  skippedProtected: number;
  poisonCancelled: number;
}

type RecoveryDecision = 'rebuild' | 'terminal' | 'protected';

export class QueueReconciler {
  private readonly lockKeyInput: string;

  constructor(
    private readonly database: Database,
    private readonly databaseClient: DatabaseClient,
    private readonly redis: Redis,
    private readonly intents: QueueIntentRepository,
    private readonly publisher: QueuePublisher,
    private readonly config: WorkerConfig,
  ) {
    this.lockKeyInput = `queue-recovery:${config.redisPrefix}:${QUEUE_RECOVERY_SCHEMA_VERSION}`;
  }

  async isReady(): Promise<boolean> {
    await this.ensureRedis();
    return (await this.redis.get(queueRecoverySentinelKey(this.config.redisPrefix))) === 'ready';
  }

  async reconcile(
    options: { beforeSentinel?: () => Promise<void> } = {},
  ): Promise<ReconciliationSummary> {
    await this.ensureRedis();
    const summary: ReconciliationSummary = {
      status: 'completed',
      scanned: 0,
      rebuilt: 0,
      skippedTerminal: 0,
      skippedProtected: 0,
      poisonCancelled: 0,
    };
    const sentinelKey = queueRecoverySentinelKey(this.config.redisPrefix);
    if ((await this.redis.get(sentinelKey)) === 'ready') {
      return { ...summary, status: 'already_ready' };
    }

    const reserved = await this.databaseClient.reserve();
    let ownsLock = false;

    try {
      const lockKey = advisoryLockKey(this.lockKeyInput);
      const lockRows = await reserved.unsafe<{ locked: boolean }[]>(
        'select pg_try_advisory_lock($1::bigint) as locked',
        [lockKey.toString()],
      );
      ownsLock = Boolean(lockRows[0]?.locked);
      if (!ownsLock) return { ...summary, status: 'not_owner' };

      if ((await this.redis.get(sentinelKey)) === 'ready') {
        return { ...summary, status: 'already_ready' };
      }
      let cursor: ReconciliationCursor | undefined;
      for (;;) {
        const page = await this.intents.listDispatchedPage(
          cursor ? { limit: 100, cursor } : { limit: 100 },
        );
        if (page.length === 0) break;
        for (const intent of page) {
          summary.scanned += 1;
          let payload: ReturnType<typeof parseQueuePayload>;
          try {
            payload = parseQueuePayload(intent.payload);
          } catch (error) {
            if (!(error instanceof QueuePayloadError)) throw error;
            const cancelled = await this.intents.cancelDispatchedPoison({
              id: intent.id,
              now: new Date(),
              errorCode: error.code,
            });
            if (cancelled) summary.poisonCancelled += 1;
            continue;
          }
          const decision = await this.recoveryDecision(payload);
          if (decision === 'terminal') {
            summary.skippedTerminal += 1;
          } else if (decision === 'protected') {
            summary.skippedProtected += 1;
          } else {
            await this.publisher.add(
              intent.queueName,
              intent.jobId,
              payload,
              payload.job_type === 'provider.poll' ||
                payload.job_type === 'provider.callback.process' ||
                payload.job_type === 'agent.quote.expire'
                ? intent.nextAttemptAt
                : undefined,
            );
            summary.rebuilt += 1;
          }
        }
        const last = page[page.length - 1];
        if (!last) break;
        cursor = {
          id: last.id,
        };
      }
      await options.beforeSentinel?.();
      await this.redis.set(sentinelKey, 'ready');
      return summary;
    } finally {
      if (ownsLock) {
        await reserved.unsafe('select pg_advisory_unlock($1::bigint)', [
          advisoryLockKey(this.lockKeyInput).toString(),
        ]);
      }
      reserved.release();
    }
  }

  private async recoveryDecision(
    payload: ReturnType<typeof parseQueuePayload>,
  ): Promise<RecoveryDecision> {
    if (payload.job_type === 'task.execute' || payload.job_type === 'moderation.execute') {
      const task = await this.database.query.tasks.findFirst({
        where: and(eq(tasks.id, payload.task_id), eq(tasks.workflowRunId, payload.workflow_run_id)),
      });
      if (!task || ['succeeded', 'failed', 'cancelled', 'blocked'].includes(task.status)) {
        return 'terminal';
      }
      if (payload.job_type === 'moderation.execute' && task.type !== 'moderation.image') {
        return 'protected';
      }
      const [latest] = await this.database
        .select()
        .from(taskAttempts)
        .where(eq(taskAttempts.taskId, task.id))
        .orderBy(desc(taskAttempts.attemptNo))
        .limit(1);
      if (
        latest &&
        (latest.dispatchState === 'accepted' ||
          latest.dispatchState === 'outcome_unknown' ||
          ['accepted', 'polling', 'timeout', 'outcome_unknown'].includes(latest.status))
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    if (payload.job_type === 'workflow.advance') {
      const workflow = await this.database.query.workflowRuns.findFirst({
        where: and(
          eq(workflowRuns.id, payload.workflow_run_id),
          eq(workflowRuns.userId, payload.user_id),
        ),
      });
      return !workflow || ['succeeded', 'failed', 'cancelled', 'refunded'].includes(workflow.status)
        ? 'terminal'
        : 'rebuild';
    }
    if (payload.job_type === 'agent.continue') {
      const turn = await this.database.query.agentTurns.findFirst({
        where: eq(agentTurns.id, payload.turn_id),
      });
      if (!turn) return 'terminal';
      if (
        turn.sessionId !== payload.session_id ||
        turn.continuationNo > payload.continuation_no ||
        [
          'done',
          'blocked',
          'failed',
          'cancelled',
          'superseded',
          'waiting_user_confirmation',
        ].includes(turn.status)
      ) {
        return 'terminal';
      }
      if (
        turn.continuationNo < payload.continuation_no ||
        turn.runQuoteId !== null ||
        turn.workflowRunId !== null
      ) {
        return 'protected';
      }
      const [trace, message] = await Promise.all([
        this.database.query.agentTraces.findFirst({
          where: and(eq(agentTraces.id, payload.trace_id), eq(agentTraces.turnId, turn.id)),
        }),
        this.database.query.chatMessages.findFirst({
          where: and(
            eq(chatMessages.id, payload.user_message_id),
            eq(chatMessages.turnId, turn.id),
            eq(chatMessages.sessionId, turn.sessionId),
            eq(chatMessages.role, 'user'),
          ),
        }),
      ]);
      if (
        !trace ||
        trace.sessionId !== turn.sessionId ||
        trace.userId !== turn.userId ||
        !message
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    if (payload.job_type === 'agent.quote.submit') {
      const [turn, quote] = await Promise.all([
        this.database.query.agentTurns.findFirst({
          where: eq(agentTurns.id, payload.turn_id),
        }),
        this.database.query.runQuotes.findFirst({
          where: eq(runQuotes.id, payload.quote_id),
        }),
      ]);
      if (!turn || !quote) return 'terminal';
      if (quote.status === 'submitted' && turn.workflowRunId) return 'terminal';
      if (
        quote.status !== 'quoted' ||
        turn.status !== 'run_quote_created' ||
        turn.runQuoteId !== quote.id ||
        turn.continuationNo !== payload.continuation_no ||
        quote.planDigest !== payload.plan_digest ||
        quote.authorizationDigest !== payload.authorization_digest ||
        turn.executionAuthorizationHash !== payload.authorization_digest
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    if (payload.job_type === 'agent.quote.expire') {
      const [turn, quote] = await Promise.all([
        this.database.query.agentTurns.findFirst({
          where: eq(agentTurns.id, payload.turn_id),
        }),
        this.database.query.runQuotes.findFirst({
          where: eq(runQuotes.id, payload.quote_id),
        }),
      ]);
      if (!turn || !quote || quote.status !== 'quoted') return 'terminal';
      if (
        turn.runQuoteId !== quote.id ||
        turn.continuationNo !== payload.continuation_no ||
        quote.planDigest !== payload.plan_digest
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    if (payload.job_type === 'provider.poll') {
      const attempt = await this.database.query.taskAttempts.findFirst({
        where: eq(taskAttempts.id, payload.task_attempt_id),
      });
      if (!attempt || !['accepted', 'polling'].includes(attempt.status)) return 'terminal';
      if (attempt.dispatchState !== 'accepted') return 'protected';
      if (payload.poll_no <= attempt.pollCount) return 'terminal';
      return payload.poll_no === attempt.pollCount + 1 ? 'rebuild' : 'protected';
    }
    if (payload.job_type === 'provider.callback.process') {
      const callback = await this.database.query.providerCallbackEvents.findFirst({
        where: eq(providerCallbackEvents.id, payload.provider_callback_event_id),
      });
      if (!callback || callback.status === 'processed') return 'terminal';
      if (callback.status === 'dead_letter' && callback.nextProcessAt === null) return 'terminal';
      if (payload.processing_no <= callback.processingCount) return 'terminal';
      return payload.processing_no === callback.processingCount + 1 ? 'rebuild' : 'protected';
    }
    if (payload.job_type === 'asset.process') {
      const asset = await this.database.query.assets.findFirst({
        where: and(eq(assets.id, payload.asset_id), eq(assets.userId, payload.user_id)),
      });
      if (!asset || asset.status !== 'processing') return 'terminal';
      if (asset.processingRevision !== payload.operation_no) return 'terminal';
      if (payload.operation === 'cleanup') return 'protected';
      if (payload.operation === 'inspect_metadata' && asset.contentHash) return 'terminal';
      if (payload.operation === 'generate_thumbnail' && !asset.contentHash) return 'protected';
      return 'rebuild';
    }
    if (payload.job_type === 'skill-package.validate') {
      const report = await this.database.query.skillPackageValidationReports.findFirst({
        where: eq(skillPackageValidationReports.id, payload.validation_report_id),
      });
      if (!report || ['passed', 'failed', 'cancelled'].includes(report.status)) return 'terminal';
      if (
        report.packageRecordId !== payload.package_record_id ||
        report.attemptNo !== payload.attempt_no ||
        report.packageDigest !== payload.package_digest ||
        report.validatorContractVersion !== payload.validator_contract_version ||
        report.platformEvalSuiteDigest !== payload.platform_eval_suite_digest
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    if (payload.job_type === 'provider-credential.validate') {
      const run = await this.database.query.providerCredentialValidationRuns.findFirst({
        where: eq(providerCredentialValidationRuns.id, payload.credential_validation_run_id),
      });
      if (!run || ['passed', 'failed', 'outcome_unknown', 'cancelled'].includes(run.status)) {
        return 'terminal';
      }
      if (
        run.providerChannelId !== payload.provider_channel_id ||
        run.credentialVersionId !== payload.credential_version_id ||
        run.probeContractVersion !== payload.probe_contract_version ||
        run.attemptNo !== payload.attempt_no
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    if (payload.job_type === 'storage-credential.validate') {
      const run = await this.database.query.storageValidationRuns.findFirst({
        where: eq(storageValidationRuns.id, payload.storage_validation_run_id),
      });
      if (!run || ['passed', 'failed', 'outcome_unknown', 'cancelled'].includes(run.status)) {
        return 'terminal';
      }
      if (
        run.storageChannelId !== payload.storage_channel_id ||
        run.credentialVersionId !== payload.credential_version_id ||
        run.probeContractVersion !== payload.probe_contract_version ||
        run.attemptNo !== payload.attempt_no
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    if (payload.job_type === 'model-poc.run') {
      const run = await this.database.query.modelPocRuns.findFirst({
        where: eq(modelPocRuns.id, payload.model_poc_run_id),
      });
      if (!run || ['passed', 'failed', 'outcome_unknown', 'cancelled'].includes(run.status)) {
        return 'terminal';
      }
      if (
        run.modelSnapshotId !== payload.model_snapshot_id ||
        run.providerChannelId !== payload.provider_channel_id ||
        run.credentialVersionId !== payload.credential_version_id ||
        run.probeSuiteVersion !== payload.probe_suite_version ||
        run.requestedSpecKeysDigest !== payload.requested_spec_keys_digest ||
        run.attemptNo !== payload.attempt_no
      ) {
        return 'protected';
      }
      return 'rebuild';
    }
    return 'rebuild';
  }

  private async ensureRedis(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
    await this.redis.ping();
  }
}

export async function ensureQueueRecoveryReady(
  reconciler: Pick<QueueReconciler, 'isReady' | 'reconcile'>,
): Promise<{
  ready: boolean;
  reconciliation?: ReconciliationSummary;
}> {
  if (await reconciler.isReady()) return { ready: true };
  const reconciliation = await reconciler.reconcile();
  return {
    ready: await reconciler.isReady(),
    reconciliation,
  };
}
