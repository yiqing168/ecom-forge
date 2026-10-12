import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import { assertSkillResourcePath } from '@ecom-forge/skills';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(3).max(160);
const resource = z.strictObject({
  resource_snapshot_id: z.uuid(),
  package_resource_id: z.uuid(),
  resource_path: z.string().min(1).max(240),
  resource_hash: hash,
});
const selectedResource = resource.extend({
  skill_id: identity,
  name: z.string().min(1),
  definition_hash: hash,
  package_record_id: z.uuid(),
});

export const transcriptCoreSkillContextSchema = z.strictObject({
  schema_version: z.literal(1),
  selection_digest: hash,
  catalog_release_id: z.uuid(),
  catalog_version: hash,
  resources: z.array(selectedResource).min(1),
});

export const transcriptSkillDependencySchema = selectedResource.omit({ name: true }).extend({
  kind: z.literal('skill_resource'),
  catalog_release_id: z.uuid(),
  catalog_version: hash,
});

export type TranscriptCoreSkillContext = z.infer<typeof transcriptCoreSkillContextSchema>;
export type TranscriptSkillDependency = z.infer<typeof transcriptSkillDependencySchema>;

// This is a projection of the stored selection, not a replacement selection parser. Extra
// selection fields (optional auxiliary, capability list, output default) legitimately exist on
// real turns; they are ignored here rather than forbidden.
const coreSelection = z
  .object({
    primary_skill_id: identity,
    primary_name: z.string().min(1),
    primary_definition_hash: hash,
    primary_package_record_id: z.uuid(),
    primary_planning_resource: resource,
    catalog_release_id: z.uuid(),
    catalog_version: hash,
    preset_selections: z.array(
      resource.extend({ slot: z.string().min(1), preset_id: identity, name: z.string().min(1) }),
    ),
    required_auxiliary: z.array(
      // Plain object (not strict): real selections carry sibling fields such as
      // reference_resources, which the projection must strip instead of forwarding.
      z.object({
        skill_id: identity,
        name: z.string().min(1),
        definition_hash: hash,
        package_record_id: z.uuid(),
        planning_resource: resource,
      }),
    ),
  })
  .passthrough();

export function prepareTranscriptCoreSkillContext(input: unknown): TranscriptCoreSkillContext {
  const selection = coreSelection.parse(input);
  assertSkillResourcePath(selection.primary_planning_resource.resource_path, 'planning');
  const primary = {
    skill_id: selection.primary_skill_id,
    definition_hash: selection.primary_definition_hash,
    package_record_id: selection.primary_package_record_id,
  };
  return transcriptCoreSkillContextSchema.parse({
    schema_version: 1,
    selection_digest: canonicalSha256(input),
    catalog_release_id: selection.catalog_release_id,
    catalog_version: selection.catalog_version,
    resources: [
      { ...primary, name: selection.primary_name, ...selection.primary_planning_resource },
      ...selection.preset_selections.map((preset) => {
        assertSkillResourcePath(preset.resource_path, 'preset');
        return {
          ...primary,
          name: preset.name,
          resource_snapshot_id: preset.resource_snapshot_id,
          package_resource_id: preset.package_resource_id,
          resource_path: preset.resource_path,
          resource_hash: preset.resource_hash,
        };
      }),
      ...selection.required_auxiliary.map((auxiliary) => {
        assertSkillResourcePath(auxiliary.planning_resource.resource_path, 'planning');
        const { planning_resource: planning, ...selected } = auxiliary;
        return { ...selected, ...planning };
      }),
    ],
  });
}

export function transcriptCoreSkillDependencies(
  context: TranscriptCoreSkillContext,
): TranscriptSkillDependency[] {
  const dependencies = context.resources.map(({ name: _name, ...selected }) => ({
    kind: 'skill_resource' as const,
    catalog_release_id: context.catalog_release_id,
    catalog_version: context.catalog_version,
    ...selected,
  }));
  return [...new Map(dependencies.map((entry) => [canonicalJson(entry), entry])).values()];
}

/** The complete authorized inventory, including optional knowledge not loaded in the core. */
export function transcriptSelectionSkillDependencies(input: unknown): TranscriptSkillDependency[] {
  const auxiliary = coreSelection.shape.required_auxiliary.element.extend({
    reference_resources: z.array(resource),
  });
  const selection = coreSelection
    .extend({
      primary_reference_resources: z.array(resource),
      required_auxiliary: z.array(auxiliary),
      optional_auxiliary: z.array(auxiliary),
    })
    .parse(input);
  const context = prepareTranscriptCoreSkillContext(input);
  const dependencies = transcriptCoreSkillDependencies(context);
  const primary = context.resources[0]!;
  const additional = [
    ...selection.primary_reference_resources.map((entry) => ({ ...primary, ...entry })),
    ...[...selection.required_auxiliary, ...selection.optional_auxiliary].flatMap((entry) =>
      [entry.planning_resource, ...entry.reference_resources].map((resource) => ({
        skill_id: entry.skill_id,
        definition_hash: entry.definition_hash,
        package_record_id: entry.package_record_id,
        ...resource,
      })),
    ),
  ];
  for (const entry of additional) {
    dependencies.push(
      transcriptSkillDependencySchema.parse({
        kind: 'skill_resource',
        catalog_release_id: context.catalog_release_id,
        catalog_version: context.catalog_version,
        skill_id: entry.skill_id,
        definition_hash: entry.definition_hash,
        package_record_id: entry.package_record_id,
        resource_snapshot_id: entry.resource_snapshot_id,
        package_resource_id: entry.package_resource_id,
        resource_path: entry.resource_path,
        resource_hash: entry.resource_hash,
      }),
    );
  }
  return [...new Map(dependencies.map((entry) => [canonicalJson(entry), entry])).values()];
}
