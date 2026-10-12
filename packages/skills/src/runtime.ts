import { canonicalSha256 } from '@ecom-forge/shared';
import type { SkillExecutionPolicy } from '@ecom-forge/shared';
import { z } from 'zod';

import type { SkillDefinition } from './definition.js';

export interface SkillSelectionInput {
  primary_skill_id: string;
  preset_selections: Array<{ slot: string; preset_id: string }>;
}

export interface SkillSelectionSnapshot {
  primary_skill_id: string;
  primary_name: string;
  primary_definition_hash: string;
  primary_package_record_id: string;
  required_capabilities: string[];
  default_output_count: number;
  execution_policy?: SkillExecutionPolicy;
  primary_planning_resource: SkillResourceSelectionSnapshot;
  primary_reference_resources: SkillResourceSelectionSnapshot[];
  catalog_release_id: string;
  catalog_version: string;
  preset_selections: Array<{
    slot: string;
    preset_id: string;
    name: string;
    resource_path: string;
    resource_hash: string;
    resource_snapshot_id: string;
    package_resource_id: string;
  }>;
  required_auxiliary: AuxiliarySkillSelectionSnapshot[];
  optional_auxiliary: AuxiliarySkillSelectionSnapshot[];
}

export interface SkillResourceSelectionSnapshot {
  resource_snapshot_id: string;
  package_resource_id: string;
  resource_path: string;
  resource_hash: string;
}

export interface AuxiliarySkillSelectionSnapshot {
  skill_id: string;
  name: string;
  definition_hash: string;
  package_record_id: string;
  planning_resource: SkillResourceSelectionSnapshot;
  reference_resources: SkillResourceSelectionSnapshot[];
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const skillCatalogReleaseManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  packages: z
    .array(
      z.strictObject({
        package_record_id: z.uuid(),
        validation_report_id: z.uuid(),
        package_digest: sha256Schema,
        skills: z
          .array(
            z.strictObject({
              skill_id: z.string().min(3).max(160),
              definition_hash: sha256Schema,
              resources: z
                .array(
                  z.strictObject({
                    skill_resource_snapshot_id: z.uuid(),
                    package_resource_id: z.uuid(),
                    resource_path: z.string().min(1).max(240),
                    content_hash: sha256Schema,
                  }),
                )
                .min(1)
                .max(64),
            }),
          )
          .min(1)
          .max(32),
      }),
    )
    .min(1)
    .max(128),
});

export type SkillCatalogReleaseManifest = z.infer<typeof skillCatalogReleaseManifestSchema>;

export function parseSkillCatalogReleaseManifest(input: unknown): SkillCatalogReleaseManifest {
  const result = skillCatalogReleaseManifestSchema.safeParse(input);
  if (!result.success) throw new Error('SKILL_CATALOG_RELEASE_INVALID');
  const packageIds = result.data.packages.map((item) => item.package_record_id);
  if (new Set(packageIds).size !== packageIds.length) {
    throw new Error('SKILL_CATALOG_RELEASE_INVALID');
  }
  const skillIds = result.data.packages.flatMap((item) =>
    item.skills.map((skill) => skill.skill_id),
  );
  if (new Set(skillIds).size !== skillIds.length) {
    throw new Error('SKILL_CATALOG_RELEASE_INVALID');
  }
  for (const packageEntry of result.data.packages) {
    for (const skill of packageEntry.skills) {
      const paths = skill.resources.map((resource) => resource.resource_path);
      if (new Set(paths).size !== paths.length) throw new Error('SKILL_CATALOG_RELEASE_INVALID');
    }
  }
  return result.data;
}

export function validateSkillSelection(input: {
  selection: SkillSelectionInput;
  definition: SkillDefinition;
  definitionHash: string;
  packageRecordId: string;
  planningResource: SkillResourceSelectionSnapshot;
  catalogReleaseId: string;
  catalogVersion: string;
  dependencySnapshots: Map<string, AuxiliarySkillSelectionSnapshot>;
  resourceSnapshots: Map<string, SkillResourceSelectionSnapshot>;
}): { snapshot: SkillSelectionSnapshot; hash: string } {
  const exactId = `${input.definition.slug}@${input.definition.version}`;
  if (input.selection.primary_skill_id !== exactId || input.definition.kind !== 'primary') {
    throw new Error('SKILL_SELECTION_INVALID');
  }
  const bySlot = new Map(input.definition.preset_slots.map((slot) => [slot.slot, slot]));
  const seen = new Set<string>();
  const presets = [...input.selection.preset_selections]
    .sort((left, right) => left.slot.localeCompare(right.slot))
    .map((selected) => {
      if (seen.has(selected.slot)) throw new Error('SKILL_SELECTION_INVALID');
      seen.add(selected.slot);
      const slot = bySlot.get(selected.slot);
      const option = slot?.options.find(
        (candidate) => candidate.preset_id === selected.preset_id && !candidate.disabled,
      );
      if (!slot || !option || slot.max_selections < 1) throw new Error('SKILL_SELECTION_INVALID');
      return {
        slot: selected.slot,
        preset_id: option.preset_id,
        name: option.name,
        resource_path: option.resource_path,
        resource_hash: option.resource_hash,
        resource_snapshot_id:
          input.resourceSnapshots.get(option.resource_path)?.resource_snapshot_id ?? '',
        package_resource_id:
          input.resourceSnapshots.get(option.resource_path)?.package_resource_id ?? '',
      };
    });
  if (presets.some((preset) => !preset.resource_snapshot_id || !preset.package_resource_id)) {
    throw new Error('SKILL_VERSION_DRIFT');
  }
  for (const slot of input.definition.preset_slots) {
    if (slot.required && !seen.has(slot.slot)) throw new Error('SKILL_SELECTION_REQUIRED');
  }
  const snapshot: SkillSelectionSnapshot = {
    primary_skill_id: exactId,
    primary_name: input.definition.display_name,
    primary_definition_hash: input.definitionHash,
    primary_package_record_id: input.packageRecordId,
    required_capabilities: [...new Set(input.definition.required_capabilities)].sort(),
    default_output_count: input.definition.default_output_count,
    ...(input.definition.execution_policy
      ? { execution_policy: input.definition.execution_policy }
      : {}),
    primary_planning_resource: input.planningResource,
    primary_reference_resources: input.definition.references.map((reference) => {
      const resource = input.resourceSnapshots.get(reference.path);
      if (!resource || resource.resource_hash !== reference.content_hash) {
        throw new Error('SKILL_VERSION_DRIFT');
      }
      return resource;
    }),
    catalog_release_id: input.catalogReleaseId,
    catalog_version: input.catalogVersion,
    preset_selections: presets,
    required_auxiliary: input.definition.dependencies
      .filter((item) => item.mode === 'required')
      .map((item) => input.dependencySnapshots.get(item.skill_id))
      .filter((item): item is AuxiliarySkillSelectionSnapshot => Boolean(item)),
    optional_auxiliary: input.definition.dependencies
      .filter((item) => item.mode === 'optional')
      .map((item) => input.dependencySnapshots.get(item.skill_id))
      .filter((item): item is AuxiliarySkillSelectionSnapshot => Boolean(item)),
  };
  if (
    snapshot.required_auxiliary.length + snapshot.optional_auxiliary.length !==
    input.definition.dependencies.length
  ) {
    throw new Error('SKILL_VERSION_DRIFT');
  }
  return { snapshot, hash: canonicalSha256(snapshot) };
}

export function assertSkillResourcePath(
  path: string,
  view: 'planning' | 'preset' | 'reference',
): string {
  if (
    path !== path.normalize('NFC') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes('..') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    /%[0-9a-f]{2}/i.test(path)
  ) {
    throw new Error('SKILL_RESOURCE_PATH_INVALID');
  }
  const pattern =
    view === 'planning'
      ? /^SKILL\.md$/
      : view === 'preset'
        ? /^presets\/[a-z0-9][a-z0-9-]*\.md$/
        : /^references\/[a-z0-9][a-z0-9-]*\.md$/;
  if (!pattern.test(path)) throw new Error('SKILL_RESOURCE_PATH_INVALID');
  return path;
}
