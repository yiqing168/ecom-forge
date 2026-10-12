import { describe, expect, it } from 'vitest';

import {
  imageEditCapabilityAdapter,
  imageGenerateCapabilityAdapter,
} from './image-capabilities.js';

const preferences = {
  schema_version: 2 as const,
  output_kind: 'image' as const,
  aspect_ratio: '1:1',
  resolution_tier: '2k' as const,
};

const imageBinding = {
  binding_key: 'asset-1',
  kind: 'asset' as const,
  object_id: '11111111-1111-4111-8111-111111111111',
  object_version: 'hash-v1',
  content_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  owner_user_id: '22222222-2222-4222-8222-222222222222',
  readable: true,
  mutable: false,
  producer_mode: null,
  producer_session_id: null,
  mutation_owner: null,
  source_action: null,
  media_type: 'image' as const,
  lifecycle: 'active' as const,
  visibility: 'private' as const,
};

const goal = {
  goal_summary: '生成一张突出商品轮廓的主图',
  output_count: 2,
  output_count_source: 'user_explicit' as const,
};

describe('S12 image capability adapters', () => {
  it('takes preferences from the trusted turn context', () => {
    const result = imageGenerateCapabilityAdapter.compile({
      params: goal,
      bindings: [],
      expectedOutput: 'image',
      generationPreferences: preferences,
    });

    expect(result).toMatchObject({
      ok: true,
      paramsSnapshot: {
        aspect_ratio: '1:1',
        resolution_tier: '2k',
        output_count: 2,
      },
      requirements: { outputCount: 2, referenceImageCount: 0 },
    });
  });

  it('freezes a Brain-selected concrete ratio when the user chooses auto', () => {
    const result = imageGenerateCapabilityAdapter.compile({
      params: { ...goal, aspect_ratio: '3:4' },
      bindings: [],
      expectedOutput: 'image',
      generationPreferences: { ...preferences, aspect_ratio: 'auto' },
    });

    expect(result).toMatchObject({
      ok: true,
      paramsSnapshot: { aspect_ratio: '3:4' },
      requirements: { aspectRatio: '3:4' },
    });
  });

  it('rejects auto without a concrete node ratio and rejects fixed-ratio conflicts', () => {
    expect(
      imageGenerateCapabilityAdapter.compile({
        params: goal,
        bindings: [],
        expectedOutput: 'image',
        generationPreferences: { ...preferences, aspect_ratio: 'auto' },
      }),
    ).toEqual({ ok: false, ruleId: 'image_aspect_ratio_required_for_auto' });

    expect(
      imageGenerateCapabilityAdapter.compile({
        params: { ...goal, aspect_ratio: '16:9' },
        bindings: [],
        expectedOutput: 'image',
        generationPreferences: preferences,
      }),
    ).toEqual({ ok: false, ruleId: 'image_aspect_ratio_conflicts_with_preferences' });
  });

  it('keeps semantic audit context out of executable image task params', () => {
    const result = imageEditCapabilityAdapter.compile({
      params: {
        ...goal,
        semantic_summary: '保留人物与建筑之间可观察的空间关系。',
        creative_prompt: 'Rebuild the scene as a new authored composition.',
        creative_note: '以人物和建筑的距离为命题，用断续边缘重新组织观看路径。',
      },
      bindings: [imageBinding],
      expectedOutput: 'image',
      generationPreferences: preferences,
    });

    expect(result).toMatchObject({
      ok: true,
      paramsSnapshot: {
        creative_prompt: 'Rebuild the scene as a new authored composition.',
        creative_note: '以人物和建筑的距离为命题，用断续边缘重新组织观看路径。',
      },
    });
    if (!result.ok) throw new Error('Expected image edit compilation to succeed');
    expect(result.paramsSnapshot).not.toHaveProperty('semantic_summary');
    expect(result.paramsSnapshot).not.toHaveProperty('xieyi_structure');
  });

  it.each([
    ['candidate model fields', { ...goal, model_id: 'attacker-model' }],
    ['candidate provider fields', { ...goal, endpoint: 'https://attacker.invalid' }],
    ['candidate provider params', { ...goal, prompt: 'unbounded prompt' }],
    [
      'obsolete Skill-specific audit fields',
      { ...goal, xieyi_structure: { structural_change: 'scale_shift' } },
    ],
  ])('rejects %s', (_label, params) => {
    expect(
      imageGenerateCapabilityAdapter.compile({
        params,
        bindings: [],
        expectedOutput: 'image',
        generationPreferences: preferences,
      }),
    ).toEqual({ ok: false, ruleId: 'image_candidate_params_invalid' });
  });

  it('rejects generate bindings and requires an input for edit', () => {
    expect(
      imageGenerateCapabilityAdapter.compile({
        params: goal,
        bindings: [imageBinding],
        expectedOutput: 'image',
        generationPreferences: preferences,
      }),
    ).toEqual({ ok: false, ruleId: 'image_generate_binding_forbidden' });
    expect(
      imageEditCapabilityAdapter.compile({
        params: goal,
        bindings: [],
        expectedOutput: 'image',
        generationPreferences: preferences,
      }),
    ).toEqual({ ok: false, ruleId: 'image_edit_binding_required' });
  });

  it('rejects missing preferences and non-image inputs', () => {
    expect(
      imageGenerateCapabilityAdapter.compile({
        params: goal,
        bindings: [],
        expectedOutput: 'image',
      }),
    ).toEqual({ ok: false, ruleId: 'generation_preferences_missing' });
    expect(
      imageEditCapabilityAdapter.compile({
        params: goal,
        bindings: [{ ...imageBinding, media_type: 'text' }],
        expectedOutput: 'image',
        generationPreferences: preferences,
      }),
    ).toEqual({ ok: false, ruleId: 'image_binding_media_type_invalid' });
  });
});
