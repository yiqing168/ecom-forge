import { randomUUID } from 'node:crypto';

import {
  and,
  asc,
  contentSafetyPreflights,
  eq,
  inArray,
  modelPocRuns,
  models,
  moderationRuntimeStates,
  providerChannels,
  providerCredentialVersions,
  sql,
  type Database,
} from '@ecom-forge/db';
import {
  capabilityContractSchema,
  MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION,
  pricingSnapshotSchema,
  quotaSnapshotSchema,
  type ModerationOutcome,
} from '@ecom-forge/provider';
import { canonicalSha256, normalizeMoney } from '@ecom-forge/shared';
import type { CandidatePlan } from '@ecom-forge/compiler';

import type { ClaimedAgentTurn } from './agent-turn.types.js';

type ModerationCapability = 'moderation.text' | 'moderation.image';
type PreflightRow = typeof contentSafetyPreflights.$inferSelect;

interface ModerationRoute {
  capability: ModerationCapability;
  runtimeRevision: number;
  modelSnapshotId: string;
  credentialVersionId: string;
  policyVersion: string;
  reservedCostCny: string | null;
  actualCostCny: string | null;
}

interface PlannedCheck {
  capability: ModerationCapability;
  checkNo: number;
  inputDigest: string;
  operationKey: string;
  providerInput: { text: string } | { asset_id: string };
  route: ModerationRoute;
}

export interface ModerationDispatchInput {
  claimed: ClaimedAgentTurn;
  check: PreflightRow;
  providerInput: PlannedCheck['providerInput'];
  markPotentiallyDispatched(): Promise<boolean>;
}

export type ModerationDispatcher = (
  input: ModerationDispatchInput,
) => Promise<ModerationOutcome | { decision: 'not_dispatched' }>;

export type ContentSafetyPreflightResult =
  | { status: 'passed'; evidenceDigest: string }
  | { status: 'blocked'; reasonCodes: string[] }
  | { status: 'outcome_unknown' }
  | { status: 'not_dispatched' }
  | { status: 'pending'; retryAt?: Date };

export class ContentSafetyPreflightService {
  constructor(
    private readonly database: Database,
    private readonly dispatch: ModerationDispatcher,
    private readonly leaseMs: number,
    private readonly appEnv: 'local' | 'test' | 'staging' | 'beta' | 'production',
  ) {}

  async execute(
    claimed: ClaimedAgentTurn,
    candidate: CandidatePlan,
  ): Promise<ContentSafetyPreflightResult> {
    const checks = await this.planChecks(claimed, candidate);
    await this.ensureChecks(claimed, checks);

    for (const planned of checks) {
      const current = await this.readCheck(claimed, planned);
      if (current.status === 'passed') continue;
      if (current.status === 'blocked') return blockedResult(current);
      if (current.status === 'outcome_unknown') return { status: 'outcome_unknown' };

      const claimedCheck = await this.claimCheck(current);
      if (!claimedCheck) {
        return {
          status: 'pending',
          ...(current.processingLeaseExpiresAt
            ? { retryAt: current.processingLeaseExpiresAt }
            : {}),
        };
      }
      if (claimedCheck.status === 'passed') continue;
      if (claimedCheck.status === 'blocked') return blockedResult(claimedCheck);
      if (claimedCheck.status === 'outcome_unknown') return { status: 'outcome_unknown' };

      let outcome: Awaited<ReturnType<ModerationDispatcher>>;
      try {
        outcome = await this.dispatch({
          claimed,
          check: claimedCheck,
          providerInput: planned.providerInput,
          markPotentiallyDispatched: () => this.markPotentiallyDispatched(claimedCheck),
        });
      } catch {
        outcome = { decision: 'not_dispatched' };
      }
      if (outcome.decision === 'not_dispatched') {
        if (await this.releaseNotDispatched(claimedCheck)) return { status: 'not_dispatched' };
        // A dispatcher can throw after the durable possibly-sent marker. Never retry it as unsent.
        return { status: 'pending' };
      }
      outcome = enforceModerationPolicy(outcome, planned.route.policyVersion);
      const completed = await this.completeCheck(
        claimedCheck,
        outcome,
        planned.route.actualCostCny,
      );
      if (!completed) return { status: 'pending' };
      if (completed.status === 'blocked') return blockedResult(completed);
      if (completed.status === 'outcome_unknown') return { status: 'outcome_unknown' };
    }

    const rows = await this.readAll(claimed);
    if (rows.length !== checks.length || rows.some((row) => row.status !== 'passed')) {
      return { status: 'pending' };
    }
    return {
      status: 'passed',
      evidenceDigest: canonicalSha256(
        rows.map((row) => ({
          operation_key: row.operationKey,
          input_digest: row.inputDigest,
          model_snapshot_id: row.modelSnapshotId,
          runtime_revision: row.runtimeRevision,
          evidence: row.evidenceSummaryJson,
        })),
      ),
    };
  }

  private async planChecks(
    claimed: ClaimedAgentTurn,
    candidate: CandidatePlan,
  ): Promise<PlannedCheck[]> {
    const imageBindings = selectedImageBindings(claimed, candidate);
    const needsImageChecks = imageBindings.length > 0;
    const [textRoute, imageRoute] = await Promise.all([
      this.resolveRoute('moderation.text'),
      needsImageChecks ? this.resolveRoute('moderation.image') : Promise.resolve(undefined),
    ]);
    const candidateDigest = canonicalSha256(candidate);
    const textDigest = canonicalSha256({
      message_digest: canonicalSha256(claimed.message),
      candidate_digest: candidateDigest,
    });
    const textCheck = this.plannedCheck(claimed, textRoute, 0, textDigest, {
      text: moderationText(claimed.message, candidate),
    });
    const imageChecks = imageBindings.map((binding, index) => {
      if (!imageRoute) throw new Error('CONTENT_SAFETY_IMAGE_ROUTE_MISSING');
      const inputDigest = canonicalSha256({
        binding_key: binding.binding_key,
        kind: binding.kind,
        object_id: binding.object_id,
        object_version: binding.object_version,
        content_hash: binding.content_hash,
      });
      return this.plannedCheck(claimed, imageRoute, index, inputDigest, {
        asset_id: binding.object_id,
      });
    });
    return [textCheck, ...imageChecks];
  }

  private plannedCheck(
    claimed: ClaimedAgentTurn,
    route: ModerationRoute,
    checkNo: number,
    inputDigest: string,
    providerInput: PlannedCheck['providerInput'],
  ): PlannedCheck {
    return {
      capability: route.capability,
      checkNo,
      inputDigest,
      operationKey: canonicalSha256({
        turn_id: claimed.turnId,
        continuation_no: claimed.continuationNo,
        capability: route.capability,
        check_no: checkNo,
        input_digest: inputDigest,
        model_snapshot_id: route.modelSnapshotId,
        credential_version_id: route.credentialVersionId,
        runtime_revision: route.runtimeRevision,
        policy_version: route.policyVersion,
      }),
      providerInput,
      route,
    };
  }

  private async resolveRoute(capability: ModerationCapability): Promise<ModerationRoute> {
    return this.database.transaction(async (transaction) => {
      const [runtime] = await transaction
        .select()
        .from(moderationRuntimeStates)
        .where(eq(moderationRuntimeStates.capability, capability))
        .for('share');
      if (!runtime?.activeModelSnapshotId) throw new Error('CONTENT_SAFETY_UNAVAILABLE');
      const model = await transaction.query.models.findFirst({
        where: eq(models.id, runtime.activeModelSnapshotId),
      });
      const contract = capabilityContractSchema.safeParse(model?.capabilityContractJson);
      const pricing = pricingSnapshotSchema.safeParse(model?.pricingJson);
      const quota = quotaSnapshotSchema.safeParse(model?.quotaJson);
      const realProtocol =
        model?.provider === 'openai' &&
        model.protocolFamily === 'openai' &&
        model.apiVariant === 'openai_responses';
      const allowedFake =
        model?.provider === 'fake' &&
        model.protocolFamily === null &&
        model.apiVariant === null &&
        (this.appEnv === 'local' || this.appEnv === 'test');
      if (
        !model ||
        !contract.success ||
        !pricing.success ||
        !quota.success ||
        model.status !== 'poc_passed' ||
        !model.statusEvidenceDigest ||
        !model.providerChannelId ||
        !contract.data.capabilities.includes(capability) ||
        contract.data.capabilities.some(
          (item) => item !== 'moderation.text' && item !== 'moderation.image',
        ) ||
        (!realProtocol && !allowedFake)
      ) {
        throw new Error('CONTENT_SAFETY_UNAVAILABLE');
      }
      const channel = await transaction.query.providerChannels.findFirst({
        where: eq(providerChannels.id, model.providerChannelId),
      });
      const credential = channel?.activeCredentialVersionId
        ? await transaction.query.providerCredentialVersions.findFirst({
            where: eq(providerCredentialVersions.id, channel.activeCredentialVersionId),
          })
        : undefined;
      if (
        !channel ||
        !credential ||
        channel.provider !== model.provider ||
        channel.status !== 'active' ||
        credential.providerChannelId !== channel.id ||
        credential.status !== 'active' ||
        !credential.validationEvidenceDigest
      ) {
        throw new Error('CONTENT_SAFETY_UNAVAILABLE');
      }
      const pocRuns = await transaction
        .select({ requestedCapabilities: modelPocRuns.requestedSpecKeysJson })
        .from(modelPocRuns)
        .where(
          and(
            eq(modelPocRuns.modelSnapshotId, model.id),
            eq(modelPocRuns.providerChannelId, channel.id),
            eq(modelPocRuns.credentialVersionId, credential.id),
            inArray(modelPocRuns.probeSuiteVersion, [
              'moderation-poc@1',
              MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION,
            ]),
            eq(modelPocRuns.status, 'passed'),
            eq(modelPocRuns.evidenceDigest, model.statusEvidenceDigest),
          ),
        );
      if (
        !pocRuns.some(
          (run) =>
            Array.isArray(run.requestedCapabilities) &&
            run.requestedCapabilities.includes(capability),
        )
      ) {
        throw new Error('CONTENT_SAFETY_UNAVAILABLE');
      }
      return {
        capability,
        runtimeRevision: runtime.runtimeRevision,
        modelSnapshotId: model.id,
        credentialVersionId: credential.id,
        policyVersion: 'content-safety@1',
        reservedCostCny: null,
        actualCostCny:
          pricing.data.provider_unit_cost_cny === null
            ? null
            : normalizeMoney(pricing.data.provider_unit_cost_cny),
      };
    });
  }

  private async ensureChecks(claimed: ClaimedAgentTurn, checks: PlannedCheck[]): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`preflight:${claimed.turnId}:${claimed.continuationNo}`}, 0))`,
      );
      await transaction
        .insert(contentSafetyPreflights)
        .values(
          checks.map((check) => ({
            turnId: claimed.turnId,
            continuationNo: claimed.continuationNo,
            capability: check.capability,
            checkNo: check.checkNo,
            inputDigest: check.inputDigest,
            modelSnapshotId: check.route.modelSnapshotId,
            credentialVersionId: check.route.credentialVersionId,
            runtimeRevision: check.route.runtimeRevision,
            policyVersion: check.route.policyVersion,
            operationKey: check.operationKey,
            reservedCostCny: check.route.reservedCostCny,
          })),
        )
        .onConflictDoNothing();
      const rows = await transaction
        .select()
        .from(contentSafetyPreflights)
        .where(
          and(
            eq(contentSafetyPreflights.turnId, claimed.turnId),
            eq(contentSafetyPreflights.continuationNo, claimed.continuationNo),
          ),
        );
      if (
        rows.length !== checks.length ||
        checks.some((check) => {
          const row = rows.find(
            (candidate) =>
              candidate.capability === check.capability && candidate.checkNo === check.checkNo,
          );
          return (
            !row ||
            row.operationKey !== check.operationKey ||
            row.inputDigest !== check.inputDigest ||
            row.modelSnapshotId !== check.route.modelSnapshotId ||
            row.credentialVersionId !== check.route.credentialVersionId ||
            row.runtimeRevision !== check.route.runtimeRevision ||
            row.policyVersion !== check.route.policyVersion ||
            (row.reservedCostCny === null) !== (check.route.reservedCostCny === null) ||
            (row.reservedCostCny !== null &&
              normalizeMoney(row.reservedCostCny) !== normalizeMoney(check.route.reservedCostCny!))
          );
        })
      ) {
        throw new Error('CONTENT_SAFETY_PREFLIGHT_CONFLICT');
      }
    });
  }

  private async readCheck(claimed: ClaimedAgentTurn, check: PlannedCheck): Promise<PreflightRow> {
    const row = await this.database.query.contentSafetyPreflights.findFirst({
      where: and(
        eq(contentSafetyPreflights.turnId, claimed.turnId),
        eq(contentSafetyPreflights.continuationNo, claimed.continuationNo),
        eq(contentSafetyPreflights.capability, check.capability),
        eq(contentSafetyPreflights.checkNo, check.checkNo),
      ),
    });
    if (!row || row.operationKey !== check.operationKey) {
      throw new Error('CONTENT_SAFETY_PREFLIGHT_CONFLICT');
    }
    return row;
  }

  private async readAll(claimed: ClaimedAgentTurn): Promise<PreflightRow[]> {
    return this.database
      .select()
      .from(contentSafetyPreflights)
      .where(
        and(
          eq(contentSafetyPreflights.turnId, claimed.turnId),
          eq(contentSafetyPreflights.continuationNo, claimed.continuationNo),
        ),
      )
      .orderBy(asc(contentSafetyPreflights.capability), asc(contentSafetyPreflights.checkNo));
  }

  private async claimCheck(row: PreflightRow): Promise<PreflightRow | null> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(contentSafetyPreflights)
        .where(eq(contentSafetyPreflights.id, row.id))
        .for('update');
      if (!current) return null;
      if (['passed', 'blocked', 'outcome_unknown', 'cancelled'].includes(current.status)) {
        return current;
      }
      const now = new Date();
      if (
        current.status === 'running' &&
        current.processingLeaseExpiresAt &&
        current.processingLeaseExpiresAt > now
      ) {
        return null;
      }
      if (current.status === 'running' && current.dispatchState !== 'not_dispatched') {
        const [unknown] = await transaction
          .update(contentSafetyPreflights)
          .set({
            status: 'outcome_unknown',
            processingOwner: null,
            processingLeaseExpiresAt: null,
            endedAt: now,
            revision: current.revision + 1,
            evidenceSummaryJson: { code: 'CONTENT_SAFETY_DISPATCH_OUTCOME_UNKNOWN' },
          })
          .where(
            and(
              eq(contentSafetyPreflights.id, current.id),
              eq(contentSafetyPreflights.revision, current.revision),
            ),
          )
          .returning();
        return unknown ?? null;
      }
      const owner = randomUUID();
      const [claimed] = await transaction
        .update(contentSafetyPreflights)
        .set({
          status: 'running',
          processingOwner: owner,
          processingLeaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          startedAt: current.startedAt ?? now,
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(contentSafetyPreflights.id, current.id),
            eq(contentSafetyPreflights.revision, current.revision),
          ),
        )
        .returning();
      return claimed ?? null;
    });
  }

  private async markPotentiallyDispatched(row: PreflightRow): Promise<boolean> {
    const [updated] = await this.database
      .update(contentSafetyPreflights)
      .set({ dispatchState: 'outcome_unknown', revision: row.revision + 1 })
      .where(
        and(
          eq(contentSafetyPreflights.id, row.id),
          eq(contentSafetyPreflights.revision, row.revision),
          eq(contentSafetyPreflights.status, 'running'),
          eq(contentSafetyPreflights.dispatchState, 'not_dispatched'),
          eq(contentSafetyPreflights.processingOwner, row.processingOwner!),
        ),
      )
      .returning({ id: contentSafetyPreflights.id });
    return Boolean(updated);
  }

  private async releaseNotDispatched(row: PreflightRow): Promise<boolean> {
    const [released] = await this.database
      .update(contentSafetyPreflights)
      .set({
        status: 'queued',
        processingOwner: null,
        processingLeaseExpiresAt: null,
        revision: row.revision + 1,
      })
      .where(
        and(
          eq(contentSafetyPreflights.id, row.id),
          eq(contentSafetyPreflights.revision, row.revision),
          eq(contentSafetyPreflights.status, 'running'),
          eq(contentSafetyPreflights.dispatchState, 'not_dispatched'),
          eq(contentSafetyPreflights.processingOwner, row.processingOwner!),
        ),
      )
      .returning({ id: contentSafetyPreflights.id });
    return Boolean(released);
  }

  private async completeCheck(
    row: PreflightRow,
    outcome: ModerationOutcome,
    actualCostCny: string | null,
  ): Promise<PreflightRow | null> {
    const revision = row.revision + 1;
    const status =
      outcome.decision === 'pass'
        ? 'passed'
        : outcome.decision === 'blocked'
          ? 'blocked'
          : 'outcome_unknown';
    const [updated] = await this.database
      .update(contentSafetyPreflights)
      .set({
        status,
        dispatchState: outcome.decision === 'unknown' ? 'outcome_unknown' : 'accepted',
        actualCostCny:
          outcome.decision === 'unknown' || actualCostCny === null
            ? null
            : normalizeMoney(actualCostCny),
        evidenceSummaryJson:
          outcome.decision === 'unknown'
            ? { policy_version: outcome.policy_version, error_code: outcome.error_code }
            : {
                policy_version: outcome.policy_version,
                confidence: outcome.confidence,
                ...(outcome.decision === 'blocked'
                  ? { reason_codes: [...outcome.reason_codes].sort() }
                  : {}),
              },
        processingOwner: null,
        processingLeaseExpiresAt: null,
        endedAt: new Date(),
        revision: revision + 1,
      })
      .where(
        and(
          eq(contentSafetyPreflights.id, row.id),
          eq(contentSafetyPreflights.revision, revision),
          eq(contentSafetyPreflights.status, 'running'),
          eq(contentSafetyPreflights.dispatchState, 'outcome_unknown'),
          eq(contentSafetyPreflights.processingOwner, row.processingOwner!),
        ),
      )
      .returning();
    return updated ?? null;
  }
}

export function selectedImageBindings(claimed: ClaimedAgentTurn, candidate: CandidatePlan) {
  const selectedBindingKeys = new Set(candidate.nodes.flatMap((node) => node.input_bindings));
  return [...claimed.attachments, ...(claimed.sessionImageCandidates ?? [])].filter((binding) =>
    selectedBindingKeys.has(binding.binding_key),
  );
}

export function enforceModerationPolicy(
  outcome: ModerationOutcome,
  expectedPolicyVersion: string,
): ModerationOutcome {
  if (outcome.policy_version === expectedPolicyVersion) return outcome;
  return {
    decision: 'unknown',
    policy_version: expectedPolicyVersion,
    error_code: 'provider_internal_error',
  };
}

function moderationText(message: string, candidate: CandidatePlan): string {
  const goalSummaries = candidate.nodes.flatMap((node) => {
    const value = node.params.goal_summary;
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  });
  const creativePrompts = candidate.nodes.flatMap((node) => {
    const value = node.params.creative_prompt;
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  });
  const creativeNotes = candidate.nodes.flatMap((node) => {
    const value = node.params.creative_note;
    return typeof value === 'string' && value.trim() ? [value.trim()] : [];
  });
  return [message, ...goalSummaries, ...creativePrompts, ...creativeNotes].join('\n');
}

function blockedResult(row: PreflightRow): ContentSafetyPreflightResult {
  const evidence =
    row.evidenceSummaryJson && typeof row.evidenceSummaryJson === 'object'
      ? (row.evidenceSummaryJson as Record<string, unknown>)
      : {};
  const reasonCodes = Array.isArray(evidence.reason_codes)
    ? evidence.reason_codes.filter((value): value is string => typeof value === 'string')
    : [];
  return { status: 'blocked', reasonCodes };
}
