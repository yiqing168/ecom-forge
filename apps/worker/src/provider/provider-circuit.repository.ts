import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  or,
  providerCircuitStates,
  sql,
  taskAttempts,
  tasks,
  type Database,
} from '@ecom-forge/db';
import {
  calculateCostReport,
  evaluateCircuitWindow,
  hourlyDispatchExposureExceeded,
  type CircuitGate,
  type CircuitPermit,
  type MediaV2ModelSnapshot,
  type ModelSnapshot,
  type ModerationOutcome,
  type ProviderImageExecutionOutcome,
  type ProviderSubmitOutcome,
} from '@ecom-forge/provider';
import { compareMoney } from '@ecom-forge/shared';

type CircuitRow = typeof providerCircuitStates.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type RuntimeCircuitModel = ModelSnapshot | MediaV2ModelSnapshot;

export type ProviderTerminalEvidence =
  | { kind: 'succeeded' }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'outcome_unknown'; errorCode: string };

export interface ProviderCircuitTelemetry {
  info(event: Record<string, unknown>): void;
}

function circuitRiskAdjustedUnitCost(model: RuntimeCircuitModel): string | null {
  const pricing = model.pricing;
  if (pricing.schema_version === 1) {
    if (Object.values(pricing).some((value) => value === null)) return null;
    return calculateCostReport({
      providerUnitCostCny: pricing.provider_unit_cost_cny!,
      toolCostCny: pricing.tool_cost_cny!,
      storageCostCny: pricing.storage_cost_cny!,
      trafficCostCny: pricing.traffic_cost_cny!,
      agentBrainCostCny: pricing.agent_brain_cost_cny!,
      failureRate: pricing.failure_rate!,
      unknownRate: pricing.unknown_rate!,
      refundRate: pricing.refund_rate!,
      riskReserveRate: pricing.risk_reserve_rate!,
      grossMarginTarget: pricing.gross_margin_target!,
      creditCnyAnchor: pricing.credit_cny_anchor!,
    }).riskAdjustedCostCny;
  }
  if (
    pricing.rate_cards.some((rate) => rate.unit_cost_cny === null) ||
    Object.values(pricing.overhead_cny).some((value) => value === null) ||
    pricing.failure_rate === null ||
    pricing.unknown_rate === null ||
    pricing.refund_rate === null ||
    pricing.risk_reserve_rate === null ||
    pricing.gross_margin_target === null ||
    pricing.credit_cny_anchor === null
  ) {
    return null;
  }
  return pricing.rate_cards
    .map(
      (rate) =>
        calculateCostReport({
          providerUnitCostCny: rate.unit_cost_cny!,
          toolCostCny: pricing.overhead_cny.tool!,
          storageCostCny: pricing.overhead_cny.storage!,
          trafficCostCny: pricing.overhead_cny.traffic!,
          agentBrainCostCny: pricing.overhead_cny.agent_brain!,
          failureRate: pricing.failure_rate!,
          unknownRate: pricing.unknown_rate!,
          refundRate: pricing.refund_rate!,
          riskReserveRate: pricing.risk_reserve_rate!,
          grossMarginTarget: pricing.gross_margin_target!,
          creditCnyAnchor: pricing.credit_cny_anchor!,
        }).riskAdjustedCostCny,
    )
    .reduce((highest, value) => (compareMoney(value, highest) > 0 ? value : highest), '0.00');
}

function classifyImageOutcome(outcome: ProviderImageExecutionOutcome): CircuitClassification {
  if (outcome.kind === 'accepted') {
    return { success: true, sample: 0, failure: 0, unknown: 0, immediateReason: null };
  }
  if (outcome.kind === 'succeeded') {
    return { success: true, sample: 1, failure: 0, unknown: 0, immediateReason: null };
  }
  if (outcome.kind === 'outcome_unknown') {
    return { success: false, sample: 1, failure: 0, unknown: 1, immediateReason: null };
  }
  if (outcome.kind === 'not_dispatched') {
    return { success: false, sample: 0, failure: 0, unknown: 0, immediateReason: null };
  }
  const immediateReason = IMMEDIATE_OPEN_ERRORS.has(outcome.error_code) ? outcome.error_code : null;
  return { success: false, sample: 1, failure: 1, unknown: 0, immediateReason };
}

const NOOP_CIRCUIT_TELEMETRY: ProviderCircuitTelemetry = { info: () => undefined };

interface CircuitClassification {
  success: boolean;
  sample: number;
  failure: number;
  unknown: number;
  immediateReason: string | null;
}

const IMMEDIATE_OPEN_ERRORS = new Set(['provider_auth_failed', 'provider_quota_exhausted']);

export class ProviderCircuitOpenError extends Error {
  constructor(readonly reasonCode: string) {
    super('Provider circuit is open');
    this.name = 'ProviderCircuitOpenError';
  }
}

function scopeRows(model: RuntimeCircuitModel) {
  return [
    {
      scopeType: 'provider' as const,
      scopeKey: `provider:${model.provider}`,
      provider: model.provider,
      modelId: null,
    },
    {
      scopeType: 'model' as const,
      scopeKey: `model:${model.id}`,
      provider: model.provider,
      modelId: model.id,
    },
  ];
}

function classifyOutcome(outcome: ProviderSubmitOutcome): CircuitClassification {
  if (outcome.kind === 'accepted') {
    return {
      success: true,
      sample: 0,
      failure: 0,
      unknown: 0,
      immediateReason: null,
    };
  }
  if (outcome.kind === 'succeeded') {
    return {
      success: true,
      sample: 1,
      failure: 0,
      unknown: 0,
      immediateReason: null,
    };
  }
  if (outcome.kind === 'outcome_unknown') {
    return {
      success: false,
      sample: 1,
      failure: 0,
      unknown: 1,
      immediateReason: null,
    };
  }
  const immediateReason = IMMEDIATE_OPEN_ERRORS.has(outcome.error_code) ? outcome.error_code : null;
  return { success: false, sample: 1, failure: 1, unknown: 0, immediateReason };
}

function classifyTerminalEvidence(evidence: ProviderTerminalEvidence): CircuitClassification {
  if (evidence.kind === 'succeeded') {
    return {
      success: true,
      sample: 1,
      failure: 0,
      unknown: 0,
      immediateReason: null,
    };
  }
  if (evidence.kind === 'outcome_unknown') {
    return {
      success: false,
      sample: 1,
      failure: 0,
      unknown: 1,
      immediateReason: null,
    };
  }
  return {
    success: false,
    sample: 1,
    failure: 1,
    unknown: 0,
    immediateReason: IMMEDIATE_OPEN_ERRORS.has(evidence.errorCode) ? evidence.errorCode : null,
  };
}

function classifyModerationOutcome(outcome: ModerationOutcome): CircuitClassification {
  if (outcome.decision !== 'unknown') {
    return {
      success: true,
      sample: 1,
      failure: 0,
      unknown: 0,
      immediateReason: null,
    };
  }
  return {
    success: false,
    sample: 1,
    failure: 0,
    unknown: 1,
    immediateReason: IMMEDIATE_OPEN_ERRORS.has(outcome.error_code) ? outcome.error_code : null,
  };
}

export class ProviderCircuitRepository implements CircuitGate {
  constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly assertWritesAllowed: () => void = () => undefined,
    private readonly telemetry: ProviderCircuitTelemetry = NOOP_CIRCUIT_TELEMETRY,
  ) {}

  async assertCanSubmit(model: RuntimeCircuitModel): Promise<CircuitPermit> {
    this.assertWritesAllowed();
    const decision = await this.database.transaction(async (transaction) => {
      await transaction
        .insert(providerCircuitStates)
        .values(scopeRows(model))
        .onConflictDoNothing();
      const rows = await transaction
        .select()
        .from(providerCircuitStates)
        .where(
          inArray(
            providerCircuitStates.scopeKey,
            scopeRows(model).map((row) => row.scopeKey),
          ),
        )
        .orderBy(asc(providerCircuitStates.scopeKey))
        .for('update');
      if (rows.length !== 2) throw new ProviderCircuitOpenError('circuit_state_incomplete');

      const budgetExceeded = await this.hourlyBudgetExceeded(transaction, model);
      if (budgetExceeded) {
        const modelRow = rows.find((row) => row.scopeType === 'model');
        if (!modelRow) throw new ProviderCircuitOpenError('model_circuit_state_missing');
        await this.openWithRevision(transaction, modelRow, model, 'hourly_budget');
        return { deniedReason: 'hourly_budget' };
      }
      const now = this.now();
      const expiredHalfOpen = rows.filter(
        (row) => row.status === 'half_open' && (!row.probeAfter || row.probeAfter <= now),
      );
      if (expiredHalfOpen.length > 0) {
        for (const row of expiredHalfOpen) {
          await this.openWithRevision(transaction, row, model, 'half_open_probe_timeout');
        }
        return { deniedReason: 'half_open_probe_timeout' };
      }
      const unavailable = rows.find(
        (row) =>
          row.status === 'half_open' ||
          (row.status === 'open' && (!row.probeAfter || row.probeAfter > now)),
      );
      if (unavailable) {
        throw new ProviderCircuitOpenError(unavailable.reasonCode ?? unavailable.status);
      }
      const expiredOpen = rows.filter(
        (row) => row.status === 'open' && row.probeAfter && row.probeAfter <= now,
      );
      if (expiredOpen.length === 0) return { permit: {} };

      const probeToken = randomUUID();
      for (const row of expiredOpen) {
        const [updated] = await transaction
          .update(providerCircuitStates)
          .set({
            status: 'half_open',
            probeAfter: new Date(now.getTime() + model.quota.circuit_open_ms),
            probeOwner: probeToken,
            revision: sql`${providerCircuitStates.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(providerCircuitStates.id, row.id),
              eq(providerCircuitStates.status, 'open'),
              eq(providerCircuitStates.revision, row.revision),
            ),
          )
          .returning({ id: providerCircuitStates.id });
        if (!updated) throw new ProviderCircuitOpenError('half_open_probe_conflict');
      }
      return { permit: { probeToken } };
    });
    if ('deniedReason' in decision) {
      this.telemetry.info({
        event: 'provider_circuit_submit_rejected',
        metric: 'provider_circuit_reject_total',
        provider: model.provider,
        model_version: model.version,
        reason_code: decision.deniedReason,
      });
      throw new ProviderCircuitOpenError(decision.deniedReason);
    }
    if (decision.permit.probeToken) {
      this.telemetry.info({
        event: 'provider_circuit_probe_claimed',
        metric: 'provider_circuit_probe_total',
        provider: model.provider,
        model_version: model.version,
      });
    }
    return decision.permit;
  }

  recordOutcome(
    model: RuntimeCircuitModel,
    outcome: ProviderSubmitOutcome,
    permit: CircuitPermit | void,
  ): Promise<void> {
    this.assertWritesAllowed();
    return this.database.transaction((transaction) =>
      this.recordClassification(transaction, model, classifyOutcome(outcome), permit),
    );
  }

  recordModerationOutcome(
    model: RuntimeCircuitModel,
    outcome: ModerationOutcome,
    permit: CircuitPermit | void,
  ): Promise<void> {
    this.assertWritesAllowed();
    return this.database.transaction((transaction) =>
      this.recordClassification(transaction, model, classifyModerationOutcome(outcome), permit),
    );
  }

  recordImageOutcome(
    model: RuntimeCircuitModel,
    outcome: ProviderImageExecutionOutcome,
    permit: CircuitPermit | void,
  ): Promise<void> {
    this.assertWritesAllowed();
    return this.database.transaction((transaction) =>
      this.recordClassification(transaction, model, classifyImageOutcome(outcome), permit),
    );
  }

  /**
   * Release a half-open probe when the attempt CAS fails before any Provider
   * request can be started. This is not an outcome and must not add a failure
   * or unknown sample to the circuit window.
   */
  async releaseProbe(model: RuntimeCircuitModel, permit: CircuitPermit | void): Promise<void> {
    this.assertWritesAllowed();
    if (!permit?.probeToken) return;
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(providerCircuitStates)
        .where(
          inArray(
            providerCircuitStates.scopeKey,
            scopeRows(model).map((row) => row.scopeKey),
          ),
        )
        .orderBy(asc(providerCircuitStates.scopeKey))
        .for('update');
      const now = this.now();
      for (const row of rows) {
        if (row.status !== 'half_open' || row.probeOwner !== permit.probeToken) continue;
        await this.updateWithRevision(transaction, row, {
          status: 'open',
          probeAfter: now,
          probeOwner: null,
        });
        this.telemetry.info({
          event: 'provider_circuit_probe_released',
          metric: 'provider_circuit_probe_total',
          provider: model.provider,
          model_version: model.version,
          scope_type: row.scopeType,
          reason_code: 'not_dispatched_before_provider_call',
        });
      }
    });
  }

  recordTerminalEvidenceInTransaction(
    transaction: Transaction,
    model: RuntimeCircuitModel,
    evidence: ProviderTerminalEvidence,
  ): Promise<void> {
    this.assertWritesAllowed();
    return this.recordClassification(
      transaction,
      model,
      classifyTerminalEvidence(evidence),
      undefined,
    );
  }

  private async recordClassification(
    transaction: Transaction,
    model: RuntimeCircuitModel,
    classification: CircuitClassification,
    permit: CircuitPermit | void,
  ): Promise<void> {
    await transaction.insert(providerCircuitStates).values(scopeRows(model)).onConflictDoNothing();
    const rows = await transaction
      .select()
      .from(providerCircuitStates)
      .where(
        inArray(
          providerCircuitStates.scopeKey,
          scopeRows(model).map((row) => row.scopeKey),
        ),
      )
      .orderBy(asc(providerCircuitStates.scopeKey))
      .for('update');
    for (const row of rows) {
      if (permit?.probeToken) {
        if (row.status !== 'half_open' || row.probeOwner !== permit.probeToken) continue;
        if (classification.success) {
          await this.updateWithRevision(transaction, row, {
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
          this.telemetry.info({
            event: 'provider_circuit_closed',
            metric: 'provider_circuit_state_total',
            provider: model.provider,
            model_version: model.version,
            scope_type: row.scopeType,
            state: 'closed',
            reason_code: 'probe_succeeded',
          });
        } else {
          await this.openWithRevision(
            transaction,
            row,
            model,
            classification.immediateReason ?? 'half_open_probe_failed',
          );
        }
        continue;
      }
      if (row.status !== 'closed') continue;
      if (classification.sample === 0) continue;
      const sampleCount = row.sampleCount + classification.sample;
      const failureCount = row.failureCount + classification.failure;
      const unknownCount = row.unknownCount + classification.unknown;
      const thresholdReason = evaluateCircuitWindow({
        sampleCount,
        failureCount,
        unknownCount,
        model,
      });
      const reason = classification.immediateReason ?? thresholdReason;
      if (reason) {
        await this.openWithRevision(transaction, row, model, reason, {
          sampleCount,
          failureCount,
          unknownCount,
        });
      } else {
        await this.updateWithRevision(transaction, row, {
          sampleCount,
          failureCount,
          unknownCount,
        });
      }
    }
  }

  private async hourlyBudgetExceeded(
    database: Pick<Database, 'select'>,
    model: RuntimeCircuitModel,
  ): Promise<boolean> {
    const since = new Date(this.now().getTime() - 60 * 60 * 1_000);
    const [exposure] = await database
      .select({ value: count() })
      .from(taskAttempts)
      .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
      .where(
        and(
          eq(tasks.modelId, model.id),
          gte(taskAttempts.startedAt, since),
          or(
            eq(taskAttempts.status, 'dispatching'),
            inArray(taskAttempts.dispatchState, ['accepted', 'outcome_unknown']),
          ),
        ),
      );
    const riskAdjustedUnitCostCny = circuitRiskAdjustedUnitCost(model);
    if (riskAdjustedUnitCostCny === null) return false;
    return hourlyDispatchExposureExceeded({
      count: exposure?.value ?? 0,
      riskAdjustedUnitCostCny,
      hourlyBudgetCny: model.quota.hourly_budget_cny,
    });
  }

  private openWithRevision(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
    row: CircuitRow,
    model: RuntimeCircuitModel,
    reasonCode: string,
    counts?: { sampleCount: number; failureCount: number; unknownCount: number },
  ): Promise<void> {
    const now = this.now();
    const updated = this.updateWithRevision(transaction, row, {
      status: 'open',
      reasonCode,
      openedAt: now,
      probeAfter: new Date(now.getTime() + model.quota.circuit_open_ms),
      probeOwner: null,
      ...counts,
    });
    this.telemetry.info({
      event: 'provider_circuit_opened',
      metric:
        reasonCode === 'hourly_budget'
          ? 'provider_hourly_budget_reject_total'
          : 'provider_circuit_state_total',
      provider: model.provider,
      model_version: model.version,
      scope_type: row.scopeType,
      state: 'open',
      reason_code: reasonCode,
    });
    return updated;
  }

  async updateWithRevision(
    transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
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
    if (updated) return;
    const current = await transaction.query.providerCircuitStates.findFirst({
      where: eq(providerCircuitStates.id, row.id),
      columns: { revision: true, status: true },
    });
    throw new ProviderCircuitOpenError(
      current ? `revision_conflict:${current.status}:${current.revision}` : 'circuit_state_missing',
    );
  }
}
