import { randomUUID } from 'node:crypto';

import type { AgentBrainModelSnapshot } from '@ecom-forge/agent';
import { AgentBrainCallError } from '@ecom-forge/agent';
import {
  agentTraceSteps,
  and,
  asc,
  eq,
  gte,
  inArray,
  providerCircuitStates,
  sql,
  type Database,
} from '@ecom-forge/db';
import { evaluateCircuitWindow } from '@ecom-forge/provider';
import { compareMoney } from '@ecom-forge/shared';
import type { Redis } from 'ioredis';

import {
  RedisProviderQuotaGate,
  type RuntimeQuotaModel,
} from '../provider/redis-provider-quota.gate.js';

type CircuitRow = typeof providerCircuitStates.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type QuotaPermit = Awaited<ReturnType<RedisProviderQuotaGate['reserve']>>;

export interface AgentBrainRuntimePermit {
  circuitProbeToken?: string;
  quotaModel: RuntimeQuotaModel;
  quotaPermit: QuotaPermit;
}

type CircuitOutcome = 'succeeded' | 'outcome_unknown';

export class AgentBrainRuntimeGuard {
  private readonly quota: RedisProviderQuotaGate;

  constructor(
    private readonly database: Database,
    redis: Redis,
    redisPrefix: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.quota = new RedisProviderQuotaGate(redis, `${redisPrefix}:agent-brain`, now);
  }

  async reserve(
    snapshot: AgentBrainModelSnapshot,
    deadline: Date,
  ): Promise<AgentBrainRuntimePermit> {
    const quotaModel = runtimeQuotaModel(snapshot);
    let quotaPermit: QuotaPermit;
    try {
      quotaPermit = await this.quota.reserve(quotaModel, { deadlineAt: deadline });
    } catch {
      throw new AgentBrainCallError('AGENT_BRAIN_QUOTA_UNAVAILABLE', 'not_dispatched');
    }
    try {
      const circuitProbeToken = await this.assertCircuitAndBudget(snapshot);
      return {
        ...(circuitProbeToken ? { circuitProbeToken } : {}),
        quotaModel,
        quotaPermit,
      };
    } catch (error) {
      await this.quota.release(quotaModel, quotaPermit).catch(() => undefined);
      if (error instanceof AgentBrainCallError) throw error;
      throw new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_UNAVAILABLE', 'not_dispatched');
    }
  }

  async record(
    snapshot: AgentBrainModelSnapshot,
    permit: AgentBrainRuntimePermit,
    outcome: CircuitOutcome,
  ): Promise<void> {
    try {
      await this.database.transaction((transaction) =>
        this.recordInTransaction(transaction, snapshot, permit.circuitProbeToken, outcome),
      );
    } catch {
      throw new AgentBrainCallError('AGENT_BRAIN_CIRCUIT_EVIDENCE_UNAVAILABLE', 'outcome_unknown');
    }
  }

  async release(permit: AgentBrainRuntimePermit): Promise<void> {
    try {
      await this.quota.release(permit.quotaModel, permit.quotaPermit);
    } catch {
      throw new AgentBrainCallError('AGENT_BRAIN_QUOTA_RELEASE_UNAVAILABLE', 'outcome_unknown');
    }
  }

  private async assertCircuitAndBudget(snapshot: AgentBrainModelSnapshot): Promise<string | null> {
    const modelId = requiredSnapshotId(snapshot);
    const decision = await this.database.transaction(async (transaction) => {
      const expected = circuitScopes(snapshot, modelId);
      await transaction.insert(providerCircuitStates).values(expected).onConflictDoNothing();
      const rows = await transaction
        .select()
        .from(providerCircuitStates)
        .where(
          inArray(
            providerCircuitStates.scopeKey,
            expected.map((row) => row.scopeKey),
          ),
        )
        .orderBy(asc(providerCircuitStates.scopeKey))
        .for('update');
      if (rows.length !== expected.length) {
        throw new Error('AGENT_BRAIN_CIRCUIT_STATE_INCOMPLETE');
      }

      const budget = await this.costExposure(transaction, modelId);
      const budgetReason =
        compareMoney(budget.hourly, snapshot.quota.hourly_budget_cny) > 0
          ? 'hourly_budget'
          : compareMoney(budget.daily, snapshot.quota.daily_budget_cny) > 0
            ? 'daily_budget'
            : null;
      if (budgetReason) {
        const modelRow = rows.find((row) => row.scopeType === 'model');
        if (!modelRow) throw new Error('AGENT_BRAIN_MODEL_CIRCUIT_MISSING');
        await this.open(transaction, modelRow, snapshot, budgetReason);
        return { denied: 'AGENT_BRAIN_COST_BUDGET_EXCEEDED' as const };
      }

      const now = this.now();
      const expiredHalfOpen = rows.filter(
        (row) => row.status === 'half_open' && (!row.probeAfter || row.probeAfter <= now),
      );
      if (expiredHalfOpen.length > 0) {
        for (const row of expiredHalfOpen) {
          await this.open(transaction, row, snapshot, 'half_open_probe_timeout');
        }
        return { denied: 'AGENT_BRAIN_CIRCUIT_OPEN' as const };
      }
      if (
        rows.some(
          (row) =>
            row.status === 'half_open' ||
            (row.status === 'open' && (!row.probeAfter || row.probeAfter > now)),
        )
      ) {
        return { denied: 'AGENT_BRAIN_CIRCUIT_OPEN' as const };
      }

      const expiredOpen = rows.filter(
        (row) => row.status === 'open' && row.probeAfter && row.probeAfter <= now,
      );
      if (expiredOpen.length === 0) return { probeToken: null };
      const probeToken = randomUUID();
      for (const row of expiredOpen) {
        await this.update(transaction, row, {
          status: 'half_open',
          probeAfter: new Date(now.getTime() + snapshot.quota.circuit_open_ms),
          probeOwner: probeToken,
        });
      }
      return { probeToken };
    });
    if ('denied' in decision) {
      throw new AgentBrainCallError(decision.denied, 'not_dispatched');
    }
    return decision.probeToken;
  }

  private async recordInTransaction(
    transaction: Transaction,
    snapshot: AgentBrainModelSnapshot,
    probeToken: string | undefined,
    outcome: CircuitOutcome,
  ): Promise<void> {
    const modelId = requiredSnapshotId(snapshot);
    const expected = circuitScopes(snapshot, modelId);
    await transaction.insert(providerCircuitStates).values(expected).onConflictDoNothing();
    const rows = await transaction
      .select()
      .from(providerCircuitStates)
      .where(
        inArray(
          providerCircuitStates.scopeKey,
          expected.map((row) => row.scopeKey),
        ),
      )
      .orderBy(asc(providerCircuitStates.scopeKey))
      .for('update');
    if (rows.length !== expected.length) throw new Error('AGENT_BRAIN_CIRCUIT_STATE_INCOMPLETE');

    for (const row of rows) {
      if (probeToken) {
        if (row.status !== 'half_open' || row.probeOwner !== probeToken) continue;
        if (outcome === 'succeeded') {
          await this.update(transaction, row, {
            status: 'closed',
            reasonCode: null,
            sampleCount: 0,
            failureCount: 0,
            unknownCount: 0,
            openedAt: null,
            probeAfter: null,
            probeOwner: null,
            windowStartedAt: this.now(),
          });
        } else {
          await this.open(transaction, row, snapshot, 'half_open_probe_unknown');
        }
        continue;
      }
      if (row.status !== 'closed') continue;
      const sampleCount = row.sampleCount + 1;
      const unknownCount = row.unknownCount + (outcome === 'outcome_unknown' ? 1 : 0);
      const reason = evaluateCircuitWindow({
        sampleCount,
        failureCount: row.failureCount,
        unknownCount,
        model: snapshot,
      });
      if (reason) {
        await this.open(transaction, row, snapshot, reason, {
          sampleCount,
          failureCount: row.failureCount,
          unknownCount,
        });
      } else {
        await this.update(transaction, row, { sampleCount, unknownCount });
      }
    }
  }

  private async costExposure(transaction: Transaction, modelId: string) {
    const now = this.now();
    const hourStart = new Date(now.getTime() - 60 * 60 * 1_000);
    const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const [hourly] = await transaction
      .select({ value: sql<string>`coalesce(sum(${agentTraceSteps.estimatedCost}), 0)::text` })
      .from(agentTraceSteps)
      .where(
        and(
          eq(agentTraceSteps.modelSnapshotId, modelId),
          gte(agentTraceSteps.createdAt, hourStart),
        ),
      );
    const [daily] = await transaction
      .select({ value: sql<string>`coalesce(sum(${agentTraceSteps.estimatedCost}), 0)::text` })
      .from(agentTraceSteps)
      .where(
        and(eq(agentTraceSteps.modelSnapshotId, modelId), gte(agentTraceSteps.createdAt, dayStart)),
      );
    return { hourly: hourly?.value ?? '0.00', daily: daily?.value ?? '0.00' };
  }

  private open(
    transaction: Transaction,
    row: CircuitRow,
    snapshot: AgentBrainModelSnapshot,
    reasonCode: string,
    counts: Partial<Pick<CircuitRow, 'sampleCount' | 'failureCount' | 'unknownCount'>> = {},
  ): Promise<void> {
    const now = this.now();
    return this.update(transaction, row, {
      ...counts,
      status: 'open',
      reasonCode,
      openedAt: now,
      probeAfter: new Date(now.getTime() + snapshot.quota.circuit_open_ms),
      probeOwner: null,
    });
  }

  private async update(
    transaction: Transaction,
    row: CircuitRow,
    values: Partial<typeof providerCircuitStates.$inferInsert>,
  ): Promise<void> {
    const [updated] = await transaction
      .update(providerCircuitStates)
      .set({
        ...values,
        revision: sql`${providerCircuitStates.revision} + 1`,
        updatedAt: this.now(),
      })
      .where(
        and(eq(providerCircuitStates.id, row.id), eq(providerCircuitStates.revision, row.revision)),
      )
      .returning({ id: providerCircuitStates.id });
    if (!updated) throw new Error('AGENT_BRAIN_CIRCUIT_REVISION_CONFLICT');
  }
}

function requiredSnapshotId(snapshot: AgentBrainModelSnapshot): string {
  if (!snapshot.snapshot_id) {
    throw new AgentBrainCallError('AGENT_BRAIN_MODEL_SNAPSHOT_ID_REQUIRED', 'not_dispatched');
  }
  return snapshot.snapshot_id;
}

function runtimeQuotaModel(snapshot: AgentBrainModelSnapshot): RuntimeQuotaModel {
  return {
    id: requiredSnapshotId(snapshot),
    provider: snapshot.provider,
    version: snapshot.version,
    quota: { rpm: snapshot.quota.rpm, concurrency: snapshot.quota.concurrency },
  };
}

function circuitScopes(snapshot: AgentBrainModelSnapshot, modelId: string) {
  return [
    {
      scopeType: 'provider' as const,
      scopeKey: `provider:${snapshot.provider}`,
      provider: snapshot.provider,
      modelId: null,
    },
    {
      scopeType: 'model' as const,
      scopeKey: `model:${modelId}`,
      provider: snapshot.provider,
      modelId,
    },
  ];
}
