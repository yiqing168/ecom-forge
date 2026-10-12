import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalSha256,
  parseSkillExecutionPolicy,
  SKILL_EXECUTION_FAMILIES,
  SKILL_IMAGE_ROLES,
  type SkillExecutionPolicy,
} from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';

import type { BindingSnapshot, CandidatePlan } from './types.js';
import {
  resolveCreativeExecutionProfile as resolveDeclaredProfile,
  validateCreativeExecutionProfile,
  creativeExecutionProfileSchema,
} from './creative-profiles.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

describe('S13A creative execution profiles', () => {
  it('uses the shared execution-family and image-role vocabulary in its schemas', () => {
    const original = resolveDeclaredProfile({
      primarySkillId: 'brand-new-method@1.0.0',
      intent: 'creative_generate',
      executionPolicy: { version: 1, family: 'text_generation', max_sources: 9 },
    })!;
    for (const family of [...SKILL_EXECUTION_FAMILIES, 'chat_artifact_edit']) {
      expect(
        creativeExecutionProfileSchema.safeParse({ ...original, profile_id: family }).success,
      ).toBe(true);
    }
    for (const role of SKILL_IMAGE_ROLES) {
      expect(
        creativeExecutionProfileSchema.safeParse({
          ...original,
          allowed_binding_roles: [role],
          provider_binding_roles: [role],
        }).success,
      ).toBe(true);
    }
    expect(
      creativeExecutionProfileSchema.safeParse({ ...original, profile_id: 'unknown' }).success,
    ).toBe(false);
    expect(
      creativeExecutionProfileSchema.safeParse({ ...original, allowed_binding_roles: ['unknown'] })
        .success,
    ).toBe(false);
  });
  it('rejects self-rehashed constraints that diverge from the declared policy', () => {
    const source = binding({ role: 'semantic_reference' });
    const candidate = sceneBatchCandidate([source]);
    const original = resolveDeclaredProfile({
      primarySkillId: candidate.skill_id,
      intent: candidate.intent.kind,
      executionPolicy: { version: 1, family: 'independent_sources', max_sources: 9 },
    })!;
    const { profile_digest, ...unsigned } = original;
    expect(canonicalSha256(unsigned)).toBe(profile_digest);
    const modified = { ...unsigned, provider_binding_roles: ['identity_anchor' as const] };
    expect(
      validateCreativeExecutionProfile({
        profile: { ...modified, profile_digest: canonicalSha256(modified) },
        candidate,
        bindings: [source],
      }),
    ).toMatchObject({ ok: false, ruleId: 'creative_profile_policy_mismatch' });
  });
  it('routes an unfamiliar Skill by its declared policy, never its name', () => {
    expect(
      resolveDeclaredProfile({
        primarySkillId: 'brand-new-method@1.0.0',
        intent: 'raw_asset_generate',
        executionPolicy: { version: 1, family: 'independent_sources', max_sources: 3 },
      }),
    ).toMatchObject({ profile_id: 'independent_sources', constraints: { max_context_images: 3 } });
    expect(
      resolveDeclaredProfile({
        primarySkillId: 'void-line-poster@1.1.0',
        intent: 'raw_asset_generate',
      }),
    ).toBeNull();
    expect(
      resolveDeclaredProfile({
        primarySkillId: 'brand-new-method@1.0.0',
        intent: 'creative_generate',
        executionPolicy: { version: 1, family: 'independent_sources', max_sources: 3 },
      }),
    ).toBeNull();
  });
  it('routes watercolor posters through source-photo edits and same-session revisions', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'watercolor-scene-collage@1.0.0',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'independent_sources',
      capability: 'image.edit',
      provider_binding_roles: ['semantic_reference'],
      constraints: { semantic_reference_minimum: 1, preserve_original_pixels: false },
    });
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'watercolor-scene-collage@1.0.0',
        intent: 'chat_artifact_edit',
      }),
    ).toMatchObject({ profile_id: 'chat_artifact_edit', capability: 'image.edit' });
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'watercolor-scene-collage@1.0.0',
        intent: 'creative_generate',
      }),
    ).toBeNull();
  });

  it('keeps two watercolor photos and their authored prompts isolated', () => {
    const sources = [
      binding({ binding_key: 'watercolor-1', role: 'semantic_reference' }),
      binding({
        binding_key: 'watercolor-2',
        object_id: '10000000-0000-4000-8000-000000000002',
        role: 'semantic_reference',
      }),
    ];
    const candidate = sceneBatchCandidate(sources);
    candidate.skill_id = 'watercolor-scene-collage@1.0.0';
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: candidate.skill_id,
      intent: 'raw_asset_generate',
    })!;
    const run = () => validateCreativeExecutionProfile({ profile, candidate, bindings: sources });
    expect(run()).toMatchObject({
      ok: true,
      nodes: {
        'scene-1': {
          providerBindings: [sources[0]],
          constraintsSnapshot: { profile_id: 'independent_sources' },
        },
        'scene-2': { providerBindings: [sources[1]] },
      },
    });
    candidate.nodes[1]!.input_bindings = [sources[0]!.binding_key];
    expect(run()).toMatchObject({ ok: false, ruleId: 'creative_profile_scene_source_reused' });
    candidate.nodes[1]!.input_bindings = [sources[1]!.binding_key];
    candidate.nodes[1]!.params.creative_prompt = candidate.nodes[0]!.params.creative_prompt;
    expect(run()).toMatchObject({ ok: false, ruleId: 'creative_profile_scene_prompt_reused' });
  });

  it.each([
    {
      label: 'missing source',
      sources: [],
      ruleId: 'creative_profile_scene_one_source_per_node_required',
    },
    {
      label: 'mixed photos',
      sources: [
        binding({ binding_key: 'source-a', role: 'semantic_reference' }),
        binding({ binding_key: 'source-b', role: 'semantic_reference' }),
      ],
      ruleId: 'creative_profile_scene_one_source_per_node_required',
    },
    {
      label: 'style-only reference',
      sources: [binding({ role: 'style_reference' })],
      ruleId: 'creative_profile_binding_role_invalid',
    },
  ])('rejects watercolor $label', ({ sources, ruleId }) => {
    expect(
      validate('watercolor-scene-collage@1.0.0', 'raw_asset_generate', {
        bindings: sources,
        capability: 'image.edit',
        params: {
          goal_summary: 'Create a photo-watercolor comparison.',
          semantic_summary: 'The corner building is the source scene.',
          creative_prompt:
            'Use the corner photo above a small watercolor version of the same facade.',
          output_count: 1,
        },
      }),
    ).toMatchObject({ ok: false, ruleId });
  });

  it('requires one watercolor output and an authored source-specific prompt', () => {
    const source = binding({ role: 'semantic_reference' });
    const params = {
      goal_summary: 'Create a watercolor comparison.',
      semantic_summary: 'The river bends behind the near bridge.',
      creative_prompt: 'Keep the river photo above a miniature watercolor of its bridge and bend.',
      output_count: 1,
    };
    for (const invalid of [
      { ...params, output_count: 2 },
      { ...params, creative_prompt: undefined },
    ]) {
      expect(
        validate('watercolor-scene-collage@1.0.0', 'raw_asset_generate', {
          bindings: [source],
          capability: 'image.edit',
          params: invalid,
        }),
      ).toMatchObject({ ok: false, ruleId: 'creative_profile_prompt_required' });
    }
  });

  it('uses the supplied policy with any recorded version', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'creative-scene-reimagining@9.9.9',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'independent_sources',
      primary_skill_id: 'creative-scene-reimagining@9.9.9',
      capability: 'image.edit',
    });
  });

  it('routes a declared independent-source Skill through the shared edit profile', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'creative-scene-collage@1.1.1',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'independent_sources',
      primary_skill_id: 'creative-scene-collage@1.1.1',
      capability: 'image.edit',
      provider_binding_roles: ['semantic_reference'],
      constraints: {
        semantic_reference_minimum: 1,
        preserve_original_pixels: false,
      },
    });
  });

  it('routes another independent-source Skill through the same shared edit profile', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'xieyi-scene-collage@1.0.0',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'independent_sources',
      primary_skill_id: 'xieyi-scene-collage@1.0.0',
      capability: 'image.edit',
      provider_binding_roles: ['semantic_reference'],
      constraints: {
        semantic_reference_minimum: 1,
        preserve_original_pixels: false,
      },
    });
  });

  it('routes minimal scene collage through its own semantic-reference profile', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'minimal-scene-collage@2.8.0',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'independent_sources',
      primary_skill_id: 'minimal-scene-collage@2.8.0',
      capability: 'image.edit',
      provider_binding_roles: ['semantic_reference'],
      constraints: {
        semantic_reference_minimum: 1,
        preserve_original_pixels: false,
      },
    });
  });

  it('routes void line posters through their own semantic-reference profile', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'void-line-poster@1.1.0',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'independent_sources',
      primary_skill_id: 'void-line-poster@1.1.0',
      capability: 'image.edit',
      provider_binding_roles: ['semantic_reference'],
      constraints: {
        semantic_reference_minimum: 1,
        preserve_original_pixels: false,
      },
    });
  });

  it('routes daily memory pages through a source-isolated semantic-reference profile', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'daily-memory-page@1.1.0',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'independent_sources',
      primary_skill_id: 'daily-memory-page@1.1.0',
      capability: 'image.edit',
      provider_binding_roles: ['semantic_reference'],
      constraints: {
        semantic_reference_minimum: 1,
        preserve_original_pixels: false,
      },
    });
  });

  it('routes cinematic story posters through generate and reference-edit profiles', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'cinematic-story-poster@1.1.0',
        intent: 'creative_generate',
      }),
    ).toMatchObject({
      profile_id: 'optional_references',
      capability: 'image.generate',
      provider_binding_roles: [],
    });
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'cinematic-story-poster@1.1.0',
        intent: 'raw_asset_generate',
      }),
    ).toMatchObject({
      profile_id: 'optional_references',
      capability: 'image.edit',
      provider_binding_roles: [
        'semantic_reference',
        'style_reference',
        'composition_reference',
        'other',
      ],
      constraints: { min_context_images: 1, preserve_original_pixels: false },
    });
  });

  it('keeps cinematic story posters in one provider-ready node and preserves output count', () => {
    const prompt =
      'Create one original 9:16 key visual around a divided table as the only motif. Render the exact title "TABLE SIDES" and no other text.';
    const generated = validate('cinematic-story-poster@1.1.0', 'creative_generate', {
      bindings: [],
      capability: 'image.generate',
      params: {
        goal_summary: 'Create an original film poster.',
        creative_prompt: prompt,
        output_count: 1,
      },
    });
    expect(generated).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          providerBindings: [],
          constraintsSnapshot: { profile_id: 'optional_references' },
        },
      },
    });

    const still = binding({ role: 'semantic_reference' });
    const edited = validate('cinematic-story-poster@1.1.0', 'raw_asset_generate', {
      bindings: [still],
      capability: 'image.edit',
      params: {
        goal_summary: 'Use the authorized still.',
        creative_prompt: prompt,
        output_count: 1,
      },
    });
    expect(edited).toMatchObject({
      ok: true,
      nodes: { 'image-main': { providerBindings: [still] } },
    });

    expect(
      validate('cinematic-story-poster@1.1.0', 'creative_generate', {
        bindings: [],
        capability: 'image.generate',
        params: { goal_summary: 'Create two posters.', creative_prompt: prompt, output_count: 2 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      validate('cinematic-story-poster@1.1.0', 'raw_asset_generate', {
        bindings: [still],
        capability: 'image.edit',
        params: { goal_summary: 'Use the authorized still.', output_count: 1 },
      }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_poster_prompt_required' });
  });

  it('keeps one to six social contrast references in one provider-ready poster node', () => {
    const sources = Array.from({ length: 6 }, (_, index) =>
      binding({
        binding_key: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        object_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        role: 'semantic_reference',
        position: index,
      }),
    );
    const prompt =
      'Create one 3:4 social poster around a single contrast between a delayed breakfast and a calm system notice. Preserve the source people and objects, redact private text, and render one restrained original title.';
    const accepted = validate('social-contrast-poster@1.1.0', 'raw_asset_generate', {
      bindings: sources,
      capability: 'image.edit',
      params: {
        goal_summary: 'Use the selected daily-life evidence for one contrast poster.',
        creative_prompt: prompt,
        output_count: 1,
      },
    });

    expect(accepted).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          contextBindings: sources,
          providerBindings: sources,
          constraintsSnapshot: {
            profile_id: 'reference_composition',
            preserve_original_pixels: false,
          },
        },
      },
    });

    const seventh = binding({
      binding_key: '00000000-0000-4000-8000-000000000007',
      object_id: '10000000-0000-4000-8000-000000000007',
      role: 'semantic_reference',
      position: 6,
    });
    expect(
      validate('social-contrast-poster@1.1.0', 'raw_asset_generate', {
        bindings: [],
        capability: 'image.edit',
        params: { goal_summary: 'Create one poster.', creative_prompt: prompt, output_count: 1 },
      }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_reference_count_invalid' });
    expect(
      validate('social-contrast-poster@1.1.0', 'raw_asset_generate', {
        bindings: [...sources, seventh],
        capability: 'image.edit',
        params: { goal_summary: 'Use all sources.', creative_prompt: prompt, output_count: 1 },
      }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_reference_count_invalid' });
    expect(
      validate('social-contrast-poster@1.1.0', 'raw_asset_generate', {
        bindings: [binding({ role: 'style_reference' })],
        capability: 'image.edit',
        params: { goal_summary: 'Use this source.', creative_prompt: prompt, output_count: 1 },
      }),
    ).toEqual({
      ok: false,
      ruleId: 'creative_profile_binding_role_invalid',
      bindingKey: '44444444-4444-4444-8444-444444444444',
    });
    expect(
      validate('social-contrast-poster@1.1.0', 'raw_asset_generate', {
        bindings: [sources[0]!],
        capability: 'image.edit',
        params: { goal_summary: 'Use this source.', output_count: 1 },
      }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_poster_prompt_required' });
    expect(
      validate('social-contrast-poster@1.1.0', 'raw_asset_generate', {
        bindings: [sources[0]!],
        capability: 'image.edit',
        params: { goal_summary: 'Use this source.', creative_prompt: prompt, output_count: 2 },
      }),
    ).toMatchObject({ ok: true });

    const profile = resolveCreativeExecutionProfile({
      primarySkillId: 'social-contrast-poster@1.1.0',
      intent: 'raw_asset_generate',
    })!;
    const twoNodes: CandidatePlan = {
      schema_version: 1,
      intent: { kind: 'raw_asset_generate', confidence: 0.99 },
      skill_id: 'social-contrast-poster@1.1.0',
      source: 'chat',
      nodes: [
        {
          candidate_key: 'poster-1',
          capability: 'image.edit',
          capability_version: 1,
          depends_on: [],
          input_bindings: [sources[0]!.binding_key],
          params: { goal_summary: 'First.', creative_prompt: prompt, output_count: 1 },
          expected_output: 'image',
        },
        {
          candidate_key: 'poster-2',
          capability: 'image.edit',
          capability_version: 1,
          depends_on: [],
          input_bindings: [sources[1]!.binding_key],
          params: { goal_summary: 'Second.', creative_prompt: prompt, output_count: 1 },
          expected_output: 'image',
        },
      ],
    };
    expect(
      validateCreativeExecutionProfile({ profile, candidate: twoNodes, bindings: sources }),
    ).toEqual({
      ok: false,
      ruleId: 'creative_profile_single_image_node_required',
    });
  });

  it('keeps free-generation references in lineage but out of Provider inputs', () => {
    const reference = binding({ role: 'style_reference' });
    const result = validate('creative-free-generation@1.0.1', 'creative_generate', {
      bindings: [reference],
      capability: 'image.generate',
      params: { goal_summary: '围绕参考图的配色建立原创构图' },
    });
    expect(result).toMatchObject({
      ok: true,
      nodes: { 'image-main': { contextBindings: [reference], providerBindings: [] } },
    });
  });

  it('requires exactly one identity anchor for portrait renewal', () => {
    const result = validate('creative-portrait-renewal@1.0.0', 'raw_asset_generate', {
      bindings: [binding({ role: 'style_reference' })],
      capability: 'image.edit',
      params: { goal_summary: '改善人物照片的光线和构图' },
    });
    expect(result).toEqual({ ok: false, ruleId: 'creative_profile_required_role_invalid' });
  });

  it('rejects missing, forbidden, and unknown portrait changes', () => {
    const identity = binding({ role: 'identity_anchor' });
    const base = {
      bindings: [identity],
      capability: 'image.edit' as const,
    };
    expect(
      validate('creative-portrait-renewal@1.0.0', 'raw_asset_generate', {
        ...base,
        params: { goal_summary: 'Improve this authorized portrait.' },
      }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_changed_items_required' });
    expect(
      validate('creative-portrait-renewal@1.0.0', 'raw_asset_generate', {
        ...base,
        params: { goal_summary: 'Swap the face.', changed_items: ['face_swap'] },
      }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_change_forbidden' });
    expect(
      validate('creative-portrait-renewal@1.0.0', 'raw_asset_generate', {
        ...base,
        params: { goal_summary: 'Change the hairstyle.', changed_items: ['hairstyle'] },
      }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_change_not_allowed' });
  });

  it('accepts only canonical allowed portrait changes and forwards declared Provider bindings', () => {
    const identity = binding({ role: 'identity_anchor' });
    const result = validate('creative-portrait-renewal@1.0.0', 'raw_asset_generate', {
      bindings: [identity],
      capability: 'image.edit',
      params: {
        goal_summary: 'Improve lighting and clean up the background.',
        changed_items: ['lighting', 'background_cleanup'],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          providerBindings: [identity],
          constraintsSnapshot: { changed_items: ['lighting', 'background_cleanup'] },
        },
      },
    });
  });

  it('requires a final prompt and forwards one scene source as semantic evidence', () => {
    const source = binding({ role: 'semantic_reference' });
    const missing = validate('creative-scene-reimagining@1.2.0', 'raw_asset_generate', {
      bindings: [source],
      capability: 'image.edit',
      params: { goal_summary: '把照片重绘成新的视觉世界', output_count: 1 },
    });
    expect(missing).toEqual({
      ok: false,
      ruleId: 'creative_profile_prompt_required',
    });
    const accepted = validate('creative-scene-reimagining@1.2.0', 'raw_asset_generate', {
      bindings: [source],
      capability: 'image.edit',
      params: {
        goal_summary: '把照片重绘成新的视觉世界',
        output_count: 1,
        semantic_summary: '保留两个人隔窗对望的关系，建立全新空间和观看位置。',
        creative_prompt:
          'Use the source relationship as evidence, then build a new composition with a painterly spatial tension.',
        creative_note:
          '让隔窗对望成为画面的核心命题。通过错开的空间层次和断续边缘，让两个人既靠近又无法真正抵达。',
      },
    });
    expect(accepted).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          providerBindings: [source],
          constraintsSnapshot: {
            preserve_original_pixels: false,
            semantic_summary: '保留两个人隔窗对望的关系，建立全新空间和观看位置。',
          },
        },
      },
    });
  });

  it('requires a photo-specific prompt for scene collage', () => {
    const source = binding({ role: 'semantic_reference' });
    const accepted = validate('creative-scene-collage@1.1.1', 'raw_asset_generate', {
      bindings: [source],
      capability: 'image.edit',
      params: {
        goal_summary: '把这张海边照片做成实景拼贴',
        output_count: 1,
        semantic_summary: '保留右侧礁石、低地平线和向远处收束的海岸关系。',
        creative_prompt:
          'Keep the coast as a truthful photographic anchor and extend its shoreline into a quiet abstract print field with one structural cobalt hue and a fibrous torn-paper handoff.',
        creative_note: '让海岸线越过撕纸边界，成为连接真实礁石与空纸插画场的主动作。',
      },
    });
    expect(accepted).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          providerBindings: [source],
          constraintsSnapshot: {
            profile_id: 'independent_sources',
            preserve_original_pixels: false,
          },
        },
      },
    });

    const withoutDisplayNote = sceneBatchCandidate([source]);
    withoutDisplayNote.skill_id = 'creative-scene-collage@1.4.2';
    delete withoutDisplayNote.nodes[0]!.params.creative_note;
    expect(
      validateCreativeExecutionProfile({
        profile: resolveCreativeExecutionProfile({
          primarySkillId: 'creative-scene-collage@1.4.2',
          intent: 'raw_asset_generate',
        })!,
        candidate: withoutDisplayNote,
        bindings: [source],
      }),
    ).toMatchObject({ ok: true });
  });

  it('requires one source-specific final prompt for a daily memory page', () => {
    const source = binding({ role: 'semantic_reference' });
    const accepted = validate('daily-memory-page@1.1.0', 'raw_asset_generate', {
      bindings: [source],
      capability: 'image.edit',
      params: {
        goal_summary: '把窗边蜷着的猫做成日常记忆页',
        output_count: 1,
        semantic_summary: '保留猫蜷起的姿态、窗边位置和午后光落在被子上的关系。',
        creative_prompt:
          'Repaint the curled cat in the lower-left as one compact colored-pencil field, keep a continuous cool-white blank field above and to the right, preserve one pale-gold light patch, remove room clutter, repeated textile detail, and all visible text.',
      },
    });

    expect(accepted).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          providerBindings: [source],
          constraintsSnapshot: {
            profile_id: 'independent_sources',
            preserve_original_pixels: false,
          },
        },
      },
    });
  });

  it('keeps multiple scene-collage sources in independent one-to-one nodes', () => {
    const sources = [
      binding({ binding_key: 'collage-source-1', role: 'semantic_reference' }),
      binding({
        binding_key: 'collage-source-2',
        object_id: '66666666-6666-4666-8666-666666666666',
        role: 'semantic_reference',
      }),
    ];
    const candidate = sceneBatchCandidate(sources);
    candidate.skill_id = 'creative-scene-collage@1.1.1';
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: candidate.skill_id,
      intent: candidate.intent.kind,
    })!;

    const result = validateCreativeExecutionProfile({ profile, candidate, bindings: sources });
    expect(result).toMatchObject({
      ok: true,
      nodes: {
        'scene-1': { providerBindings: [sources[0]] },
        'scene-2': { providerBindings: [sources[1]] },
      },
    });
  });

  it('accepts nine scene sources only as nine independent one-to-one nodes', () => {
    const sources = Array.from({ length: 9 }, (_, index) =>
      binding({
        binding_key: `source-${index + 1}`,
        object_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        role: 'semantic_reference',
      }),
    );
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: 'creative-scene-reimagining@1.2.0',
      intent: 'raw_asset_generate',
    })!;
    const candidate = sceneBatchCandidate(sources);
    const result = validateCreativeExecutionProfile({ profile, candidate, bindings: sources });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.nodes)).toHaveLength(9);
    for (const [index, source] of sources.entries()) {
      expect(result.nodes[`scene-${index + 1}`]).toMatchObject({
        contextBindings: [source],
        providerBindings: [source],
      });
    }
  });

  it('rejects reusing one prompt across different scene sources', () => {
    const first = binding({ binding_key: 'source-1', role: 'semantic_reference' });
    const second = binding({
      binding_key: 'source-2',
      object_id: '66666666-6666-4666-8666-666666666666',
      role: 'semantic_reference',
    });
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: 'creative-scene-reimagining@1.2.0',
      intent: 'raw_asset_generate',
    })!;
    const candidate = sceneBatchCandidate([first, second]);
    candidate.nodes[1]!.params.creative_prompt = candidate.nodes[0]!.params.creative_prompt;
    expect(
      validateCreativeExecutionProfile({ profile, candidate, bindings: [first, second] }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_scene_prompt_reused' });
  });

  it('rejects reusing one creation note across different scene sources', () => {
    const first = binding({ binding_key: 'source-1', role: 'semantic_reference' });
    const second = binding({
      binding_key: 'source-2',
      object_id: '66666666-6666-4666-8666-666666666666',
      role: 'semantic_reference',
    });
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: 'creative-scene-reimagining@1.2.0',
      intent: 'raw_asset_generate',
    })!;
    const candidate = sceneBatchCandidate([first, second]);
    candidate.nodes[1]!.params.creative_note = candidate.nodes[0]!.params.creative_note;
    expect(
      validateCreativeExecutionProfile({ profile, candidate, bindings: [first, second] }),
    ).toEqual({ ok: false, ruleId: 'creative_profile_scene_note_reused' });
  });

  it('accepts a selected scene source from a larger candidate pool and rejects invalid selection', () => {
    const first = binding({ binding_key: 'source-1', role: 'semantic_reference' });
    const second = binding({
      binding_key: 'source-2',
      object_id: '66666666-6666-4666-8666-666666666666',
      role: 'semantic_reference',
    });
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: 'creative-scene-reimagining@1.2.0',
      intent: 'raw_asset_generate',
    })!;
    const selected = sceneBatchCandidate([first]);
    expect(
      validateCreativeExecutionProfile({ profile, candidate: selected, bindings: [first, second] }),
    ).toMatchObject({
      ok: true,
      nodes: { 'scene-1': { contextBindings: [first], providerBindings: [first] } },
    });

    const reused = sceneBatchCandidate([first, first]);
    expect(
      validateCreativeExecutionProfile({ profile, candidate: reused, bindings: [first, second] }),
    ).toMatchObject({ ok: false, ruleId: 'creative_profile_scene_source_reused' });

    const mixed = sceneBatchCandidate([first]);
    mixed.nodes[0]!.input_bindings = [first.binding_key, second.binding_key];
    expect(
      validateCreativeExecutionProfile({ profile, candidate: mixed, bindings: [first, second] }),
    ).toMatchObject({ ok: false, ruleId: 'creative_profile_scene_one_source_per_node_required' });
  });

  it('accepts one published current-session parent and freezes its revision', () => {
    const parent = binding({
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 3,
    });
    const result = validate('creative-free-generation@1.0.1', 'chat_artifact_edit', {
      bindings: [parent],
      capability: 'image.edit',
      params: {
        goal_summary: '把背景改得更简洁',
        changed_items: ['背景'],
        preserved_items: ['主体', '构图重心'],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          providerBindings: [parent],
          constraintsSnapshot: {
            parent_artifact_id: parent.object_id,
            parent_artifact_version: parent.object_version,
            parent_publication_revision: 3,
          },
        },
      },
    });
  });

  it('validates only the Brain-selected parent from a session candidate pool', () => {
    const selectedParent = binding({
      binding_key: 'session-output-2',
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 4,
      candidate_kind: 'latest_output',
      candidate_position: 2,
      lineage_source_binding_keys: ['session-source-2'],
    });
    const unselectedParent = binding({
      binding_key: 'session-output-1',
      object_id: '77777777-7777-4777-8777-777777777777',
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 2,
      candidate_kind: 'latest_output',
      candidate_position: 1,
      lineage_source_binding_keys: ['session-source-1'],
    });
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: 'creative-scene-reimagining@1.3.1',
      intent: 'chat_artifact_edit',
    })!;
    const candidate: CandidatePlan = {
      schema_version: 1,
      intent: { kind: 'chat_artifact_edit', confidence: 0.99 },
      skill_id: 'creative-scene-reimagining@1.3.1',
      source: 'chat',
      source_decision: {
        mode: 'refine_latest',
        output_binding_key: selectedParent.binding_key,
        reason_summary: '当前成图仍保留完成留白调整所需的主体和构图证据。',
      },
      nodes: [
        {
          candidate_key: 'edit-second',
          capability: 'image.edit',
          capability_version: 1,
          depends_on: [],
          input_bindings: [selectedParent.binding_key],
          params: {
            goal_summary: '继续修改第二张',
            creative_prompt: 'Reduce the empty space while preserving the main visual thesis.',
            output_count: 1,
            output_count_source: 'skill_default',
            changed_items: ['留白比例'],
            preserved_items: ['主体关系', '主要媒介语言'],
          },
          expected_output: 'image',
        },
      ],
    };

    const result = validateCreativeExecutionProfile({
      profile,
      candidate,
      bindings: [unselectedParent, selectedParent],
    });
    expect(result).toMatchObject({
      ok: true,
      nodes: {
        'edit-second': {
          contextBindings: [selectedParent],
          providerBindings: [selectedParent],
          constraintsSnapshot: { parent_publication_revision: 4 },
        },
      },
    });
  });

  it('accepts a Brain decision to restart from the linked original source', () => {
    const original = binding({
      binding_key: 'session-source-1',
      role: 'semantic_reference',
      candidate_kind: 'original_source',
      candidate_position: 1,
      lineage_source_binding_keys: [],
    });
    const output = binding({
      binding_key: 'session-output-1',
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 3,
      candidate_kind: 'latest_output',
      candidate_position: 1,
      lineage_source_binding_keys: [original.binding_key],
    });
    const candidate = sceneBatchCandidate([original]);
    candidate.source_decision = {
      mode: 'restart_original',
      output_binding_key: output.binding_key,
      original_source_binding_key: original.binding_key,
      reason_summary: '当前成图已丢失恢复地点辨识度所需的建筑和空间证据。',
    };
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: candidate.skill_id,
      intent: candidate.intent.kind,
    })!;

    expect(
      validateCreativeExecutionProfile({ profile, candidate, bindings: [output, original] }),
    ).toMatchObject({
      ok: true,
      nodes: {
        'scene-1': {
          contextBindings: [original],
          providerBindings: [original],
        },
      },
    });
  });

  it('accepts only authorized original sources when the session has no output yet', () => {
    const original = binding({
      binding_key: 'session-source-1',
      role: 'semantic_reference',
      candidate_kind: 'original_source',
      candidate_position: 1,
      lineage_source_binding_keys: [],
    });
    const candidate = sceneBatchCandidate([original]);
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: candidate.skill_id,
      intent: candidate.intent.kind,
    })!;

    expect(
      validateCreativeExecutionProfile({ profile, candidate, bindings: [original] }),
    ).toMatchObject({
      ok: true,
      nodes: { 'scene-1': { providerBindings: [original] } },
    });
    candidate.source_decision = {
      mode: 'refine_latest',
      output_binding_key: 'session-output-1',
      reason_summary: '不存在的产物',
    };
    expect(
      validateCreativeExecutionProfile({ profile, candidate, bindings: [original] }),
    ).toMatchObject({
      ok: false,
      ruleId: 'creative_decision_without_session_output',
    });
  });

  it('generates an unpublished input without inventing lineage to another successful image', () => {
    const original = binding({
      binding_key: 'session-source-2',
      role: 'semantic_reference',
      candidate_kind: 'original_source',
      candidate_position: 2,
      lineage_source_binding_keys: [],
    });
    const output = binding({
      binding_key: 'session-output-1',
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 3,
      candidate_kind: 'latest_output',
      candidate_position: 1,
      lineage_source_binding_keys: ['session-source-1'],
    });
    const candidate = sceneBatchCandidate([original]);
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: candidate.skill_id,
      intent: candidate.intent.kind,
    })!;
    expect(
      validateCreativeExecutionProfile({ profile, candidate, bindings: [output, original] }),
    ).toMatchObject({
      ok: true,
      nodes: { 'scene-1': { providerBindings: [original] } },
    });
    expect(
      validateCreativeExecutionProfile({
        profile,
        candidate,
        bindings: [{ ...output, lineage_source_binding_keys: [original.binding_key] }, original],
      }),
    ).toMatchObject({ ok: false, ruleId: 'creative_decision_required' });
  });

  it('rejects a restart decision whose original source is not linked to the selected output', () => {
    const original = binding({
      binding_key: 'session-source-2',
      role: 'semantic_reference',
      candidate_kind: 'original_source',
      candidate_position: 2,
      lineage_source_binding_keys: [],
    });
    const output = binding({
      binding_key: 'session-output-1',
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 3,
      candidate_kind: 'latest_output',
      candidate_position: 1,
      lineage_source_binding_keys: ['session-source-1'],
    });
    const candidate = sceneBatchCandidate([original]);
    candidate.source_decision = {
      mode: 'restart_original',
      output_binding_key: output.binding_key,
      original_source_binding_key: original.binding_key,
      reason_summary: '当前成图缺少所需视觉证据。',
    };
    const profile = resolveCreativeExecutionProfile({
      primarySkillId: candidate.skill_id,
      intent: candidate.intent.kind,
    })!;

    expect(
      validateCreativeExecutionProfile({ profile, candidate, bindings: [output, original] }),
    ).toMatchObject({
      ok: false,
      ruleId: 'creative_decision_lineage_invalid',
      bindingKey: original.binding_key,
    });
  });

  it('applies the shared current-session edit profile to the first-release commerce Skill', () => {
    const parent = binding({
      kind: 'artifact',
      role: 'edit_source',
      mutable: true,
      producer_mode: 'chat',
      producer_session_id: SESSION_ID,
      mutation_owner: 'chat_session',
      publication_revision: 2,
    });
    const result = validate('commerce-white-background@1.0.0', 'chat_artifact_edit', {
      bindings: [parent],
      capability: 'image.edit',
      params: {
        goal_summary: 'Make the shadow softer.',
        changed_items: ['shadow softness'],
        preserved_items: ['product identity', 'logo', 'visible text'],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      nodes: {
        'image-main': {
          providerBindings: [parent],
          constraintsSnapshot: { parent_publication_revision: 2 },
        },
      },
    });
  });

  it('does not grant current-session edit capability to an unknown primary Skill', () => {
    expect(
      resolveCreativeExecutionProfile({
        primarySkillId: 'unknown-primary@1.0.0',
        intent: 'chat_artifact_edit',
      }),
    ).toBeNull();
  });

  it('rejects a cross-session or unpublished edit source', () => {
    const result = validate('creative-free-generation@1.0.1', 'chat_artifact_edit', {
      bindings: [
        binding({
          kind: 'artifact',
          role: 'edit_source',
          mutable: false,
          producer_mode: 'chat',
          producer_session_id: '33333333-3333-4333-8333-333333333333',
          mutation_owner: 'chat_session',
          publication_revision: null,
        }),
      ],
      capability: 'image.edit',
      params: {
        goal_summary: '继续修改',
        changed_items: ['背景'],
        preserved_items: ['人物'],
      },
    });
    expect(result).toMatchObject({ ok: false, ruleId: 'creative_profile_edit_source_invalid' });
  });
});

function validate(
  skillId: string,
  intent: CandidatePlan['intent']['kind'],
  input: {
    bindings: BindingSnapshot[];
    capability: 'image.generate' | 'image.edit';
    params: Record<string, unknown>;
  },
) {
  const profile = resolveCreativeExecutionProfile({ primarySkillId: skillId, intent });
  if (!profile) throw new Error('Profile missing');
  const candidate: CandidatePlan = {
    schema_version: 1,
    intent: { kind: intent, confidence: 0.99 },
    skill_id: skillId,
    source: 'chat',
    nodes: [
      {
        candidate_key: 'image-main',
        capability: input.capability,
        capability_version: 1,
        depends_on: [],
        input_bindings: input.bindings.map((item) => item.binding_key),
        params: input.params,
        expected_output: 'image',
      },
    ],
  };
  return validateCreativeExecutionProfile({ profile, candidate, bindings: input.bindings });
}

function sceneBatchCandidate(sources: BindingSnapshot[]): CandidatePlan {
  return {
    schema_version: 1,
    intent: { kind: 'raw_asset_generate', confidence: 0.99 },
    skill_id: 'creative-scene-reimagining@1.2.0',
    source: 'chat',
    nodes: sources.map((source, index) => ({
      candidate_key: `scene-${index + 1}`,
      capability: 'image.edit',
      capability_version: 1,
      depends_on: [],
      input_bindings: [source.binding_key],
      params: {
        goal_summary: `重绘第 ${index + 1} 张照片`,
        output_count: 1,
        output_count_source: 'user_explicit',
        semantic_summary: `第 ${index + 1} 张照片的独立关系摘要`,
        creative_prompt: `为第 ${index + 1} 张照片建立独立的源生构图、关系张力和绘画性视觉语言。`,
        creative_note: `第 ${index + 1} 张作品以独立视觉命题重组原场景。主构图、边缘节奏和色彩职责均只来自这一张照片。`,
      },
      expected_output: 'image',
    })),
  };
}

function binding(overrides: Partial<BindingSnapshot> = {}): BindingSnapshot {
  return {
    binding_key: '44444444-4444-4444-8444-444444444444',
    kind: 'asset',
    object_id: '55555555-5555-4555-8555-555555555555',
    object_version: 'a'.repeat(64),
    content_hash: 'a'.repeat(64),
    owner_user_id: USER_ID,
    readable: true,
    mutable: false,
    producer_mode: null,
    producer_session_id: null,
    mutation_owner: null,
    source_action: null,
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    role: 'other',
    position: 0,
    publication_revision: null,
    ...overrides,
  };
}
function executionPolicyForFixture(skillId: string): SkillExecutionPolicy | undefined {
  const slug = skillId.split('@')[0];
  for (const directory of ['creative-first-release-v1', 'commerce-white-background-v1']) {
    const manifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          '../../packages/skills/content',
          directory,
          'skill-package/skill-package.json',
        ),
        'utf8',
      ),
    ) as {
      skill_profiles: Record<string, { slug: string; execution_policy?: unknown }>;
    };
    const row = Object.values(manifest.skill_profiles).find((item) => item.slug === slug);
    const policy = parseSkillExecutionPolicy(row?.execution_policy);
    if (policy) return policy;
  }
  return undefined;
}
function resolveCreativeExecutionProfile(input: Parameters<typeof resolveDeclaredProfile>[0]) {
  const policy = input.executionPolicy ?? executionPolicyForFixture(input.primarySkillId);
  return resolveDeclaredProfile({ ...input, ...(policy ? { executionPolicy: policy } : {}) });
}
