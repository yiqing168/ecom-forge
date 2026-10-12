import { z } from 'zod';

import { CapabilityRegistry } from './capability-registry.js';
import type { CapabilityAdapter } from './types.js';

const imageCandidateParamsSchema = z.strictObject({
  goal_summary: z.string().trim().min(1).max(500),
  creative_prompt: z.string().trim().min(1).max(128_000).optional(),
  aspect_ratio: z
    .string()
    .regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/)
    .optional(),
  output_count: z.int().min(1).max(16),
  output_count_source: z.enum(['user_explicit', 'skill_default']),
  semantic_summary: z.string().trim().min(1).max(500).optional(),
  creative_note: z.string().trim().min(1).max(600).optional(),
  changed_items: z.array(z.string().trim().min(1).max(120)).min(1).max(16).optional(),
  preserved_items: z.array(z.string().trim().min(1).max(120)).min(1).max(16).optional(),
});

function imageAdapter(operation: 'image.generate' | 'image.edit'): CapabilityAdapter {
  return {
    capability: operation,
    version: 1,
    allowedBindingKinds: ['asset', 'artifact'],
    compile(input) {
      const params = imageCandidateParamsSchema.safeParse(input.params);
      if (!params.success) return { ok: false, ruleId: 'image_candidate_params_invalid' };
      if (input.expectedOutput !== 'image') {
        return { ok: false, ruleId: 'image_expected_output_invalid' };
      }
      const preferences = input.generationPreferences;
      if (!preferences) return { ok: false, ruleId: 'generation_preferences_missing' };
      const resolvedAspectRatio =
        preferences.aspect_ratio === 'auto' ? params.data.aspect_ratio : preferences.aspect_ratio;
      if (!resolvedAspectRatio) {
        return { ok: false, ruleId: 'image_aspect_ratio_required_for_auto' };
      }
      if (
        preferences.aspect_ratio !== 'auto' &&
        params.data.aspect_ratio !== undefined &&
        params.data.aspect_ratio !== preferences.aspect_ratio
      ) {
        return { ok: false, ruleId: 'image_aspect_ratio_conflicts_with_preferences' };
      }
      if (input.bindings.some((binding) => binding.media_type !== 'image')) {
        return { ok: false, ruleId: 'image_binding_media_type_invalid' };
      }
      if (operation === 'image.generate' && input.bindings.length !== 0) {
        return { ok: false, ruleId: 'image_generate_binding_forbidden' };
      }
      if (operation === 'image.edit' && input.bindings.length === 0) {
        return { ok: false, ruleId: 'image_edit_binding_required' };
      }
      return {
        ok: true,
        paramsSnapshot: {
          schema_version: 1,
          operation,
          goal_summary: params.data.goal_summary,
          ...(params.data.creative_prompt ? { creative_prompt: params.data.creative_prompt } : {}),
          ...(params.data.creative_note ? { creative_note: params.data.creative_note } : {}),
          output_count: params.data.output_count,
          output_count_source: params.data.output_count_source,
          aspect_ratio: resolvedAspectRatio,
          resolution_tier: preferences.resolution_tier,
        },
        requirements: {
          outputType: 'image',
          outputCount: params.data.output_count,
          referenceImageCount: input.bindings.length,
          aspectRatio: resolvedAspectRatio,
          resolution: preferences.resolution_tier,
          operation: operation === 'image.generate' ? 'generate' : 'edit',
          mandatoryConfirmation: false,
        },
        quoteLabel: operation === 'image.generate' ? '图片生成' : '图片编辑',
      };
    },
  };
}

export const imageGenerateCapabilityAdapter = imageAdapter('image.generate');
export const imageEditCapabilityAdapter = imageAdapter('image.edit');
export const S12_IMAGE_CAPABILITY_REGISTRY_VERSION = 's12-image-v1' as const;

export function createImageCapabilityRegistry(): CapabilityRegistry {
  return new CapabilityRegistry(S12_IMAGE_CAPABILITY_REGISTRY_VERSION, [
    imageGenerateCapabilityAdapter,
    imageEditCapabilityAdapter,
  ]);
}
