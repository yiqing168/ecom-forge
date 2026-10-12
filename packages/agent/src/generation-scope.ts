import { z } from 'zod';

import { canonicalSha256 } from '@ecom-forge/shared';

export const imageSourceGroupSchema = z.strictObject({
  message_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true }),
  is_latest_upload: z.boolean(),
});

export const generationScopeDecisionSchema = z.strictObject({
  mode: z
    .enum(['latest_upload', 'conversation_reference'])
    .describe(
      'latest_upload selects only the latest upload group; conversation_reference selects the subject explicitly referred to in the conversation, possibly from an earlier group.',
    ),
  input_binding_keys: z.array(z.string().min(1).max(128)).max(32),
  output_count: z.int().min(1).max(512),
  reason_summary: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe(
      'Short evidence-based conclusion identifying the requested source group; not private reasoning or a claim that execution succeeded.',
    ),
});

type ScopePlan = {
  scope_decision?: z.infer<typeof generationScopeDecisionSchema> | undefined;
  nodes: ReadonlyArray<{
    input_bindings: readonly string[];
    expected_output?: string | undefined;
    params: Record<string, unknown>;
  }>;
};

type ScopeImage = {
  binding_key: string;
  candidate_kind?: 'latest_output' | 'original_source' | undefined;
  source_group?: z.infer<typeof imageSourceGroupSchema> | undefined;
};

export function crossUploadGroupScope(
  plan: ScopePlan,
  images: ReadonlyArray<ScopeImage>,
): { digest: string; groupCount: number; sourceCount: number; outputCount: number } | null {
  if (!plan.scope_decision) return null;
  const selected = [...new Set(plan.nodes.flatMap((node) => [...node.input_bindings]))].sort();
  const imageByKey = new Map(images.map((image) => [image.binding_key, image]));
  const groups = new Map<string, number>();
  for (const key of selected) {
    const group = imageByKey.get(key)?.source_group;
    if (!group) continue;
    groups.set(group.message_id, (groups.get(group.message_id) ?? 0) + 1);
  }
  if (groups.size < 2) return null;
  return {
    digest: canonicalSha256({
      schema_version: 1,
      selected_binding_keys: selected,
      output_count: plan.scope_decision.output_count,
    }),
    groupCount: groups.size,
    sourceCount: [...groups.values()].reduce((total, count) => total + count, 0),
    outputCount: plan.scope_decision.output_count,
  };
}

/** Validates declared scope, not the model's interpretation of natural language. */
export function validateGenerationScope(
  plan: ScopePlan,
  images: ReadonlyArray<ScopeImage>,
): string | null {
  const decision = plan.scope_decision;
  if (!decision) {
    return images.some((image) => image.source_group)
      ? 'Declare scope_decision for this conversation. Select the requested subject, not every available historical image.'
      : null;
  }
  const declared = new Set(decision.input_binding_keys);
  const selected = new Set(plan.nodes.flatMap((node) => [...node.input_bindings]));
  if (
    declared.size !== decision.input_binding_keys.length ||
    declared.size !== selected.size ||
    [...selected].some((key) => !declared.has(key))
  ) {
    return 'scope_decision.input_binding_keys must exactly match the unique node input bindings. Remove unintended nodes or correct the scope decision.';
  }
  const imageByKey = new Map(images.map((image) => [image.binding_key, image]));
  if ([...selected].some((key) => !imageByKey.has(key))) {
    return 'scope_decision references an unavailable image. Use only authorized binding keys.';
  }
  if (
    images.some((image) => image.source_group) &&
    [...selected].some((key) => {
      const image = imageByKey.get(key);
      return image?.candidate_kind === 'original_source' && !image.source_group;
    })
  ) {
    return 'A selected image is missing its upload-group provenance. Restore the source snapshot before planning.';
  }
  if (
    decision.mode === 'latest_upload' &&
    [...selected].some((key) => imageByKey.get(key)?.source_group?.is_latest_upload === false)
  ) {
    return 'latest_upload includes an earlier upload group. Exclude earlier images unless the user refers to them; then use conversation_reference and explain the requested subject.';
  }
  const counts = plan.nodes
    .filter((node) => node.expected_output !== 'text')
    .map((node) => node.params.output_count);
  if (
    counts.some((count) => typeof count !== 'number' || !Number.isInteger(count) || count < 1) ||
    counts.reduce<number>((total, count) => total + (count as number), 0) !== decision.output_count
  ) {
    return 'scope_decision.output_count must equal the sum of output_count across all image nodes. Count the whole plan, not each node separately.';
  }
  return null;
}
