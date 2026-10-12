import {
  and,
  asc,
  eq,
  inArray,
  skillCatalogReleases,
  skillCatalogState,
  skillPackageResources,
  skillPackages,
  skillResourceSnapshots,
  skills,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import {
  parseSkillCatalogReleaseManifest,
  parseSkillDefinition,
  resolveBuiltinSkill,
  getBuiltinSkillCatalog,
  validateSkillSelection,
  type AuxiliarySkillSelectionSnapshot,
  type BuiltinSkill,
  type SkillCatalogReleaseManifest,
  type SkillDefinition,
  type SkillResourceSelectionSnapshot,
  type SkillSelectionInput,
  type SkillSelectionSnapshot,
} from '@ecom-forge/skills';
import type { OriginDomain } from '@ecom-forge/types';

import { agentError } from './agent.errors.js';
import type { AppConfig } from '../../config/app-config.js';

const PRODUCT_STAGE = '1A';
type SkillReadContext = Pick<Database, 'query' | 'select'>;

interface CatalogContext {
  releaseId: string;
  releaseDigest: string;
  manifest: SkillCatalogReleaseManifest;
}

interface PublishedSkill {
  row: typeof skills.$inferSelect;
  definition: SkillDefinition;
  packageEntry: SkillCatalogReleaseManifest['packages'][number];
  skillEntry: SkillCatalogReleaseManifest['packages'][number]['skills'][number];
}

function requiredBuiltinResource(
  skill: BuiltinSkill,
  path: string,
): SkillResourceSelectionSnapshot {
  const resource = skill.resources.get(path);
  if (!resource) throw new Error('SKILL_VERSION_DRIFT');
  return resource;
}

function publicBuiltinSkill(item: BuiltinSkill) {
  const definition = item.definition;
  return {
    primary_skill_id: item.skillId,
    slug: definition.slug,
    version: definition.version,
    name: definition.display_name,
    description: definition.description,
    domain: definition.domain,
    category: definition.category,
    ...(definition.cover_asset ? { cover_asset: definition.cover_asset } : {}),
    required_inputs: definition.required_inputs,
    ...(definition.attachment_roles ? { attachment_roles: definition.attachment_roles } : {}),
    definition_hash: item.definitionHash,
    sort_order: definition.sort_order,
    preset_slots: definition.preset_slots.map((slot) => ({
      slot: slot.slot,
      label: slot.label,
      required: slot.required,
      max_selections: slot.max_selections,
      options: slot.options
        .filter((option) => !option.disabled)
        .map((option) => ({
          preset_id: option.preset_id,
          name: option.name,
          description: option.description,
          ...(option.preview_asset ? { preview_asset: option.preview_asset } : {}),
        })),
    })),
  };
}

function stripCatalogInternals<
  T extends { primary_skill_id: string; definition_hash: string | null; sort_order: number },
>(item: T): T {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== 'definition_hash' && key !== 'sort_order'),
  ) as T;
}

function compareStrictSemver(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
    if (!match) throw new Error('SKILL_VERSION_INVALID');
    return match.slice(1).map((part) => BigInt(part));
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! > rightParts[index]!) return 1;
    if (leftParts[index]! < rightParts[index]!) return -1;
  }
  return 0;
}

export function latestPublishedSkillBySlug<
  T extends { row: { id: string; slug: string; version: string; sortOrder: number } },
>(published: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const item of published) {
    const current = latest.get(item.row.slug);
    if (
      !current ||
      compareStrictSemver(item.row.version, current.row.version) > 0 ||
      (item.row.version === current.row.version && item.row.id > current.row.id)
    ) {
      latest.set(item.row.slug, item);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.row.sortOrder - right.row.sortOrder || left.row.id.localeCompare(right.row.id),
  );
}

export function excludeBuiltinSlugCollisions<T extends { slug: string }>(
  external: readonly T[],
  builtin: readonly { slug: string }[],
): T[] {
  const builtinSlugs = new Set(builtin.map((item) => item.slug));
  return external.filter((item) => !builtinSlugs.has(item.slug));
}

export class SkillCatalogService {
  constructor(
    private readonly database: SkillReadContext,
    private readonly config?: Pick<AppConfig, 'agent'>,
  ) {}

  async list(domain?: OriginDomain) {
    const builtinCatalog = await getBuiltinSkillCatalog();
    const builtinCatalogItems = builtinCatalog.skills
      .filter(
        (item) =>
          item.definition.kind === 'primary' &&
          item.definition.stage === PRODUCT_STAGE &&
          item.definition.catalog_enabled !== false &&
          (!domain || item.definition.domain === domain),
      )
      .map(publicBuiltinSkill);
    const builtinItems = builtinCatalogItems.map(stripCatalogInternals);
    const context = await this.activeCatalog();
    const generationPolicy = {
      schema_version: 2 as const,
      policy_version: this.config?.agent.executionPolicyVersion ?? 'agent-execution-policy-v1',
    };
    if (!context) {
      const catalogVersion = canonicalSha256(
        builtinCatalogItems.map((item) => ({
          id: item.primary_skill_id,
          definition_hash: item.definition_hash,
          sort_order: item.sort_order,
        })),
      );
      return {
        catalog_version: catalogVersion,
        response_version: canonicalSha256({
          catalog_version: catalogVersion,
          generation_policy_version: generationPolicy.policy_version,
        }),
        generation_policy: generationPolicy,
        items: builtinItems,
      };
    }
    const skillIds = context.manifest.packages.flatMap((item) =>
      item.skills.map((skill) => skill.skill_id),
    );
    const rows = await this.database
      .select()
      .from(skills)
      .where(
        and(
          inArray(skills.id, skillIds),
          eq(skills.status, 'published'),
          eq(skills.kind, 'primary'),
          eq(skills.visibility, 'public'),
          eq(skills.stage, PRODUCT_STAGE),
          domain ? eq(skills.domain, domain) : undefined,
        ),
      )
      .orderBy(asc(skills.sortOrder), asc(skills.id));
    const published = latestPublishedSkillBySlug(await this.validPublishedSkills(context, rows));
    const externalItems = published.map(({ row, definition }) => ({
      primary_skill_id: row.id,
      slug: row.slug,
      version: row.version,
      name: definition.display_name,
      description: definition.description,
      domain: definition.domain,
      category: definition.category,
      ...(definition.cover_asset ? { cover_asset: definition.cover_asset } : {}),
      required_inputs: definition.required_inputs,
      ...(definition.attachment_roles ? { attachment_roles: definition.attachment_roles } : {}),
      definition_hash: row.definitionHash,
      sort_order: row.sortOrder,
      preset_slots: definition.preset_slots.map((slot) => ({
        slot: slot.slot,
        label: slot.label,
        required: slot.required,
        max_selections: slot.max_selections,
        options: slot.options
          .filter((option) => !option.disabled)
          .map((option) => ({
            preset_id: option.preset_id,
            name: option.name,
            description: option.description,
            ...(option.preview_asset ? { preview_asset: option.preview_asset } : {}),
          })),
      })),
    }));
    const itemsWithMeta = [
      ...builtinCatalogItems,
      ...excludeBuiltinSlugCollisions(
        externalItems,
        builtinCatalog.skills.map((item) => item.definition),
      ),
    ];
    const items = itemsWithMeta.map(stripCatalogInternals);
    const catalogVersion = canonicalSha256(
      itemsWithMeta.map((item) => ({
        id: item.primary_skill_id,
        definition_hash: item.definition_hash,
        sort_order: item.sort_order,
      })),
    );
    return {
      catalog_version: catalogVersion,
      response_version: canonicalSha256({
        catalog_version: catalogVersion,
        generation_policy_version: generationPolicy.policy_version,
      }),
      generation_policy: generationPolicy,
      items,
    };
  }

  async resolveSelection(selection: SkillSelectionInput): Promise<{
    snapshot: SkillSelectionSnapshot;
    hash: string;
    requiredCapabilities: string[];
  }> {
    const builtin = await resolveBuiltinSkill(selection.primary_skill_id);
    if (builtin) {
      return this.resolveBuiltinSelection(builtin, {
        ...selection,
        primary_skill_id: builtin.skillId,
      });
    }
    const context = await this.activeCatalog();
    if (!context) agentError('SKILL_SELECTION_INVALID');
    const row = await this.database.query.skills.findFirst({
      where: eq(skills.id, selection.primary_skill_id),
    });
    if (
      !row ||
      row.status !== 'published' ||
      row.kind !== 'primary' ||
      row.visibility !== 'public'
    ) {
      agentError('SKILL_SELECTION_INVALID');
    }
    if (row.stage !== PRODUCT_STAGE || !row.packageRecordId || !row.definitionHash) {
      agentError('SKILL_SELECTION_INVALID');
    }
    const [published] = await this.validPublishedSkills(context, [row]);
    if (!published) agentError('SKILL_SELECTION_INVALID');
    const resourceSnapshots = await this.resourceSnapshots(
      published.row.id,
      published.skillEntry.resources,
    );
    const planningResource = resourceSnapshots.get(published.definition.planning_view.path);
    if (!planningResource) agentError('SKILL_VERSION_DRIFT');
    const dependencySnapshots = await this.dependencySnapshots(context, published.definition);
    const definitionHash = published.row.definitionHash;
    const packageRecordId = published.row.packageRecordId;
    if (!definitionHash || !packageRecordId) agentError('SKILL_VERSION_DRIFT');
    try {
      const resolved = validateSkillSelection({
        selection,
        definition: published.definition,
        definitionHash,
        packageRecordId,
        planningResource,
        catalogReleaseId: context.releaseId,
        catalogVersion: context.releaseDigest,
        dependencySnapshots,
        resourceSnapshots,
      });
      return {
        ...resolved,
        requiredCapabilities: [...new Set(published.definition.required_capabilities)].sort(),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'SKILL_SELECTION_REQUIRED') {
        agentError('SKILL_SELECTION_REQUIRED');
      }
      if (error instanceof Error && error.message === 'SKILL_VERSION_DRIFT') {
        agentError('SKILL_VERSION_DRIFT');
      }
      agentError('SKILL_SELECTION_INVALID');
    }
  }

  private async resolveBuiltinSelection(
    builtin: BuiltinSkill,
    selection: SkillSelectionInput,
  ): Promise<{
    snapshot: SkillSelectionSnapshot;
    hash: string;
    requiredCapabilities: string[];
  }> {
    const catalog = await getBuiltinSkillCatalog();
    const dependencies = new Map<string, AuxiliarySkillSelectionSnapshot>();
    for (const dependency of builtin.definition.dependencies) {
      const auxiliary = await resolveBuiltinSkill(dependency.skill_id);
      if (!auxiliary) agentError('SKILL_VERSION_DRIFT');
      dependencies.set(dependency.skill_id, {
        skill_id: auxiliary.skillId,
        name: auxiliary.definition.display_name,
        definition_hash: auxiliary.definitionHash,
        package_record_id: auxiliary.packageRecordId,
        planning_resource: requiredBuiltinResource(auxiliary, 'SKILL.md'),
        reference_resources: auxiliary.definition.references.map((reference) =>
          requiredBuiltinResource(auxiliary, reference.path),
        ),
      });
    }
    try {
      const resolved = validateSkillSelection({
        selection,
        definition: builtin.definition,
        definitionHash: builtin.definitionHash,
        packageRecordId: builtin.packageRecordId,
        planningResource: requiredBuiltinResource(builtin, 'SKILL.md'),
        catalogReleaseId: catalog.catalogReleaseId,
        catalogVersion: catalog.catalogVersion,
        dependencySnapshots: dependencies,
        resourceSnapshots: builtin.resources,
      });
      return {
        ...resolved,
        requiredCapabilities: [...new Set(builtin.definition.required_capabilities)].sort(),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'SKILL_SELECTION_REQUIRED') {
        agentError('SKILL_SELECTION_REQUIRED');
      }
      if (error instanceof Error && error.message === 'SKILL_VERSION_DRIFT') {
        agentError('SKILL_VERSION_DRIFT');
      }
      agentError('SKILL_SELECTION_INVALID');
    }
  }

  private async activeCatalog(): Promise<CatalogContext | null> {
    const state = await this.database.query.skillCatalogState.findFirst({
      where: eq(skillCatalogState.id, 'global'),
    });
    if (!state?.activeReleaseId) return null;
    const release = await this.database.query.skillCatalogReleases.findFirst({
      where: and(
        eq(skillCatalogReleases.id, state.activeReleaseId),
        eq(skillCatalogReleases.status, 'published'),
      ),
    });
    if (!release) return null;
    try {
      return {
        releaseId: release.id,
        releaseDigest: release.releaseDigest,
        manifest: parseSkillCatalogReleaseManifest(release.manifestJson),
      };
    } catch {
      return null;
    }
  }

  private async validPublishedSkills(
    context: CatalogContext,
    rows: Array<typeof skills.$inferSelect>,
  ): Promise<PublishedSkill[]> {
    const packageIds = [
      ...new Set(rows.flatMap((row) => (row.packageRecordId ? [row.packageRecordId] : []))),
    ];
    const packages =
      packageIds.length === 0
        ? []
        : await this.database
            .select()
            .from(skillPackages)
            .where(inArray(skillPackages.id, packageIds));
    const packageById = new Map(packages.map((item) => [item.id, item]));
    const now = Date.now();
    const result: PublishedSkill[] = [];
    for (const row of rows) {
      if (!row.packageRecordId || !row.definitionHash || !row.skillDigest) continue;
      const packageEntry = context.manifest.packages.find(
        (item) => item.package_record_id === row.packageRecordId,
      );
      const skillEntry = packageEntry?.skills.find((item) => item.skill_id === row.id);
      const packageRow = packageById.get(row.packageRecordId);
      if (
        !packageEntry ||
        !skillEntry ||
        skillEntry.definition_hash !== row.definitionHash ||
        !packageRow ||
        packageRow.status !== 'approved' ||
        packageRow.packageDigest !== packageEntry.package_digest ||
        packageRow.approvedValidationReportId !== packageEntry.validation_report_id ||
        packageRow.riskStatus === 'critical' ||
        packageRow.disabledAt ||
        (packageRow.riskStatus === 'needs_review' &&
          packageRow.riskReviewDueAt &&
          packageRow.riskReviewDueAt.getTime() <= now)
      ) {
        continue;
      }
      try {
        const definition = parseSkillDefinition(row.definitionJson);
        if (
          `${definition.slug}@${definition.version}` !== row.id ||
          definition.stage !== row.stage ||
          definition.kind !== row.kind ||
          definition.visibility !== row.visibility ||
          canonicalSha256(definition) !== row.definitionHash
        ) {
          continue;
        }
        result.push({ row, definition, packageEntry, skillEntry });
      } catch {
        continue;
      }
    }
    return result;
  }

  private async resourceSnapshots(
    skillId: string,
    resources: PublishedSkill['skillEntry']['resources'],
  ): Promise<Map<string, SkillResourceSelectionSnapshot>> {
    const rows = await this.database
      .select({
        id: skillResourceSnapshots.id,
        resourcePath: skillResourceSnapshots.resourcePath,
        contentHash: skillResourceSnapshots.contentHash,
        packageResourceId: skillResourceSnapshots.packageResourceId,
        packagePath: skillPackageResources.resourcePath,
        packageHash: skillPackageResources.contentHash,
      })
      .from(skillResourceSnapshots)
      .leftJoin(
        skillPackageResources,
        eq(skillPackageResources.id, skillResourceSnapshots.packageResourceId),
      )
      .where(eq(skillResourceSnapshots.skillId, skillId));
    const releaseByPath = new Map(resources.map((item) => [item.resource_path, item]));
    const result = new Map<string, SkillResourceSelectionSnapshot>();
    for (const row of rows) {
      const released = releaseByPath.get(row.resourcePath);
      if (
        !released ||
        !row.packageResourceId ||
        row.id !== released.skill_resource_snapshot_id ||
        row.packageResourceId !== released.package_resource_id ||
        row.contentHash !== released.content_hash ||
        row.packageHash !== row.contentHash
      ) {
        continue;
      }
      result.set(row.resourcePath, {
        resource_snapshot_id: row.id,
        package_resource_id: row.packageResourceId,
        resource_path: row.resourcePath,
        resource_hash: row.contentHash,
      });
    }
    if (result.size !== resources.length) agentError('SKILL_VERSION_DRIFT');
    return result;
  }

  private async dependencySnapshots(
    context: CatalogContext,
    definition: SkillDefinition,
  ): Promise<Map<string, AuxiliarySkillSelectionSnapshot>> {
    const result = new Map<string, AuxiliarySkillSelectionSnapshot>();
    for (const dependency of definition.dependencies) {
      const row = await this.database.query.skills.findFirst({
        where: eq(skills.id, dependency.skill_id),
      });
      if (
        !row ||
        row.kind !== 'auxiliary' ||
        row.visibility !== 'internal' ||
        row.stage !== PRODUCT_STAGE
      ) {
        agentError('SKILL_VERSION_DRIFT');
      }
      const [published] = await this.validPublishedSkills(context, [row]);
      if (!published || !published.row.packageRecordId || !published.row.definitionHash) {
        agentError('SKILL_VERSION_DRIFT');
      }
      const resources = await this.resourceSnapshots(
        published.row.id,
        published.skillEntry.resources,
      );
      const planningResource = resources.get(published.definition.planning_view.path);
      if (!planningResource) agentError('SKILL_VERSION_DRIFT');
      result.set(row.id, {
        skill_id: row.id,
        name: published.definition.display_name,
        definition_hash: published.row.definitionHash,
        package_record_id: published.row.packageRecordId,
        planning_resource: planningResource,
        reference_resources: published.definition.references.map((reference) => {
          const resource = resources.get(reference.path);
          if (!resource || resource.resource_hash !== reference.content_hash) {
            agentError('SKILL_VERSION_DRIFT');
          }
          return resource;
        }),
      });
    }
    return result;
  }
}
