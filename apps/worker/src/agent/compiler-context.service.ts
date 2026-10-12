import { agentClarificationPayloadSchema } from '@ecom-forge/agent';
import {
  agentTurnConfirmations,
  billableSkus,
  eq,
  inArray,
  artifacts,
  assets,
  modelCatalogEntries,
  models,
  pricingCatalogReleases,
  pricingCatalogState,
  providerCircuitStates,
  providerChannels,
  providerCredentialVersions,
  productFactSets,
  products,
  skillResourceSnapshots,
  sql,
  type Database,
} from '@ecom-forge/db';
import {
  capabilityContractSchema,
  mediaRateCardV2Schema,
  mediaV2CapabilityContractSchema,
  pricingSnapshotSchema,
  quotaSnapshotSchema,
  type ProviderCapability,
} from '@ecom-forge/provider';
import { canonicalSha256 } from '@ecom-forge/shared';
import {
  parseSkillCatalogReleaseManifest,
  parseSkillDefinition,
  resolveBuiltinSkill,
  type BuiltinSkill,
} from '@ecom-forge/skills';
import {
  productFactsSnapshotSchema,
  type AttachmentSnapshot,
  type BindingSnapshot,
  type CompilerContext,
} from '@ecom-forge/compiler';

import type { WorkerConfig } from '../config/worker-config.js';
import type { ClaimedAgentTurn } from './agent-turn.types.js';
import { resolveMediaModelClosure } from './media-model-closure.js';

export class CompilerContextService {
  constructor(
    private readonly database: Database,
    private readonly config: WorkerConfig,
    private readonly capabilityRegistryVersion: string,
    private readonly routedModelIds: ReadonlySet<string> = new Set(),
  ) {}

  async build(claimed: ClaimedAgentTurn): Promise<CompilerContext> {
    const selection = claimed.selection;
    const builtin = await resolveBuiltinSkill(selection.primary_skill_id);
    const selectedModelIds = new Set(this.routedModelIds);
    if (claimed.modelSelection) {
      selectedModelIds.add(claimed.modelSelection.image.model_snapshot_id);
    }
    const [
      skill,
      packageRow,
      release,
      catalogState,
      modelRows,
      bindings,
      pricingState,
      pricingRelease,
      catalogEntry,
      skuRows,
    ] = await Promise.all([
      builtin
        ? Promise.resolve(undefined)
        : this.database.query.skills.findFirst({
            where: (table, { eq }) => eq(table.id, selection.primary_skill_id),
          }),
      builtin
        ? Promise.resolve(undefined)
        : this.database.query.skillPackages.findFirst({
            where: (table, { eq }) => eq(table.id, selection.primary_package_record_id),
          }),
      builtin
        ? Promise.resolve(undefined)
        : this.database.query.skillCatalogReleases.findFirst({
            where: (table, { eq }) => eq(table.id, selection.catalog_release_id),
          }),
      builtin
        ? Promise.resolve(undefined)
        : this.database.query.skillCatalogState.findFirst({
            where: (table, { eq }) => eq(table.id, 'global'),
          }),
      selectedModelIds.size === 0
        ? Promise.resolve([] as (typeof models.$inferSelect)[])
        : this.database
            .select()
            .from(models)
            .where(inArray(models.id, [...selectedModelIds].sort())),
      this.resolveBindings(claimed),
      claimed.modelSelection
        ? this.database.query.pricingCatalogState.findFirst({
            where: eq(pricingCatalogState.id, 'global'),
          })
        : Promise.resolve(undefined),
      claimed.modelSelection
        ? this.database.query.pricingCatalogReleases.findFirst({
            where: eq(pricingCatalogReleases.id, claimed.modelSelection.catalog_release_id),
          })
        : Promise.resolve(undefined),
      claimed.modelSelection
        ? this.database.query.modelCatalogEntries.findFirst({
            where: eq(modelCatalogEntries.id, claimed.modelSelection.image.catalog_entry_id),
          })
        : Promise.resolve(undefined),
      claimed.modelSelection
        ? this.database
            .select()
            .from(billableSkus)
            .where(
              eq(billableSkus.modelCatalogEntryId, claimed.modelSelection.image.catalog_entry_id),
            )
        : Promise.resolve([] as (typeof billableSkus.$inferSelect)[]),
    ]);
    if (
      !builtin &&
      (!skill ||
        skill.status !== 'published' ||
        skill.definitionHash !== selection.primary_definition_hash ||
        skill.packageRecordId !== selection.primary_package_record_id ||
        !packageRow ||
        packageRow.status !== 'approved' ||
        packageRow.riskStatus !== 'clear' ||
        packageRow.disabledAt ||
        !packageRow.packageDigest ||
        !release ||
        release.status !== 'published' ||
        release.releaseDigest !== selection.catalog_version ||
        catalogState?.activeReleaseId !== release.id)
    ) {
      throw new Error('SKILL_VERSION_DRIFT');
    }
    let modelSelection: CompilerContext['model_selection'];
    if (claimed.modelSelection) {
      const selectedModel = modelRows.find(
        (row) => row.id === claimed.modelSelection!.image.model_snapshot_id,
      );
      if (
        !pricingState ||
        pricingState.activeReleaseId !== claimed.modelSelection.catalog_release_id ||
        pricingState.catalogRevision !== claimed.modelSelection.catalog_revision ||
        !pricingRelease ||
        pricingRelease.status !== 'published' ||
        pricingRelease.releaseDigest !== claimed.modelSelection.catalog_release_digest ||
        !catalogEntry ||
        !selectedModel ||
        !selectedModel.providerChannelId
      ) {
        throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
      }
      const channel = await this.database.query.providerChannels.findFirst({
        where: eq(providerChannels.id, selectedModel.providerChannelId),
      });
      const credential = channel?.activeCredentialVersionId
        ? await this.database.query.providerCredentialVersions.findFirst({
            where: eq(providerCredentialVersions.id, channel.activeCredentialVersionId),
          })
        : undefined;
      if (!channel || !credential) throw new Error('MODEL_CATALOG_CLOSURE_INVALID');
      modelSelection = resolveMediaModelClosure({
        manifestJson: pricingRelease.manifestJson,
        selection: claimed.modelSelection,
        model: selectedModel,
        catalogEntry,
        skuRows,
        channel,
        credential,
      });
    }
    const definition = builtin?.definition ?? parseSkillDefinition(skill!.definitionJson);
    let packageDigest: string;
    let releaseDigest: string;
    let expectedResources: Array<{ id: string; contentHash: string; packageResourceId: string }>;
    if (builtin) {
      packageDigest = builtin.packageDigest;
      releaseDigest = builtin.releaseDigest;
      expectedResources = await builtinResourcePairs(builtin, selection);
    } else {
      const manifest = parseSkillCatalogReleaseManifest(release!.manifestJson);
      const packageEntry = manifest.packages.find(
        (item) => item.package_record_id === packageRow!.id,
      );
      const skillEntry = packageEntry?.skills.find((item) => item.skill_id === skill!.id);
      const validationReport = packageRow!.approvedValidationReportId
        ? await this.database.query.skillPackageValidationReports.findFirst({
            where: (table, { eq }) => eq(table.id, packageRow!.approvedValidationReportId!),
          })
        : null;
      if (
        canonicalSha256(definition) !== selection.primary_definition_hash ||
        packageEntry?.package_digest !== packageRow!.packageDigest ||
        packageEntry?.validation_report_id !== packageRow!.approvedValidationReportId ||
        skillEntry?.definition_hash !== selection.primary_definition_hash ||
        !validationReport ||
        validationReport.status !== 'passed' ||
        validationReport.packageRecordId !== packageRow!.id ||
        validationReport.packageDigest !== packageRow!.packageDigest
      ) {
        throw new Error('SKILL_VERSION_DRIFT');
      }
      const resourceIds = selectionResourceIds(selection);
      const resourceRows =
        resourceIds.length === 0
          ? []
          : await this.database
              .select({
                id: skillResourceSnapshots.id,
                contentHash: skillResourceSnapshots.contentHash,
              })
              .from(skillResourceSnapshots)
              .where(inArray(skillResourceSnapshots.id, resourceIds));
      const resourceHashes = new Map(resourceRows.map((row) => [row.id, row.contentHash]));
      expectedResources = selectionResourcePairs(selection);
      const releasedResources = new Map(
        manifest.packages.flatMap((manifestPackage) =>
          manifestPackage.skills.flatMap((manifestSkill) =>
            manifestSkill.resources.map(
              (resource) =>
                [
                  resource.skill_resource_snapshot_id,
                  {
                    contentHash: resource.content_hash,
                    packageResourceId: resource.package_resource_id,
                  },
                ] as const,
            ),
          ),
        ),
      );
      if (
        expectedResources.some(
          (resource) =>
            resourceHashes.get(resource.id) !== resource.contentHash ||
            releasedResources.get(resource.id)?.contentHash !== resource.contentHash ||
            releasedResources.get(resource.id)?.packageResourceId !== resource.packageResourceId,
        )
      ) {
        throw new Error('SKILL_VERSION_DRIFT');
      }
      packageDigest = packageRow!.packageDigest!;
      releaseDigest = release!.releaseDigest;
    }

    const circuitRows = await this.database.select().from(providerCircuitStates);
    const compilerModels: CompilerContext['models'] = modelRows.flatMap(
      (row): CompilerContext['models'] => {
        const quota = quotaSnapshotSchema.safeParse(row.quotaJson);
        if (!quota.success) return [];
        const relatedCircuits = circuitRows.filter(
          (circuit) =>
            circuit.provider === row.provider &&
            (circuit.scopeType === 'provider' || circuit.modelId === row.id),
        );
        const runtimeFields = {
          status_evidence_digest: row.statusEvidenceDigest,
          quota: quota.data,
          quota_digest: canonicalSha256(quota.data),
          circuit_allows_submit: relatedCircuits.every((circuit) => circuit.status === 'closed'),
          budget_allows_submit: relatedCircuits.every(
            (circuit) => circuit.reasonCode !== 'hourly_budget',
          ),
        };
        const mediaCapability = mediaV2CapabilityContractSchema.safeParse(
          row.capabilityContractJson,
        );
        const mediaPricing = mediaRateCardV2Schema.safeParse(row.pricingJson);
        if (mediaCapability.success && mediaPricing.success && row.providerChannelId) {
          return [
            {
              id: row.id,
              provider_channel_id: row.providerChannelId,
              provider: row.provider,
              model_id: row.modelId,
              version: row.version,
              status: row.status,
              capability_contract: mediaCapability.data,
              capability_contract_digest: canonicalSha256(mediaCapability.data),
              pricing: mediaPricing.data,
              pricing_digest: canonicalSha256(mediaPricing.data),
              ...runtimeFields,
            },
          ];
        }
        const capabilityContract = capabilityContractSchema.safeParse(row.capabilityContractJson);
        const pricing = pricingSnapshotSchema.safeParse(row.pricingJson);
        if (!capabilityContract.success || !pricing.success) return [];
        return [
          {
            id: row.id,
            provider: row.provider,
            model_id: row.modelId,
            version: row.version,
            status: row.status,
            capability_contract: capabilityContract.data,
            capability_contract_digest: canonicalSha256(capabilityContract.data),
            pricing: pricing.data,
            pricing_digest: canonicalSha256(pricing.data),
            ...runtimeFields,
          },
        ];
      },
    );
    const requiredCapabilities = definition.required_capabilities.filter((value) =>
      ['image.generate', 'image.edit', 'moderation.text', 'moderation.image'].includes(value),
    ) as ProviderCapability[];
    if (requiredCapabilities.length !== definition.required_capabilities.length) {
      throw new Error('SKILL_VERSION_DRIFT');
    }
    const productFacts = await this.resolveProductFacts(claimed, bindings);
    const scopeConfirmation = await this.database.query.agentTurnConfirmations.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.turnId, claimed.turnId),
          eq(table.userId, claimed.userId),
          eq(table.type, 'clarification'),
          eq(table.status, 'answered'),
          sql`${agentTurnConfirmations.publicPayloadJson} ? 'scope_digest'`,
        ),
      orderBy: (table, { desc }) => [desc(table.answeredAt), desc(table.id)],
    });
    const confirmedPayload = agentClarificationPayloadSchema.safeParse(
      scopeConfirmation?.publicPayloadJson,
    );
    const confirmedAnswer = scopeConfirmation?.answerJson as Record<string, unknown> | null;
    const answeredScopeDigest =
      confirmedPayload.success &&
      confirmedPayload.data.scope_digest &&
      canonicalSha256(scopeConfirmation?.publicPayloadJson) === scopeConfirmation?.payloadDigest
        ? confirmedPayload.data.scope_digest
        : null;
    const confirmedScopeDigest =
      confirmedAnswer?.selected_option_id === 'option-2' ? answeredScopeDigest : null;
    const declinedScopeDigest =
      confirmedAnswer?.selected_option_id === 'option-1' ? answeredScopeDigest : null;

    return {
      schema_version: 1,
      actor: {
        user_id: claimed.userId,
        session_id: claimed.sessionId,
        turn_id: claimed.turnId,
        continuation_no: claimed.continuationNo,
      },
      skill: {
        ...(selection.execution_policy ? { execution_policy: selection.execution_policy } : {}),
        primary_skill_id: selection.primary_skill_id,
        default_output_count:
          claimed.effectiveSkillDefaultOutputCount ?? selection.default_output_count,
        selection_digest: claimed.selectionHash,
        definition_digest: builtin?.definitionHash ?? selection.primary_definition_hash,
        package_digest: packageDigest,
        release_digest: releaseDigest,
        resource_digests: expectedResources.map((resource) => resource.contentHash).sort(),
        required_capabilities: [...new Set(requiredCapabilities)].sort(),
        preset_ids: selection.preset_selections.map((preset) => preset.preset_id).sort(),
        auxiliary_skill_ids: [...selection.required_auxiliary, ...selection.optional_auxiliary]
          .map((auxiliary) => auxiliary.skill_id)
          .sort(),
      },
      execution_authorization: claimed.executionAuthorization,
      execution_authorization_digest: claimed.executionAuthorizationHash,
      bindings,
      ...(confirmedScopeDigest ? { confirmed_cross_group_scope_digest: confirmedScopeDigest } : {}),
      ...(declinedScopeDigest ? { declined_cross_group_scope_digest: declinedScopeDigest } : {}),
      models: compilerModels,
      ...(claimed.generationPreferences
        ? { generation_preferences: claimed.generationPreferences }
        : {}),
      ...(modelSelection ? { model_selection: modelSelection } : {}),
      product_facts: productFacts,
      policies: {
        compiler_version: 's09-v1',
        capability_registry_version: this.capabilityRegistryVersion,
        pricing_policy_version: 'pricing-v1',
        content_safety_policy_version: 'content-safety-v1',
        platform_policy_version: 'platform-policy-v1',
        product_fact_policy_version: productFacts ? 'product-facts-v1' : null,
        execution_policy_version: this.config.agentExecutionPolicyVersion,
        max_image_pixels: this.config.storageMaxImagePixels,
        quote_ttl_seconds: this.config.compilerQuoteTtlSeconds,
        compiled_at: new Date().toISOString(),
      },
      prompt: {
        template_version: 'agent-image-plan-v1',
        prompt_digest: canonicalSha256({
          message: claimed.message,
          selection_digest: claimed.selectionHash,
          product_facts_digest: productFacts?.snapshot_digest ?? null,
        }),
        safe_summary: '用户请求创建或编辑图片',
      },
      mandatory_confirmation: false,
    };
  }

  private async resolveBindings(claimed: ClaimedAgentTurn) {
    const candidateBindings = [...claimed.attachments, ...(claimed.sessionImageCandidates ?? [])];
    const assetIds = candidateBindings
      .filter((binding) => binding.kind === 'asset')
      .map((binding) => binding.object_id);
    const artifactIds = candidateBindings
      .filter((binding) => binding.kind === 'artifact')
      .map((binding) => binding.object_id);
    const [assetRows, artifactRows] = await Promise.all([
      assetIds.length
        ? this.database.select().from(assets).where(inArray(assets.id, assetIds))
        : [],
      artifactIds.length
        ? this.database.select().from(artifacts).where(inArray(artifacts.id, artifactIds))
        : [],
    ]);
    const assetById = new Map(assetRows.map((row) => [row.id, row]));
    const artifactById = new Map(artifactRows.map((row) => [row.id, row]));
    return candidateBindings.map((snapshot) => {
      if (snapshot.kind === 'asset') {
        const row = assetById.get(snapshot.object_id);
        if (
          !row ||
          row.userId !== claimed.userId ||
          row.status !== 'ready' ||
          !row.contentHash ||
          row.contentHash !== snapshot.content_hash ||
          snapshot.object_version !== row.contentHash ||
          snapshot.owner_user_id !== row.userId ||
          snapshot.mutable
        ) {
          throw new Error('REFERENCE_NOT_AVAILABLE');
        }
        return toCompilerBinding(snapshot);
      }
      const row = artifactById.get(snapshot.object_id);
      const publishedVersion = row?.publishedContentHash ?? row?.contentHash;
      const mutable =
        row?.producerMode === 'chat' &&
        row.producerSessionId === claimed.sessionId &&
        row.mutationOwner === 'chat_session';
      if (
        !row ||
        row.userId !== claimed.userId ||
        !publishedVersion ||
        publishedVersion !== snapshot.content_hash ||
        snapshot.object_version !== publishedVersion ||
        snapshot.owner_user_id !== row.userId ||
        row.visibility === 'quarantined' ||
        row.visibility === 'deleted' ||
        snapshot.visibility !== row.visibility ||
        snapshot.producer_mode !== row.producerMode ||
        snapshot.producer_session_id !== row.producerSessionId ||
        snapshot.mutation_owner !== row.mutationOwner ||
        snapshot.mutable !== mutable ||
        (snapshot.publication_revision ?? null) !==
          (row.publishedContentHash ? row.publicationRevision : null)
      ) {
        throw new Error('REFERENCE_NOT_AVAILABLE');
      }
      return toCompilerBinding(snapshot);
    });
  }

  private async resolveProductFacts(
    claimed: ClaimedAgentTurn,
    bindings: CompilerContext['bindings'],
  ): Promise<CompilerContext['product_facts']> {
    const productBinding = bindings.find(
      (binding) => binding.kind === 'asset' && binding.role === 'product',
    );
    if (!productBinding) {
      if (claimed.selection.execution_policy?.family === 'product') {
        const editSource = bindings.find(
          (binding) => binding.kind === 'artifact' && binding.role === 'edit_source',
        );
        if (!editSource) throw new Error('PRODUCT_FACTS_REQUIRED');
        const parent = await this.database.query.artifacts.findFirst({
          where: eq(artifacts.id, editSource.object_id),
        });
        const inherited = inheritProductFactsFromParent(parent, claimed.userId);
        if (!inherited) throw new Error('PRODUCT_FACTS_REQUIRED');
        return inherited;
      }
      return null;
    }
    const source = await this.database.query.assets.findFirst({
      where: eq(assets.id, productBinding.object_id),
    });
    if (!source || source.userId !== claimed.userId || !source.productId) {
      throw new Error('PRODUCT_FACTS_REQUIRED');
    }
    const product = await this.database.query.products.findFirst({
      where: eq(products.id, source.productId),
    });
    if (
      !product ||
      product.userId !== claimed.userId ||
      product.status !== 'active' ||
      !product.latestFactSetId
    ) {
      throw new Error('PRODUCT_FACTS_REQUIRED');
    }
    const factSet = await this.database.query.productFactSets.findFirst({
      where: eq(productFactSets.id, product.latestFactSetId),
    });
    if (!factSet || factSet.userId !== claimed.userId || factSet.productId !== product.id) {
      throw new Error('PRODUCT_FACTS_REQUIRED');
    }
    const snapshot = {
      schema_version: 1 as const,
      product_id: product.id,
      fact_set_id: factSet.id,
      fact_set_version: factSet.versionNo,
      source_asset_id: factSet.sourceAssetId,
      source_version: factSet.sourceVersion,
      facts: factSet.factsJson as {
        product_name: string;
        primary_colors: string[];
        logos: string[];
        visible_text: string[];
        materials: string[];
        must_preserve: string[];
        unknown_fields: string[];
      },
    };
    return { ...snapshot, snapshot_digest: canonicalSha256(snapshot) };
  }
}

/** Preserve the server-frozen selection evidence across the compiler boundary. */
export function toCompilerBinding(snapshot: AttachmentSnapshot): BindingSnapshot {
  const sessionCandidate = snapshot as AttachmentSnapshot & {
    candidate_kind?: 'latest_output' | 'original_source';
    candidate_position?: number;
    lineage_source_binding_keys?: string[];
  };
  return {
    binding_key: snapshot.binding_key,
    kind: snapshot.kind,
    object_id: snapshot.object_id,
    object_version: snapshot.object_version,
    content_hash: snapshot.content_hash,
    owner_user_id: snapshot.owner_user_id,
    readable: snapshot.readable,
    mutable: snapshot.mutable,
    producer_mode: snapshot.producer_mode,
    producer_session_id: snapshot.producer_session_id,
    mutation_owner: snapshot.mutation_owner,
    source_action: snapshot.source_action,
    media_type: snapshot.media_type,
    lifecycle: snapshot.lifecycle,
    visibility: snapshot.visibility,
    role: snapshot.role,
    position: snapshot.position,
    publication_revision: snapshot.publication_revision,
    ...(sessionCandidate.candidate_kind
      ? {
          candidate_kind: sessionCandidate.candidate_kind,
          candidate_position: sessionCandidate.candidate_position,
          lineage_source_binding_keys: sessionCandidate.lineage_source_binding_keys ?? [],
          ...(snapshot.source_group ? { source_group: snapshot.source_group } : {}),
        }
      : {}),
  };
}

export function inheritProductFactsFromParent(
  parent:
    | {
        userId: string;
        originDomain: string;
        paramsSnapshot: unknown;
      }
    | undefined,
  userId: string,
): CompilerContext['product_facts'] {
  if (!parent || parent.userId !== userId || parent.originDomain !== 'commerce') return null;
  const parentParams = parent.paramsSnapshot as Record<string, unknown> | null;
  const inherited = productFactsSnapshotSchema.safeParse(parentParams?.product_facts_snapshot);
  if (!inherited.success) return null;
  const { snapshot_digest: digest, ...snapshot } = inherited.data;
  return canonicalSha256(snapshot) === digest ? inherited.data : null;
}

async function builtinResourcePairs(
  builtin: BuiltinSkill,
  selection: ClaimedAgentTurn['selection'],
): Promise<Array<{ id: string; contentHash: string; packageResourceId: string }>> {
  const entries = [
    [builtin.skillId, selection.primary_planning_resource],
    ...selection.primary_reference_resources.map(
      (resource) => [builtin.skillId, resource] as const,
    ),
    ...selection.preset_selections.map((preset) => [builtin.skillId, preset] as const),
    ...[...selection.required_auxiliary, ...selection.optional_auxiliary].flatMap((auxiliary) => [
      [auxiliary.skill_id, auxiliary.planning_resource] as const,
      ...auxiliary.reference_resources.map((resource) => [auxiliary.skill_id, resource] as const),
    ]),
  ] as unknown as Array<[string, { resource_path: string }]>;
  return Promise.all(
    entries.map(async ([skillId, selected]) => {
      const skillResources =
        skillId === builtin.skillId ? builtin : await resolveBuiltinSkill(skillId);
      const resource = skillResources?.resources.get(selected.resource_path);
      if (!resource) throw new Error('SKILL_VERSION_DRIFT');
      return {
        id: resource.resource_snapshot_id,
        contentHash: resource.resource_hash,
        packageResourceId: resource.package_resource_id,
      };
    }),
  );
}

function selectionResourcePairs(selection: ClaimedAgentTurn['selection']) {
  return [
    selection.primary_planning_resource,
    ...selection.primary_reference_resources,
    ...selection.preset_selections.map((preset) => ({
      resource_snapshot_id: preset.resource_snapshot_id,
      resource_hash: preset.resource_hash,
      package_resource_id: preset.package_resource_id,
    })),
    ...[...selection.required_auxiliary, ...selection.optional_auxiliary].flatMap((auxiliary) => [
      auxiliary.planning_resource,
      ...auxiliary.reference_resources,
    ]),
  ].map((resource) => ({
    id: resource.resource_snapshot_id,
    contentHash: resource.resource_hash,
    packageResourceId: resource.package_resource_id,
  }));
}

function selectionResourceIds(selection: ClaimedAgentTurn['selection']): string[] {
  return selectionResourcePairs(selection).map((resource) => resource.id);
}
