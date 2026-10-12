import {
  adminAuditLogs,
  adminPrincipals,
  and,
  artifacts,
  assets,
  authSessions,
  count,
  creditAccounts,
  desc,
  eq,
  gt,
  inArray,
  lt,
  models,
  or,
  pricingCatalogState,
  providerChannels,
  queueDispatchIntents,
  skillCatalogState,
  sql,
  storageRuntimeState,
  taskAttempts,
  tasks,
  users,
  workerHeartbeats,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { queueRecoverySentinelKey } from '@ecom-forge/queue';
import { Injectable } from '@nestjs/common';

import type { AppConfig } from '../../config/app-config.js';
import {
  SignedCursorCodec,
  SignedCursorError,
  type CursorPosition,
} from '../../shared/http/signed-cursor.js';
import type { RedisControlClient } from '../../shared/redis/redis.module.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminSessionContext } from './admin-http.js';

type PageInput = { cursor?: string; limit: number };

function maskEmail(value: string): string {
  const separator = value.lastIndexOf('@');
  if (separator <= 0) return '[redacted]';
  const local = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitizeAuditValue(item, depth + 1));
  if (!value || typeof value !== 'object') {
    if (
      typeof value === 'string' &&
      (/^[^\s@]+@[^\s@]+$/.test(value) || /^https?:\/\//i.test(value))
    ) {
      return '[redacted]';
    }
    return value;
  }
  const blocked =
    /(?:password|secret|token|prompt|ciphertext|nonce|auth_tag|code_digest|totp|recovery_code|signed_url)/i;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !blocked.test(key))
      .slice(0, 200)
      .map(([key, item]) => [key, sanitizeAuditValue(item, depth + 1)]),
  );
}

@Injectable()
export class AdminOperationsQueryService {
  private readonly cursor: SignedCursorCodec;
  private readonly referenceHash: HmacKeyring;

  constructor(
    private readonly database: Database,
    private readonly redis: RedisControlClient,
    private readonly config: AppConfig,
  ) {
    this.cursor = new SignedCursorCodec(config.resourceCursorSecret);
    this.referenceHash = new HmacKeyring(config.admin.sourceHashKeys);
  }

  async dashboard(): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const [
      runRows,
      taskRows,
      riskRows,
      queueRows,
      creditRows,
      providerRows,
      workerRows,
      pricing,
      skills,
    ] = await Promise.all([
      this.database
        .select({ status: workflowRuns.status, value: count() })
        .from(workflowRuns)
        .where(sql`${workflowRuns.createdAt} >= ${since.toISOString()}::timestamptz`)
        .groupBy(workflowRuns.status),
      this.database
        .select({
          status: tasks.status,
          value: count(),
          actualCost: sql<string>`coalesce(sum(${tasks.costActual}), 0)::text`,
        })
        .from(tasks)
        .where(sql`${tasks.createdAt} >= ${since.toISOString()}::timestamptz`)
        .groupBy(tasks.status),
      this.database
        .select({ status: users.riskStatus, value: count() })
        .from(users)
        .groupBy(users.riskStatus),
      this.database
        .select({ status: queueDispatchIntents.status, value: count() })
        .from(queueDispatchIntents)
        .groupBy(queueDispatchIntents.status),
      this.database
        .select({
          balance: sql<string>`coalesce(sum(${creditAccounts.balance}), 0)::text`,
          frozen: sql<string>`coalesce(sum(${creditAccounts.frozen}), 0)::text`,
        })
        .from(creditAccounts),
      this.database
        .select({ status: providerChannels.status, value: count() })
        .from(providerChannels)
        .groupBy(providerChannels.status),
      this.database
        .select()
        .from(workerHeartbeats)
        .orderBy(desc(workerHeartbeats.lastSeenAt))
        .limit(20),
      this.database.query.pricingCatalogState.findFirst({
        where: eq(pricingCatalogState.id, 'global'),
      }),
      this.database.query.skillCatalogState.findFirst({
        where: eq(skillCatalogState.id, 'global'),
      }),
    ]);
    return {
      window: { from: since, to: new Date() },
      workflow_runs: Object.fromEntries(runRows.map((row) => [row.status, Number(row.value)])),
      tasks: Object.fromEntries(
        taskRows.map((row) => [
          row.status,
          { count: Number(row.value), actual_cost_cny: row.actualCost },
        ]),
      ),
      users_by_risk: Object.fromEntries(riskRows.map((row) => [row.status, Number(row.value)])),
      queue_backlog: Object.fromEntries(queueRows.map((row) => [row.status, Number(row.value)])),
      credits: {
        balance: creditRows[0]?.balance ?? '0.00',
        frozen: creditRows[0]?.frozen ?? '0.00',
      },
      providers: Object.fromEntries(providerRows.map((row) => [row.status, Number(row.value)])),
      workers: workerRows.map((row) => ({
        worker_type: row.workerType,
        status: row.status,
        last_seen_at: row.lastSeenAt,
      })),
      releases: {
        pricing_catalog_revision: pricing?.catalogRevision ?? 0,
        pricing_release_id: pricing?.activeReleaseId ?? null,
        skill_catalog_revision: skills?.revision ?? 0,
        skill_release_id: skills?.activeReleaseId ?? null,
      },
    };
  }

  async users(
    context: AdminSessionContext,
    input: PageInput & { riskStatus?: 'normal' | 'limited' | 'frozen' },
  ): Promise<Record<string, unknown>> {
    const filters = { risk_status: input.riskStatus ?? null };
    const position = this.decodeCursor(context, input.cursor, 'admin-users', filters);
    const rows = await this.database
      .select()
      .from(users)
      .where(
        and(
          input.riskStatus ? eq(users.riskStatus, input.riskStatus) : undefined,
          position
            ? or(
                lt(users.createdAt, position.createdAt),
                and(eq(users.createdAt, position.createdAt), lt(users.id, position.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        user_ref: this.referenceHash.digest(row.id).digest,
        email_masked: maskEmail(row.email),
        display_name: row.displayName,
        email_verified: Boolean(row.emailVerifiedAt),
        risk_status: row.riskStatus,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
      next_cursor: this.nextCursor(context, 'admin-users', filters, rows.length, input.limit, last),
    };
  }

  async user(userId: string): Promise<Record<string, unknown>> {
    const user = await this.database.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const [account, runCount, assetCount, artifactCount, sessionCount] = await Promise.all([
      this.database.query.creditAccounts.findFirst({ where: eq(creditAccounts.userId, userId) }),
      this.database
        .select({ value: count() })
        .from(workflowRuns)
        .where(eq(workflowRuns.userId, userId)),
      this.database.select({ value: count() }).from(assets).where(eq(assets.userId, userId)),
      this.database.select({ value: count() }).from(artifacts).where(eq(artifacts.userId, userId)),
      this.database
        .select({ value: count() })
        .from(authSessions)
        .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date()))),
    ]);
    return {
      id: user.id,
      user_ref: this.referenceHash.digest(user.id).digest,
      email_masked: maskEmail(user.email),
      display_name: user.displayName,
      email_verified: Boolean(user.emailVerifiedAt),
      risk_status: user.riskStatus,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
      credit: account
        ? { balance: account.balance, frozen: account.frozen, version: account.version }
        : null,
      counts: {
        workflow_runs: Number(runCount[0]?.value ?? 0),
        assets: Number(assetCount[0]?.value ?? 0),
        artifacts: Number(artifactCount[0]?.value ?? 0),
        active_sessions: Number(sessionCount[0]?.value ?? 0),
      },
    };
  }

  async workflowRuns(
    context: AdminSessionContext,
    input: PageInput & { status?: (typeof workflowRuns.$inferSelect)['status'] },
  ): Promise<Record<string, unknown>> {
    const filters = { status: input.status ?? null };
    const position = this.decodeCursor(context, input.cursor, 'admin-workflow-runs', filters);
    const rows = await this.database
      .select({ run: workflowRuns, userEmail: users.email })
      .from(workflowRuns)
      .innerJoin(users, eq(users.id, workflowRuns.userId))
      .where(
        and(
          input.status ? eq(workflowRuns.status, input.status) : undefined,
          position
            ? or(
                lt(workflowRuns.createdAt, position.createdAt),
                and(
                  eq(workflowRuns.createdAt, position.createdAt),
                  lt(workflowRuns.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1)?.run;
    return {
      items: page.map(({ run, userEmail }) => ({
        id: run.id,
        user_ref: this.referenceHash.digest(run.userId).digest,
        user_email_masked: maskEmail(userEmail),
        product_id: run.productId,
        trigger_mode: run.triggerMode,
        status: run.status,
        reservation_id: run.reservationId,
        created_at: run.createdAt,
        finished_at: run.finishedAt,
      })),
      next_cursor: this.nextCursor(
        context,
        'admin-workflow-runs',
        filters,
        rows.length,
        input.limit,
        last,
      ),
    };
  }

  async workflowRun(runId: string): Promise<Record<string, unknown>> {
    const run = await this.database.query.workflowRuns.findFirst({
      where: eq(workflowRuns.id, runId),
    });
    if (!run) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const taskRows = await this.database
      .select()
      .from(tasks)
      .where(eq(tasks.workflowRunId, run.id))
      .orderBy(tasks.createdAt, tasks.id);
    const attempts = taskRows.length
      ? await this.database
          .select()
          .from(taskAttempts)
          .where(
            inArray(
              taskAttempts.taskId,
              taskRows.map((task) => task.id),
            ),
          )
          .orderBy(taskAttempts.taskId, taskAttempts.attemptNo)
      : [];
    return {
      id: run.id,
      user_ref: this.referenceHash.digest(run.userId).digest,
      product_id: run.productId,
      trigger_mode: run.triggerMode,
      status: run.status,
      reservation_id: run.reservationId,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
      tasks: taskRows.map((task) => ({
        ...this.taskSummary(task),
        attempts: attempts
          .filter((attempt) => attempt.taskId === task.id)
          .map((attempt) => this.attemptSummary(attempt)),
      })),
    };
  }

  async tasks(
    context: AdminSessionContext,
    input: PageInput & { status?: (typeof tasks.$inferSelect)['status'] },
  ): Promise<Record<string, unknown>> {
    const filters = { status: input.status ?? null };
    const position = this.decodeCursor(context, input.cursor, 'admin-tasks', filters);
    const rows = await this.database
      .select({ task: tasks, runUserId: workflowRuns.userId })
      .from(tasks)
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(
        and(
          input.status ? eq(tasks.status, input.status) : undefined,
          position
            ? or(
                lt(tasks.createdAt, position.createdAt),
                and(eq(tasks.createdAt, position.createdAt), lt(tasks.id, position.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1)?.task;
    return {
      items: page.map(({ task, runUserId }) => ({
        ...this.taskSummary(task),
        user_ref: this.referenceHash.digest(runUserId).digest,
      })),
      next_cursor: this.nextCursor(context, 'admin-tasks', filters, rows.length, input.limit, last),
    };
  }

  async task(taskId: string): Promise<Record<string, unknown>> {
    const task = await this.database.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    if (!task) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const attempts = await this.database
      .select()
      .from(taskAttempts)
      .where(eq(taskAttempts.taskId, task.id))
      .orderBy(taskAttempts.attemptNo);
    const intents = await this.database
      .select({
        id: queueDispatchIntents.id,
        queueName: queueDispatchIntents.queueName,
        jobId: queueDispatchIntents.jobId,
        status: queueDispatchIntents.status,
        attemptCount: queueDispatchIntents.attemptCount,
        nextAttemptAt: queueDispatchIntents.nextAttemptAt,
        createdAt: queueDispatchIntents.createdAt,
      })
      .from(queueDispatchIntents)
      .where(
        and(
          eq(queueDispatchIntents.aggregateType, 'task'),
          eq(queueDispatchIntents.aggregateId, task.id),
        ),
      )
      .orderBy(desc(queueDispatchIntents.createdAt));
    return {
      ...this.taskSummary(task),
      error: task.errorCode ? { code: task.errorCode, message: task.errorMessage } : null,
      attempts: attempts.map((attempt) => this.attemptSummary(attempt)),
      intents: intents.map((intent) => ({
        id: intent.id,
        queue_name: intent.queueName,
        job_ref: this.referenceHash.digest(intent.jobId).digest,
        status: intent.status,
        attempt_count: intent.attemptCount,
        next_attempt_at: intent.nextAttemptAt,
        created_at: intent.createdAt,
      })),
    };
  }

  async auditLogs(
    context: AdminSessionContext,
    input: PageInput & { action?: string; result?: 'succeeded' | 'failed' | 'blocked' },
  ): Promise<Record<string, unknown>> {
    const filters = { action: input.action ?? null, result: input.result ?? null };
    const position = this.decodeCursor(context, input.cursor, 'admin-audit-logs', filters);
    const rows = await this.database
      .select({
        audit: adminAuditLogs,
        actorDisplayName: adminPrincipals.displayName,
        actorIdentifierHint: adminPrincipals.identifierHint,
      })
      .from(adminAuditLogs)
      .leftJoin(adminPrincipals, eq(adminPrincipals.id, adminAuditLogs.actorAdminId))
      .where(
        and(
          input.action ? eq(adminAuditLogs.action, input.action) : undefined,
          input.result ? eq(adminAuditLogs.result, input.result) : undefined,
          position
            ? or(
                lt(adminAuditLogs.createdAt, position.createdAt),
                and(
                  eq(adminAuditLogs.createdAt, position.createdAt),
                  lt(adminAuditLogs.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(adminAuditLogs.createdAt), desc(adminAuditLogs.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1)?.audit;
    return {
      items: page.map(({ audit: row, actorDisplayName, actorIdentifierHint }) => ({
        id: row.id,
        actor_admin_id: row.actorAdminId,
        actor_display_name: actorDisplayName,
        actor_identifier_hint: actorIdentifierHint,
        action: row.action,
        target_type: row.targetType,
        target_id: row.targetId,
        reason: row.reason,
        request_id: row.requestId,
        source_ref: row.sourceIpHash,
        user_agent_ref: row.userAgentHash,
        result: row.result,
        error_code: row.errorCode,
        created_at: row.createdAt,
      })),
      next_cursor: this.nextCursor(
        context,
        'admin-audit-logs',
        filters,
        rows.length,
        input.limit,
        last,
      ),
    };
  }

  async auditLog(id: string): Promise<Record<string, unknown>> {
    const row = await this.database.query.adminAuditLogs.findFirst({
      where: eq(adminAuditLogs.id, id),
    });
    if (!row) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    return {
      id: row.id,
      actor_admin_id: row.actorAdminId,
      actor_type: row.actorType,
      admin_session_id: row.adminSessionId,
      permission_snapshot: sanitizeAuditValue(row.permissionSnapshot),
      action: row.action,
      target_type: row.targetType,
      target_id: row.targetId,
      before: sanitizeAuditValue(row.beforeJson),
      after: sanitizeAuditValue(row.afterJson),
      reason: row.reason,
      request_id: row.requestId,
      trace_id: row.traceId,
      source_ref: row.sourceIpHash,
      user_agent_ref: row.userAgentHash,
      mfa_level: row.mfaLevel,
      step_up_at: row.stepUpAt,
      result: row.result,
      error_code: row.errorCode,
      created_at: row.createdAt,
    };
  }

  async health(): Promise<Record<string, unknown>> {
    let databaseOk = false;
    let redisOk = false;
    let recoveryReady = false;
    try {
      await this.database.execute(sql`select 1`);
      databaseOk = true;
    } catch {
      databaseOk = false;
    }
    try {
      redisOk = (await this.redis.ping()) === 'PONG';
      recoveryReady =
        (await this.redis.get(queueRecoverySentinelKey(this.config.redisPrefix))) === 'ready';
    } catch {
      redisOk = false;
      recoveryReady = false;
    }
    if (!databaseOk) {
      return {
        status: 'not_ready',
        dependencies: {
          database: 'unavailable',
          redis: redisOk ? 'ok' : 'unavailable',
          queue_recovery: recoveryReady ? 'ready' : 'not_ready',
          storage_runtime: 'unknown',
        },
        workers: [],
        provider_summary: { active_channels: 0, poc_passed_models: 0 },
        checked_at: new Date(),
      };
    }

    let workers: (typeof workerHeartbeats.$inferSelect)[];
    let storage: typeof storageRuntimeState.$inferSelect | undefined;
    let activeProviders: { value: number | bigint }[];
    let activeModels: { value: number | bigint }[];
    try {
      [workers, storage, activeProviders, activeModels] = await Promise.all([
        this.database
          .select()
          .from(workerHeartbeats)
          .orderBy(desc(workerHeartbeats.lastSeenAt))
          .limit(50),
        this.database.query.storageRuntimeState.findFirst({
          where: eq(storageRuntimeState.purpose, 'private_assets'),
        }),
        this.database
          .select({ value: count() })
          .from(providerChannels)
          .where(eq(providerChannels.status, 'active')),
        this.database
          .select({ value: count() })
          .from(models)
          .where(eq(models.status, 'poc_passed')),
      ]);
    } catch {
      return {
        status: 'not_ready',
        dependencies: {
          database: 'unavailable',
          redis: redisOk ? 'ok' : 'unavailable',
          queue_recovery: recoveryReady ? 'ready' : 'not_ready',
          storage_runtime: 'unknown',
        },
        workers: [],
        provider_summary: { active_channels: 0, poc_passed_models: 0 },
        checked_at: new Date(),
      };
    }
    const now = Date.now();
    return {
      status: databaseOk && redisOk && recoveryReady ? 'ready' : 'not_ready',
      dependencies: {
        database: databaseOk ? 'ok' : 'unavailable',
        redis: redisOk ? 'ok' : 'unavailable',
        queue_recovery: recoveryReady ? 'ready' : 'not_ready',
        storage_runtime: storage?.activeChannelId ? 'configured' : 'not_configured',
      },
      workers: workers.map((worker) => ({
        worker_type: worker.workerType,
        status: now - worker.lastSeenAt.getTime() <= 60_000 ? worker.status : 'stale',
        last_seen_at: worker.lastSeenAt,
      })),
      provider_summary: {
        active_channels: Number(activeProviders[0]?.value ?? 0),
        poc_passed_models: Number(activeModels[0]?.value ?? 0),
      },
      checked_at: new Date(),
    };
  }

  private taskSummary(task: typeof tasks.$inferSelect): Record<string, unknown> {
    return {
      id: task.id,
      workflow_run_id: task.workflowRunId,
      parent_task_id: task.parentTaskId,
      type: task.type,
      status: task.status,
      model_snapshot_id: task.modelId,
      model_version: task.modelVersion,
      cost_estimate_cny: task.costEstimate,
      cost_actual_cny: task.costActual,
      dag_node_id: task.dagNodeId,
      error_code: task.errorCode,
      created_at: task.createdAt,
      started_at: task.startedAt,
      ended_at: task.endedAt,
    };
  }

  private attemptSummary(attempt: typeof taskAttempts.$inferSelect): Record<string, unknown> {
    return {
      id: attempt.id,
      attempt_no: attempt.attemptNo,
      status: attempt.status,
      dispatch_state: attempt.dispatchState,
      provider: attempt.provider,
      provider_request_ref: attempt.providerRequestId
        ? this.referenceHash.digest(attempt.providerRequestId).digest
        : null,
      provider_reported_cost_cny: attempt.providerReportedCost,
      error_summary: sanitizeAuditValue(attempt.rawErrorSummary),
      poll_count: attempt.pollCount,
      started_at: attempt.startedAt,
      accepted_at: attempt.acceptedAt,
      last_polled_at: attempt.lastPolledAt,
      ended_at: attempt.endedAt,
    };
  }

  private decodeCursor(
    context: AdminSessionContext,
    cursor: string | undefined,
    endpoint: string,
    filters: unknown,
  ): CursorPosition | undefined {
    if (!cursor) return undefined;
    try {
      return this.cursor.decode({ cursor, userId: context.principalId, endpoint, filters });
    } catch (error) {
      if (error instanceof SignedCursorError) adminAuthError('ADMIN_CURSOR_INVALID', 400);
      throw error;
    }
  }

  private nextCursor(
    context: AdminSessionContext,
    endpoint: string,
    filters: unknown,
    rowCount: number,
    limit: number,
    last: { id: string; createdAt: Date } | undefined,
  ): string | null {
    return rowCount > limit && last
      ? this.cursor.encode({
          userId: context.principalId,
          endpoint,
          filters,
          position: { id: last.id, createdAt: last.createdAt },
        })
      : null;
  }
}
