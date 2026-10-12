import {
  and,
  eq,
  inArray,
  modelCatalogEntries,
  models,
  or,
  pricingCatalogReleases,
  pricingCatalogState,
  providerChannels,
  providerCircuitStates,
  providerCredentialVersions,
  type Database,
} from '@ecom-forge/db';
import { Injectable } from '@nestjs/common';

import type { AppEnvironment } from '../../config/app-config.js';
import {
  isModelCatalogRolloutVisible,
  modelCatalogManifestSchema,
  type ModelCatalogEntryManifest,
} from './model-catalog.contract.js';

type Availability = 'available' | 'unavailable';

@Injectable()
export class ModelCatalogService {
  constructor(
    private readonly database: Database,
    private readonly appEnv: AppEnvironment,
  ) {}

  async list(
    category: 'brain' | 'image' | 'video',
    userId: string,
  ): Promise<Record<string, unknown>> {
    const state = await this.database.query.pricingCatalogState.findFirst({
      where: eq(pricingCatalogState.id, 'global'),
    });
    if (!state?.activeReleaseId || category === 'video') {
      return { catalog_revision: state?.catalogRevision ?? 0, items: [] };
    }
    const release = await this.database.query.pricingCatalogReleases.findFirst({
      where: eq(pricingCatalogReleases.id, state.activeReleaseId),
    });
    if (!release || release.status !== 'published') {
      return { catalog_revision: state.catalogRevision, items: [] };
    }
    const closure = modelCatalogManifestSchema.parse(release.manifestJson);
    const visibleEntries = closure.entries
      .filter(
        (item) =>
          item.category === category &&
          item.user_selectable &&
          isModelCatalogRolloutVisible({
            appEnv: this.appEnv,
            entryId: item.id,
            userId,
            rollout: item.rollout,
          }),
      )
      .sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id));
    const availability = await this.resolveAvailability(visibleEntries);
    return {
      catalog_revision: state.catalogRevision,
      items: visibleEntries.map((item) => ({
        id: item.id,
        public_slug: item.public_slug,
        version_no: item.version_no,
        category: item.category,
        display_name: item.display_name,
        description: item.description,
        public_capabilities: item.public_capabilities,
        user_selectable: item.user_selectable,
        is_default: closure.defaults[category] === item.id || item.is_default,
        availability: availability.get(item.id) ?? 'unavailable',
        pricing_summary: closure.skus
          .filter((price) => price.model_catalog_entry_id === item.id)
          .map((price) => ({
            logical_sku_key: price.logical_sku_key,
            operation: price.operation,
            matcher: price.matcher,
            unit_kind: price.unit_kind,
            unit_rule: price.unit_rule,
            credits_per_unit: price.credits_per_unit,
            currency: 'credits',
          })),
      })),
    };
  }

  private async resolveAvailability(
    entries: ModelCatalogEntryManifest[],
  ): Promise<Map<string, Availability>> {
    if (entries.length === 0) return new Map();
    const currentEntries = await this.database
      .select()
      .from(modelCatalogEntries)
      .where(
        inArray(
          modelCatalogEntries.id,
          entries.map((item) => item.id),
        ),
      );
    const currentEntryById = new Map(currentEntries.map((item) => [item.id, item]));
    const modelIds = [...new Set(entries.map((item) => item.model_snapshot_id))];
    const modelRows = await this.database.select().from(models).where(inArray(models.id, modelIds));
    const modelById = new Map(modelRows.map((item) => [item.id, item]));
    const circuitRows = await this.database
      .select()
      .from(providerCircuitStates)
      .where(
        or(
          inArray(providerCircuitStates.modelId, modelIds),
          and(
            eq(providerCircuitStates.scopeType, 'provider'),
            inArray(providerCircuitStates.provider, [
              ...new Set(modelRows.map((row) => row.provider)),
            ]),
          ),
        ),
      );
    const channelIds = [
      ...new Set(
        modelRows.flatMap((item) => (item.providerChannelId ? [item.providerChannelId] : [])),
      ),
    ];
    const channelRows =
      channelIds.length === 0
        ? []
        : await this.database
            .select()
            .from(providerChannels)
            .where(inArray(providerChannels.id, channelIds));
    const channelById = new Map(channelRows.map((item) => [item.id, item]));
    const credentialIds = [
      ...new Set(
        channelRows.flatMap((item) =>
          item.activeCredentialVersionId ? [item.activeCredentialVersionId] : [],
        ),
      ),
    ];
    const credentialRows =
      credentialIds.length === 0
        ? []
        : await this.database
            .select()
            .from(providerCredentialVersions)
            .where(inArray(providerCredentialVersions.id, credentialIds));
    const credentialById = new Map(credentialRows.map((item) => [item.id, item]));

    return new Map(
      entries.map((item): [string, Availability] => {
        const currentEntry = currentEntryById.get(item.id);
        const model = modelById.get(item.model_snapshot_id);
        const channel = model?.providerChannelId
          ? channelById.get(model.providerChannelId)
          : undefined;
        const credential = channel?.activeCredentialVersionId
          ? credentialById.get(channel.activeCredentialVersionId)
          : undefined;
        const available =
          currentEntry?.status === 'approved' &&
          currentEntry.modelSnapshotId === item.model_snapshot_id &&
          model?.status === 'poc_passed' &&
          !!model.statusEvidenceDigest &&
          channel?.status === 'active' &&
          channel.provider === model.provider &&
          credential?.status === 'active' &&
          credential.providerChannelId === channel.id &&
          circuitRows.every(
            (circuit) =>
              circuit.provider !== model.provider ||
              (circuit.scopeType === 'model' && circuit.modelId !== model.id) ||
              (circuit.status === 'closed' && circuit.reasonCode !== 'hourly_budget'),
          );
        return [item.id, available ? 'available' : 'unavailable'];
      }),
    );
  }
}

export { isModelCatalogRolloutVisible } from './model-catalog.contract.js';
