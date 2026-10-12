import { agentBrainModelSnapshotSchema, type AgentBrainModelSnapshot } from '@ecom-forge/agent';
import {
  and,
  eq,
  modelCatalogEntries,
  models,
  pricingCatalogReleases,
  pricingCatalogState,
  providerChannels,
  providerCredentialVersions,
  type Database,
} from '@ecom-forge/db';
import { mediaV2CapabilityContractSchema, type MediaCapabilitySpec } from '@ecom-forge/provider';
import { canonicalSha256 } from '@ecom-forge/shared';

import type { AppEnvironment } from '../../config/app-config.js';
import {
  isModelCatalogRolloutVisible,
  modelCatalogManifestSchema,
  type ModelCatalogEntryManifest,
} from '../model-catalog/model-catalog.contract.js';
import { agentError } from './agent.errors.js';
import type { GenerationPreferencesInput, ModelSelectionInput } from './agent.schemas.js';

type ReadContext = Pick<Database, 'query' | 'select'>;
type Category = 'brain' | 'image' | 'video';

interface ResolvedEntry {
  manifest: ModelCatalogEntryManifest;
  catalogEntry: typeof modelCatalogEntries.$inferSelect;
  model: typeof models.$inferSelect;
  channel: typeof providerChannels.$inferSelect;
  credential: typeof providerCredentialVersions.$inferSelect;
}

export interface ResolvedAgentModelSelection {
  snapshot: Record<string, unknown>;
  hash: string;
  brainModelSnapshot: AgentBrainModelSnapshot;
  brainModelSnapshotId: string;
}

interface PublicModelEntrySnapshot {
  catalog_entry_id: string;
  version_no: number;
  display_name: string;
}

export interface PublicAgentModelSelection {
  catalog_revision: number;
  brain: PublicModelEntrySnapshot;
  image?: PublicModelEntrySnapshot;
  video?: PublicModelEntrySnapshot;
}

export function publicAgentModelSelection(snapshot: unknown): PublicAgentModelSelection {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Agent model snapshot is missing');
  const value = snapshot as Record<string, unknown>;
  const project = (entry: unknown): PublicModelEntrySnapshot | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    const row = entry as Record<string, unknown>;
    if (
      typeof row.catalog_entry_id !== 'string' ||
      typeof row.version_no !== 'number' ||
      typeof row.display_name !== 'string'
    ) {
      throw new Error('Agent model snapshot is invalid');
    }
    return {
      catalog_entry_id: row.catalog_entry_id,
      version_no: row.version_no,
      display_name: row.display_name,
    };
  };
  const brain = project(value.brain);
  if (typeof value.catalog_revision !== 'number' || !brain) {
    throw new Error('Agent model snapshot is invalid');
  }
  const image = project(value.image);
  const video = project(value.video);
  return {
    catalog_revision: value.catalog_revision,
    brain,
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
  };
}

export class AgentModelSelectionService {
  constructor(
    private readonly database: ReadContext,
    private readonly appEnv: AppEnvironment,
  ) {}

  async resolve(input: {
    userId: string;
    selection: ModelSelectionInput;
    preferences: GenerationPreferencesInput;
    requiredCapabilities: string[];
    requiredOperation?: 'image.generate' | 'image.edit';
  }): Promise<ResolvedAgentModelSelection> {
    if (!input.selection.image) agentError('MODEL_SELECTION_REQUIRED');
    if (input.selection.video) agentError('MODEL_SELECTION_INVALID');

    const state = await this.database.query.pricingCatalogState.findFirst({
      where: eq(pricingCatalogState.id, 'global'),
    });
    if (!state?.activeReleaseId || state.catalogRevision !== input.selection.catalog_revision) {
      agentError('MODEL_CATALOG_STALE');
    }
    const release = await this.database.query.pricingCatalogReleases.findFirst({
      where: and(
        eq(pricingCatalogReleases.id, state.activeReleaseId),
        eq(pricingCatalogReleases.status, 'published'),
      ),
    });
    if (!release) agentError('MODEL_CATALOG_STALE');

    const parsedManifest = modelCatalogManifestSchema.safeParse(release.manifestJson);
    if (!parsedManifest.success) agentError('MODEL_CATALOG_STALE');
    const manifest = parsedManifest.data;
    const brain = await this.resolveEntry({
      category: 'brain',
      entryId: input.selection.brain.catalog_entry_id,
      versionNo: input.selection.brain.version_no,
      manifest: manifest.entries,
      userId: input.userId,
    });
    const image = await this.resolveEntry({
      category: 'image',
      entryId: input.selection.image.catalog_entry_id,
      versionNo: input.selection.image.version_no,
      manifest: manifest.entries,
      userId: input.userId,
    });

    const brainModelSnapshot = agentBrainModelSnapshotSchema.safeParse({
      snapshot_id: brain.model.id,
      adapter: brain.channel.adapterKey === 'fake-provider-v1' ? 'fake' : 'approved',
      provider: brain.model.provider,
      protocol_family: brain.model.protocolFamily ?? undefined,
      api_variant: brain.model.apiVariant ?? undefined,
      model_id: brain.model.modelId,
      version: brain.model.version,
      status: brain.model.status,
      status_evidence_digest: brain.model.statusEvidenceDigest,
      capability_contract: brain.model.capabilityContractJson,
      pricing: brain.model.pricingJson,
      quota: brain.model.quotaJson,
      ...(brain.channel.adapterKey === 'fake-provider-v1'
        ? {}
        : {
            runtime: {
              provider_channel_id: brain.channel.id,
              provider_channel_revision: brain.channel.revision,
              adapter_key: brain.channel.adapterKey,
              endpoint_profile_key: brain.channel.endpointProfileKey,
              region: brain.channel.region,
              credential_version_id: brain.credential.id,
            },
          }),
    });
    if (!brainModelSnapshot.success) agentError('AGENT_MODEL_UNAVAILABLE');

    const imageCapability = mediaV2CapabilityContractSchema.safeParse(
      image.model.capabilityContractJson,
    );
    if (!imageCapability.success || imageCapability.data.media_kind !== 'image') {
      agentError('MODEL_SELECTION_INVALID');
    }
    const requiredMediaCapabilities = input.requiredOperation
      ? [input.requiredOperation]
      : input.requiredCapabilities.filter((capability) =>
          ['image.generate', 'image.edit', 'upscale'].includes(capability),
        );
    if (
      requiredMediaCapabilities.some(
        (capability) => !imageCapability.data.capabilities.includes(capability as never),
      )
    ) {
      agentError('MODEL_SELECTION_INVALID');
    }
    const allowedOperations = new Set(
      requiredMediaCapabilities.length > 0 ? requiredMediaCapabilities : ['image.generate'],
    );
    const matchingSpecs = imageCapability.data.specs.filter(
      (spec): spec is Extract<MediaCapabilitySpec, { kind: 'image' }> =>
        spec.kind === 'image' &&
        allowedOperations.has(spec.operation) &&
        spec.resolution_tier === input.preferences.resolution_tier &&
        (input.preferences.aspect_ratio === 'auto'
          ? spec.aspect_ratios.length > 0
          : spec.aspect_ratios.includes(input.preferences.aspect_ratio)),
    );
    if (matchingSpecs.length === 0) agentError('GENERATION_PREFERENCES_INVALID');

    const selectedSpec = [...matchingSpecs].sort((left, right) =>
      left.spec_key.localeCompare(right.spec_key),
    )[0];
    if (!selectedSpec) agentError('GENERATION_PREFERENCES_INVALID');
    const snapshot = {
      schema_version: 1,
      catalog_revision: state.catalogRevision,
      catalog_release_id: release.id,
      catalog_release_digest: release.releaseDigest,
      brain: publicEntrySnapshot(brain),
      image: {
        ...publicEntrySnapshot(image),
        selected_spec_key: selectedSpec.spec_key,
        selected_operation: selectedSpec.operation,
        supported_aspect_ratios: [...selectedSpec.aspect_ratios].sort(),
        ...(selectedSpec.max_prompt_characters !== undefined
          ? { max_prompt_characters: selectedSpec.max_prompt_characters }
          : {}),
      },
    };
    return {
      snapshot,
      hash: canonicalSha256(snapshot),
      brainModelSnapshot: brainModelSnapshot.data,
      brainModelSnapshotId: brain.model.id,
    };
  }

  private async resolveEntry(input: {
    category: Category;
    entryId: string;
    versionNo: number;
    manifest: ModelCatalogEntryManifest[];
    userId: string;
  }): Promise<ResolvedEntry> {
    const manifest = input.manifest.find(
      (entry) =>
        entry.id === input.entryId &&
        entry.version_no === input.versionNo &&
        entry.category === input.category,
    );
    if (
      !manifest?.user_selectable ||
      !isModelCatalogRolloutVisible({
        appEnv: this.appEnv,
        entryId: input.entryId,
        userId: input.userId,
        rollout: manifest?.rollout ?? { stage: this.appEnv, percentage: 0 },
      })
    ) {
      agentError('MODEL_SELECTION_INVALID');
    }
    const catalogEntry = await this.database.query.modelCatalogEntries.findFirst({
      where: and(
        eq(modelCatalogEntries.id, manifest.id),
        eq(modelCatalogEntries.status, 'approved'),
      ),
    });
    if (
      !catalogEntry ||
      catalogEntry.category !== input.category ||
      catalogEntry.versionNo !== manifest.version_no ||
      catalogEntry.modelSnapshotId !== manifest.model_snapshot_id ||
      catalogEntry.revision !== manifest.revision ||
      !catalogEntry.userSelectable
    ) {
      agentError('MODEL_SELECTION_INVALID');
    }
    const model = await this.database.query.models.findFirst({
      where: eq(models.id, manifest.model_snapshot_id),
    });
    if (
      !model ||
      model.status !== 'poc_passed' ||
      !model.statusEvidenceDigest ||
      !model.providerChannelId
    ) {
      agentError('AGENT_MODEL_UNAVAILABLE');
    }
    const channel = await this.database.query.providerChannels.findFirst({
      where: eq(providerChannels.id, model.providerChannelId),
    });
    if (
      !channel ||
      channel.status !== 'active' ||
      channel.provider !== model.provider ||
      !channel.activeCredentialVersionId
    ) {
      agentError('AGENT_MODEL_UNAVAILABLE');
    }
    const credential = await this.database.query.providerCredentialVersions.findFirst({
      where: eq(providerCredentialVersions.id, channel.activeCredentialVersionId),
    });
    if (
      !credential ||
      credential.status !== 'active' ||
      credential.providerChannelId !== channel.id
    ) {
      agentError('AGENT_MODEL_UNAVAILABLE');
    }
    return { manifest, catalogEntry, model, channel, credential };
  }
}

function publicEntrySnapshot(entry: ResolvedEntry) {
  return {
    catalog_entry_id: entry.catalogEntry.id,
    catalog_entry_revision: entry.catalogEntry.revision,
    version_no: entry.catalogEntry.versionNo,
    public_slug: entry.catalogEntry.publicSlug,
    display_name: entry.catalogEntry.displayName,
    model_snapshot_id: entry.model.id,
  };
}
