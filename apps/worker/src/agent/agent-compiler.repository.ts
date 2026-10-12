import {
  agentTraces,
  agentTurns,
  agentTranscriptItems,
  and,
  eq,
  inArray,
  models,
  providerCircuitStates,
  productFactSets,
  products,
  runQuotes,
  skillCatalogReleases,
  skillCatalogState,
  skillPackages,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
  type Database,
} from '@ecom-forge/db';
import { compositeJobId, createQueueIntentWithQuery } from '@ecom-forge/queue';
import {
  canonicalSha256,
  type AgentPublicSummary,
  type AgentPublicErrorCode,
} from '@ecom-forge/shared';
import type { CompiledPlan, CompilerRejection } from '@ecom-forge/compiler';
import {
  capabilityContractSchema,
  mediaRateCardV2Schema,
  mediaV2CapabilityContractSchema,
  pricingSnapshotSchema,
  quotaSnapshotSchema,
} from '@ecom-forge/provider';
import { resolveBuiltinSkill, type SkillSelectionSnapshot } from '@ecom-forge/skills';

import { appendOutboxEventWithQuery } from '../database/outbox.repository.js';
import { appendTraceStepWithQuery } from './agent-turn.repository-helpers.js';
import type { AgentWriteQuery, ClaimedAgentTurn } from './agent-turn.types.js';
import { recordModelStepDiagnostic } from './agent-model-step-diagnostic.js';
import {
  appendNativeTerminalReceipt,
  readNativeCandidatePlan,
  withNativeTurnWrite,
} from './agent-transcript-results.js';
import { resolveSessionCreativeDirection } from './session-creative-direction.js';
import { createNativeTranscriptReader } from './agent-transcript-native-reader.js';
import { AgentTranscriptWriteError } from './agent-transcript-write-transaction.js';

export class AgentCompilerRepository {
  constructor(private readonly database: Database) {}

  async persistCompiled(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    compiled: CompiledPlan;
  }): Promise<{ eventSeq: number; quoteId: string } | null> {
    // A completed native turn replays from its source-bound compiler receipt.
    const replay =
      input.claimed.transcriptCaptureVersion === 1 ? await this.readCompiledReceipt(input) : null;
    if (replay) return replay;
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      if (
        turn.executionAuthorizationHash !== input.claimed.executionAuthorizationHash ||
        turn.skillSelectionSnapshotHash !== input.claimed.selectionHash
      ) {
        throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
      }
      await assertCompiledContextCurrent(scope.query, turn, input.compiled);
      await resolveSessionCreativeDirection(
        scope,
        input.claimed,
        (await readNativeCandidatePlan(scope, input.llmStepId)) ?? input.claimed.authoringPlan,
        input.llmStepId,
      );
      const expiresAt = new Date(input.compiled.quote_draft.expires_at);
      const quoteIdempotencyKey = `agent-quote:${turn.id}:${turn.continuationNo}:${input.compiled.plan_digest}`;
      const [quote] = await scope.query((transaction) =>
        transaction
          .insert(runQuotes)
          .values({
            userId: turn.userId,
            source: 'chat',
            sourceId: turn.id,
            status: 'quoted',
            promptPreview: input.compiled.snapshots.prompt,
            itemsSnapshot: input.compiled.quote_draft.items,
            estimatedCallCount: input.compiled.canonical_plan.tasks.length,
            estimatedTotalCredits: input.compiled.quote_draft.estimated_total_credits,
            hasUnknownPrice: false,
            idempotencyKey: quoteIdempotencyKey,
            inputSignature: input.compiled.input_signature,
            submissionMode: input.compiled.quote_draft.submission_mode,
            planDigest: input.compiled.plan_digest,
            authorizationDigest: input.compiled.snapshots.execution_authorization_digest,
            confirmationSnapshot: {},
            planSnapshot: {
              schema_version: 1,
              plan_digest: input.compiled.plan_digest,
              canonical_plan: input.compiled.canonical_plan,
              items: input.compiled.canonical_plan.tasks.map((task) => ({
                taskKey: task.task_key,
                taskType: task.capability,
                estimatedCredits: task.cost.estimated_credits,
                paramsSnapshot: {
                  ...task.params_snapshot,
                  model_snapshot: task.model_snapshot,
                  input_bindings: task.input_bindings,
                  operation_key: task.operation_key,
                  depends_on: task.depends_on,
                  ...(input.compiled.snapshots.model_selection
                    ? { model_selection: input.compiled.snapshots.model_selection }
                    : {}),
                },
              })),
            },
            skillSnapshot: input.compiled.snapshots.skill,
            pricingSnapshot: input.compiled.canonical_plan.tasks.map((task) => ({
              task_key: task.task_key,
              model_snapshot: task.model_snapshot,
              cost: task.cost,
            })),
            expiresAt,
          })
          .onConflictDoNothing()
          .returning({ id: runQuotes.id }),
      );
      if (!quote) throw new Error('AGENT_QUOTE_CONCURRENT_CONFLICT');
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'succeeded', {
        type: 'quote_created',
        quote_id: quote.id,
        plan_digest: input.compiled.plan_digest,
      });
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: {
            outputSummary: {
              outcome: 'candidate_plan',
              compiler_result: 'compiled',
              plan_digest: input.compiled.plan_digest,
            },
          },
        }),
      );
      await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'compiler_check',
        actor: 'compiler',
        inputSummary: {
          candidate_digest: canonicalSha256(input.compiled.input_signature),
          continuation_no: turn.continuationNo,
        },
        outputSummary: {
          result: 'compiled',
          quote_id: quote.id,
          plan_digest: input.compiled.plan_digest,
          submission_mode: input.compiled.quote_draft.submission_mode,
        },
        status: 'succeeded',
      });
      await createQueueIntentWithQuery(scope.query, {
        queueName: 'agent',
        jobId: compositeJobId({ job_type: 'agent.quote.expire', quote_id: quote.id }),
        aggregateType: 'run_quote',
        aggregateId: quote.id,
        payloadVersion: 1,
        payload: {
          schema_version: 1,
          job_type: 'agent.quote.expire',
          trace_id: input.claimed.traceId,
          turn_id: turn.id,
          quote_id: quote.id,
          continuation_no: turn.continuationNo,
          plan_digest: input.compiled.plan_digest,
        },
        nextAttemptAt: expiresAt,
      });
      await createQueueIntentWithQuery(scope.query, {
        queueName: 'agent',
        jobId: compositeJobId({
          job_type: 'agent.quote.submit',
          turn_id: turn.id,
          continuation_no: turn.continuationNo,
          plan_digest: input.compiled.plan_digest,
          authorization_digest: input.compiled.snapshots.execution_authorization_digest,
        }),
        aggregateType: 'run_quote',
        aggregateId: quote.id,
        payloadVersion: 1,
        payload: {
          schema_version: 1,
          job_type: 'agent.quote.submit',
          trace_id: input.claimed.traceId,
          turn_id: turn.id,
          quote_id: quote.id,
          continuation_no: turn.continuationNo,
          plan_digest: input.compiled.plan_digest,
          authorization_digest: input.compiled.snapshots.execution_authorization_digest,
        },
      });
      const statusEvent = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          previous_user_status: 'thinking',
          user_status: 'thinking',
        },
      });
      const eventSeq = statusEvent.eventSeq;
      const [updated] = await scope.query((transaction) =>
        transaction
          .update(agentTurns)
          .set({
            runQuoteId: quote.id,
            status: 'run_quote_created',
            revision: turn.revision + 1,
            processingOwner: null,
            processingLeaseExpiresAt: null,
          })
          .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
          .returning({ id: agentTurns.id }),
      );
      if (!updated) throw new Error('AGENT_QUOTE_TURN_CAS_FAILED');
      return { eventSeq, quoteId: quote.id };
    }).catch(async (error: unknown) => {
      if (error instanceof AgentTranscriptWriteError && error.reason === 'turn_stale') {
        return this.readCompiledReceipt(input);
      }
      throw error;
    });
  }

  async persistRejected(input: {
    claimed: ClaimedAgentTurn;
    revision: number;
    llmStepId: string;
    rejection: CompilerRejection;
  }): Promise<{ eventSeq: number } | null> {
    return withNativeTurnWrite(this.database, input, async (scope, turn) => {
      await appendNativeTerminalReceipt(scope, input.llmStepId, 'rejected', {
        public_error_code: compilerPublicCode(input.rejection),
      });
      await scope.query((transaction) =>
        recordModelStepDiagnostic(transaction, {
          ...input,
          transcriptCaptureVersion: turn.transcriptCaptureVersion,
          update: {
            status: 'blocked',
            errorCode: compilerPublicCode(input.rejection),
            outputSummary: { outcome: 'candidate_plan', compiler_result: 'rejected' },
          },
        }),
      );
      await appendTraceStepWithQuery(scope.query, input.claimed.traceId, {
        stepType: 'compiler_check',
        actor: 'compiler',
        inputSummary: { continuation_no: turn.continuationNo },
        outputSummary: {
          result: 'rejected',
          code: input.rejection.code,
          safe_action: input.rejection.safe_action,
          details: input.rejection.details,
        },
        status: 'blocked',
        errorCode: compilerPublicCode(input.rejection),
      });
      await scope.query((transaction) =>
        transaction
          .update(agentTraces)
          .set({ status: 'blocked', loopGuardrailHit: input.rejection.code, endedAt: new Date() })
          .where(eq(agentTraces.id, input.claimed.traceId)),
      );
      const event = await appendOutboxEventWithQuery(scope.query, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.failed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: input.claimed.traceId,
          public_error_code: compilerPublicCode(input.rejection),
          summary: compilerPublicSummary(input.rejection),
          user_status: 'failed',
        },
      });
      const [updated] = await scope.query((transaction) =>
        transaction
          .update(agentTurns)
          .set({
            status: 'blocked',
            revision: turn.revision + 1,
            processingOwner: null,
            processingLeaseExpiresAt: null,
            endedAt: new Date(),
          })
          .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
          .returning({ id: agentTurns.id }),
      );
      if (!updated) throw new Error('AGENT_COMPILER_REJECTION_CAS_FAILED');
      return { eventSeq: event.eventSeq };
    });
  }

  private async readCompiledReceipt(input: {
    claimed: ClaimedAgentTurn;
    compiled: CompiledPlan;
    llmStepId: string;
  }) {
    const current = await this.database.query.agentTurns.findFirst({
      where: and(
        eq(agentTurns.id, input.claimed.turnId),
        eq(agentTurns.userId, input.claimed.userId),
        eq(agentTurns.sessionId, input.claimed.sessionId),
      ),
    });
    if (!current?.runQuoteId) return null;
    if (
      current.executionFormat !== 'transcript_v1' ||
      current.continuationNo !== input.claimed.continuationNo ||
      current.skillSelectionSnapshotHash !== input.claimed.selectionHash ||
      current.executionAuthorizationHash !== input.claimed.executionAuthorizationHash
    )
      throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
    const quote = await this.database.query.runQuotes.findFirst({
      where: and(
        eq(runQuotes.id, current.runQuoteId),
        eq(runQuotes.userId, input.claimed.userId),
        eq(runQuotes.sourceId, current.id),
      ),
    });
    if (!quote || quote.planDigest !== input.compiled.plan_digest)
      throw new Error('AGENT_COMPILER_DIGEST_CONFLICT');
    const parent = await this.database.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, current.userId),
        eq(agentTranscriptItems.sessionId, current.sessionId),
        eq(agentTranscriptItems.turnId, current.id),
        eq(agentTranscriptItems.sourceKey, `model:${input.llmStepId}:output`),
      ),
      columns: { id: true },
    });
    if (!parent) throw new Error('AGENT_COMPILER_TRANSCRIPT_MISSING');
    const result = await this.database.query.agentTranscriptItems.findFirst({
      where: and(
        eq(agentTranscriptItems.userId, current.userId),
        eq(agentTranscriptItems.sessionId, current.sessionId),
        eq(agentTranscriptItems.sourceKey, `assistant:${parent.id}:result:0`),
      ),
      columns: { id: true },
    });
    if (!result) throw new Error('AGENT_COMPILER_TRANSCRIPT_MISSING');
    const verified = await createNativeTranscriptReader(this.database).readItem({
      userId: current.userId,
      sessionId: current.sessionId,
      itemId: result.id,
    });
    const payload = verified.item.payload_json;
    if (
      payload.type !== 'tool_result' ||
      payload.status !== 'succeeded' ||
      payload.result.type !== 'inline' ||
      canonicalSha256(payload.result.value) !==
        canonicalSha256({
          type: 'quote_created',
          quote_id: quote.id,
          plan_digest: input.compiled.plan_digest,
        })
    )
      throw new Error('AGENT_COMPILER_TRANSCRIPT_CONFLICT');
    return { eventSeq: 0, quoteId: quote.id };
  }
}

async function assertCompiledContextCurrent(
  query: AgentWriteQuery,
  turn: typeof agentTurns.$inferSelect,
  compiled: CompiledPlan,
): Promise<void> {
  const selection = turn.skillSelectionSnapshotJson as SkillSelectionSnapshot;
  const builtin = await resolveBuiltinSkill(selection.primary_skill_id);
  if (builtin) {
    const resourceDigests = await builtinSelectionResourceDigests(selection);
    if (
      compiled.snapshots.skill.definition_digest !== builtin.definitionHash ||
      compiled.snapshots.skill.package_digest !== builtin.packageDigest ||
      compiled.snapshots.skill.release_digest !== builtin.releaseDigest ||
      canonicalSha256([...compiled.snapshots.skill.resource_digests].sort()) !==
        canonicalSha256([...resourceDigests].sort())
    ) {
      throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
    }
  } else {
    const [catalogState] = await query((transaction) =>
      transaction
        .select()
        .from(skillCatalogState)
        .where(eq(skillCatalogState.id, 'global'))
        .for('update'),
    );
    const [release] = await query((transaction) =>
      transaction
        .select()
        .from(skillCatalogReleases)
        .where(eq(skillCatalogReleases.id, selection.catalog_release_id))
        .for('share'),
    );
    const [packageRow] = await query((transaction) =>
      transaction
        .select()
        .from(skillPackages)
        .where(eq(skillPackages.id, selection.primary_package_record_id))
        .for('share'),
    );
    const [skill] = await query((transaction) =>
      transaction
        .select()
        .from(skills)
        .where(eq(skills.id, selection.primary_skill_id))
        .for('share'),
    );
    const reportId = packageRow?.approvedValidationReportId;
    const [validationReport] = reportId
      ? await query((transaction) =>
          transaction
            .select()
            .from(skillPackageValidationReports)
            .where(eq(skillPackageValidationReports.id, reportId))
            .for('share'),
        )
      : [];
    if (
      !catalogState ||
      catalogState.activeReleaseId !== release?.id ||
      release.status !== 'published' ||
      release.releaseDigest !== compiled.snapshots.skill.release_digest ||
      !packageRow ||
      packageRow.status !== 'approved' ||
      packageRow.riskStatus !== 'clear' ||
      packageRow.disabledAt ||
      packageRow.packageDigest !== compiled.snapshots.skill.package_digest ||
      !skill ||
      skill.status !== 'published' ||
      skill.packageRecordId !== packageRow.id ||
      skill.definitionHash !== compiled.snapshots.skill.definition_digest ||
      !validationReport ||
      validationReport.status !== 'passed' ||
      validationReport.packageRecordId !== packageRow.id ||
      validationReport.packageDigest !== packageRow.packageDigest
    ) {
      throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
    }
    const resourceIds = selectionResourceIds(selection);
    const resources =
      resourceIds.length === 0
        ? []
        : await query((transaction) =>
            transaction
              .select()
              .from(skillResourceSnapshots)
              .where(inArray(skillResourceSnapshots.id, resourceIds))
              .for('share'),
          );
    const resourceDigests = resources.map((resource) => resource.contentHash).sort();
    if (
      resources.length !== resourceIds.length ||
      canonicalSha256(resourceDigests) !==
        canonicalSha256([...compiled.snapshots.skill.resource_digests].sort())
    ) {
      throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
    }
  }
  if (compiled.snapshots.product_facts) {
    const snapshot = compiled.snapshots.product_facts;
    const [product] = await query((transaction) =>
      transaction.select().from(products).where(eq(products.id, snapshot.product_id)).for('share'),
    );
    const [factSet] = await query((transaction) =>
      transaction
        .select()
        .from(productFactSets)
        .where(eq(productFactSets.id, snapshot.fact_set_id))
        .for('share'),
    );
    if (
      !product ||
      product.userId !== turn.userId ||
      product.status !== 'active' ||
      product.latestFactSetId !== snapshot.fact_set_id ||
      !factSet ||
      factSet.userId !== turn.userId ||
      factSet.productId !== product.id ||
      factSet.versionNo !== snapshot.fact_set_version ||
      factSet.sourceAssetId !== snapshot.source_asset_id ||
      factSet.sourceVersion !== snapshot.source_version ||
      canonicalSha256(factSet.factsJson) !== canonicalSha256(snapshot.facts)
    ) {
      throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
    }
  }
  const expectedModels = new Map(
    compiled.canonical_plan.tasks.map((task) => [task.model_snapshot.id, task.model_snapshot]),
  );
  const modelIds = [...expectedModels.keys()].sort();
  const modelRows = await query((transaction) =>
    transaction
      .select()
      .from(models)
      .where(inArray(models.id, modelIds))
      .orderBy(models.id)
      .for('share'),
  );
  if (modelRows.length !== modelIds.length) throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
  for (const row of modelRows) {
    const expected = expectedModels.get(row.id);
    if (!compiledModelSnapshotMatches(row, expected)) {
      throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
    }
  }
  const circuitScopes = [
    ...new Map(
      modelRows.map((row) => [
        `provider:${row.provider}`,
        {
          scopeType: 'provider' as const,
          scopeKey: `provider:${row.provider}`,
          provider: row.provider,
          modelId: null,
        },
      ]),
    ).values(),
    ...modelRows.map((row) => ({
      scopeType: 'model' as const,
      scopeKey: `model:${row.id}`,
      provider: row.provider,
      modelId: row.id,
    })),
  ].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  await query((transaction) =>
    transaction.insert(providerCircuitStates).values(circuitScopes).onConflictDoNothing(),
  );
  const circuitRows = await query((transaction) =>
    transaction
      .select()
      .from(providerCircuitStates)
      .where(
        inArray(
          providerCircuitStates.scopeKey,
          circuitScopes.map((scope) => scope.scopeKey),
        ),
      )
      .orderBy(providerCircuitStates.scopeKey)
      .for('update'),
  );
  if (
    circuitRows.length !== circuitScopes.length ||
    circuitRows.some((row) => row.status !== 'closed' || row.reasonCode === 'hourly_budget')
  ) {
    throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
  }
}

async function builtinSelectionResourceDigests(
  selection: SkillSelectionSnapshot,
): Promise<string[]> {
  const entries: Array<[string, string]> = [
    [selection.primary_skill_id, selection.primary_planning_resource.resource_path],
    ...selection.primary_reference_resources.map(
      (resource) => [selection.primary_skill_id, resource.resource_path] as [string, string],
    ),
    ...selection.preset_selections.map(
      (preset) => [selection.primary_skill_id, preset.resource_path] as [string, string],
    ),
    ...[...selection.required_auxiliary, ...selection.optional_auxiliary].flatMap((auxiliary) => [
      [auxiliary.skill_id, auxiliary.planning_resource.resource_path] as [string, string],
      ...auxiliary.reference_resources.map(
        (resource) => [auxiliary.skill_id, resource.resource_path] as [string, string],
      ),
    ]),
  ];
  const digests: string[] = [];
  for (const [skillId, resourcePath] of entries) {
    const skill = await resolveBuiltinSkill(skillId);
    const resource = skill?.resources.get(resourcePath);
    if (!resource) throw new Error('AGENT_COMPILER_CONTEXT_DRIFT');
    digests.push(resource.resource_hash);
  }
  return digests;
}

type PersistedModelSnapshot = Pick<
  typeof models.$inferSelect,
  | 'id'
  | 'providerChannelId'
  | 'provider'
  | 'modelId'
  | 'version'
  | 'status'
  | 'statusEvidenceDigest'
  | 'capabilityContractJson'
  | 'pricingJson'
  | 'quotaJson'
>;
type ExpectedModelSnapshot = CompiledPlan['canonical_plan']['tasks'][number]['model_snapshot'];

export function compiledModelSnapshotMatches(
  row: PersistedModelSnapshot,
  expected: ExpectedModelSnapshot | undefined,
): boolean {
  const quota = quotaSnapshotSchema.safeParse(row.quotaJson);
  if (
    !expected ||
    row.id !== expected.id ||
    row.status !== 'poc_passed' ||
    row.statusEvidenceDigest !== expected.status_evidence_digest ||
    row.provider !== expected.provider ||
    row.modelId !== expected.model_id ||
    row.version !== expected.version ||
    !quota.success ||
    canonicalSha256(quota.data) !== expected.quota_digest
  ) {
    return false;
  }

  const mediaCapability = mediaV2CapabilityContractSchema.safeParse(row.capabilityContractJson);
  const mediaPricing = mediaRateCardV2Schema.safeParse(row.pricingJson);
  if (mediaCapability.success || mediaPricing.success) {
    return (
      mediaCapability.success &&
      mediaPricing.success &&
      'provider_channel_id' in expected &&
      row.providerChannelId === expected.provider_channel_id &&
      canonicalSha256(mediaCapability.data) === expected.capability_contract_digest &&
      canonicalSha256(mediaPricing.data) === expected.pricing_digest
    );
  }

  const capability = capabilityContractSchema.safeParse(row.capabilityContractJson);
  const pricing = pricingSnapshotSchema.safeParse(row.pricingJson);
  return (
    !('provider_channel_id' in expected) &&
    capability.success &&
    pricing.success &&
    canonicalSha256(capability.data) === expected.capability_contract_digest &&
    canonicalSha256(pricing.data) === expected.pricing_digest
  );
}

function selectionResourceIds(selection: SkillSelectionSnapshot): string[] {
  return [
    selection.primary_planning_resource,
    ...selection.primary_reference_resources,
    ...selection.preset_selections.map((preset) => ({
      resource_snapshot_id: preset.resource_snapshot_id,
    })),
    ...[...selection.required_auxiliary, ...selection.optional_auxiliary].flatMap((auxiliary) => [
      auxiliary.planning_resource,
      ...auxiliary.reference_resources,
    ]),
  ]
    .map((resource) => resource.resource_snapshot_id)
    .sort();
}

function compilerPublicCode(rejection: CompilerRejection): AgentPublicErrorCode {
  if (rejection.code === 'reference_unavailable') return 'REFERENCE_NOT_AVAILABLE';
  if (rejection.code === 'mutation_forbidden') return 'AGENT_TOOL_NOT_ALLOWED';
  if (rejection.code === 'skill_version_drift') return 'SKILL_VERSION_DRIFT';
  if (rejection.code === 'clarification_required') return 'AGENT_CONTEXT_UNAVAILABLE';
  if (rejection.code === 'model_not_approved') return 'AGENT_MODEL_UNAVAILABLE';
  if (rejection.code === 'cost_unavailable') return 'COST_MODEL_UNAVAILABLE';
  return 'AGENT_COMPILER_UNAVAILABLE';
}

export function compilerPublicSummary(rejection: CompilerRejection): AgentPublicSummary {
  if (rejection.details.some((detail) => detail.rule_id === 'cross_upload_group_scope_declined'))
    return '已选择只处理最近上传的照片，本次计划仍包含其他上传组；请重新说明要处理的照片';
  if (rejection.code === 'reference_unavailable') return '引用内容当前不可用，请移除后重试';
  if (rejection.code === 'mutation_forbidden') return '当前状态不允许使用该能力';
  if (rejection.code === 'skill_version_drift') return '所选 Skill 已更新，请刷新后重新选择';
  if (rejection.code === 'clarification_required')
    return '当前尝试已停止，请补充信息或调整要求后重试';
  if (rejection.code === 'candidate_schema_invalid') return '生成要求还不够明确，请补充描述后重试';
  if (rejection.code === 'dag_invalid') return '生成计划暂时不能安全提交，请稍后重试';
  if (rejection.code === 'capability_unavailable')
    return '当前选择的技能不支持这类生成操作，请在底部切换主技能后重试';
  if (rejection.code === 'model_not_approved')
    return '所选生图模型暂时不可用，请稍后重试或选择其他生图模型';
  if (rejection.code === 'cost_unavailable') return '当前价格暂不可用；请稍后重试';
  return '生成计划暂时不能安全提交，请稍后重试';
}
