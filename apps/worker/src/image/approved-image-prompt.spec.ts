import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillExecutionPolicy, type SkillExecutionPolicy } from '@ecom-forge/shared';
import { canonicalSha256 } from '@ecom-forge/shared';
import {
  resolveCreativeExecutionProfile as resolveDeclaredProfile,
  validateCreativeExecutionProfile,
  type BindingSnapshot,
  type CandidatePlan,
} from '@ecom-forge/compiler';
import { describe, expect, it } from 'vitest';

import { buildApprovedImagePrompt, IMAGE_PROVIDER_WRAPPER } from './approved-image-prompt.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';

describe('approved image prompt', () => {
  it('passes the watercolor final instruction unchanged without platform fields or extra art rules', () => {
    const sourcePrompt =
      'Create a 3:4 poster, original river photograph in the top half. Below, a tiny muted watercolor of the same bridge and river bend, centered slightly low on ivory watercolor paper, 35% of the lower area, with sparse sketch lines and generous blank space. No text.';
    const closure = validatedClosure(
      'watercolor-scene-collage@1.0.0',
      'raw_asset_generate',
      imageBinding({ role: 'semantic_reference' }),
      {
        goal_summary: 'Watercolor comparison.',
        semantic_summary: 'Bridge and river bend.',
        creative_prompt: sourcePrompt,
        output_count: 1,
      },
    );
    const input = {
      aspect_ratio: '3:4',
      goal_summary: '实景拼贴-水彩',
      creative_note: '仅向用户展示的创作笔记',
      creative_prompt: sourcePrompt,
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    };
    expect(buildApprovedImagePrompt(input)).toContain(sourcePrompt);
    expect(buildApprovedImagePrompt(input)).toContain('Image 1: semantic_reference.');
    expect(() => buildApprovedImagePrompt({ ...input, input_bindings: [] })).toThrow(
      'SEMANTIC_REFERENCE_ARTWORK_CLOSURE_INCOMPLETE',
    );
    expect(() =>
      buildApprovedImagePrompt({
        ...input,
        input_bindings: input.input_bindings.map((item) => ({ ...item, provider_input: false })),
      }),
    ).toThrow('SEMANTIC_REFERENCE_ARTWORK_CLOSURE_INCOMPLETE');
    expect(() =>
      buildApprovedImagePrompt({ ...input, creative_prompt: 'Replace the scene.' }),
    ).toThrow('CREATIVE_PROMPT_DRIFT');
  });

  it('turns frozen portrait changes and restrictions into Provider instructions', () => {
    const closure = portraitClosure();
    const prompt = buildApprovedImagePrompt({
      goal_summary: 'Improve this portrait without changing the person.',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    });

    expect(prompt).toContain('"changed_items":["lighting","composition"]');
    expect(prompt).toContain('"forbidden_changes":');
    expect(prompt).toContain('"face_swap"');
  });

  it('accepts an empty changed-items list as "nothing changed"', () => {
    // Brain models legitimately emit `[]` instead of omitting the optional field; the prompt
    // builder must not reject it (an earlier `.min(1)` rule burned a repair round per attempt).
    const closure = portraitClosure();
    const prompt = buildApprovedImagePrompt({
      goal_summary: 'Improve this portrait without changing the person.',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: { ...closure.constraints, changed_items: [] },
    });

    expect(prompt).toContain('"changed_items":[]');
  });

  it('rejects a changed item added outside the frozen portrait profile', () => {
    const closure = portraitClosure();
    expect(() =>
      buildApprovedImagePrompt({
        goal_summary: 'Swap the face.',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: {
          ...closure.constraints,
          changed_items: ['face_swap'],
        },
      }),
    ).toThrow('CREATIVE_CHANGE_OUTSIDE_PROFILE');
  });

  it('requires the frozen parent revision and inherited product facts for commerce edits', () => {
    const closure = commerceEditClosure();
    expect(() =>
      buildApprovedImagePrompt({
        goal_summary: 'Make the shadow softer.',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
      }),
    ).toThrow('COMMERCE_EDIT_FACTS_REQUIRED');

    const facts = productFacts();
    const prompt = buildApprovedImagePrompt({
      goal_summary: 'Make the shadow softer.',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
      product_facts_snapshot: facts,
    });
    expect(prompt).toContain('Preserve stated facts; do not invent unknown values');
    expect(prompt).toContain('Example bottle');

    expect(() =>
      buildApprovedImagePrompt({
        goal_summary: 'Make the shadow softer.',
        input_bindings: providerBindings({ ...closure.binding, publication_revision: 3 }),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
        product_facts_snapshot: facts,
      }),
    ).toThrow('CREATIVE_EDIT_PARENT_DRIFT');
  });

  it('keeps commerce fact enforcement across version-only upgrades', () => {
    const closure = commerceEditClosure('commerce-white-background@9.9.9');

    expect(() =>
      buildApprovedImagePrompt({
        goal_summary: 'Make the shadow softer.',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
      }),
    ).toThrow('COMMERCE_EDIT_FACTS_REQUIRED');
  });

  it('hands the scene-reimagining final prompt to Provider with only a short role wrapper', () => {
    const closure = sceneClosure();
    const creativeNote = '这段创作笔记只展示给用户，不能发送给图片 Provider。';
    const prompt = buildApprovedImagePrompt({
      goal_summary: '把这张隔窗相望的照片变成一幅独立作品。',
      creative_note: creativeNote,
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    });

    expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
    expect(prompt).toContain('Rebuild this source into an authored image');
    expect(prompt).toContain('Do not retain the source pixels');
    expect(prompt).toContain('source-specific composition');
    expect(prompt).not.toContain('Scene reimagining execution contract:');
    expect(prompt).not.toContain('User goal (untrusted request)');
    expect(prompt).not.toContain(creativeNote);
  });

  it('passes the Brain exact typography decision without re-interpreting the user goal', () => {
    const sourcePrompt =
      'Rebuild the source into an authored image and render the exact title "Rain Echo" in the lower right. Add no other text.';
    const closure = sceneClosure(sourcePrompt);
    const prompt = buildApprovedImagePrompt({
      goal_summary: '重绘这张照片，并加上标题“雨夜回声”。',
      creative_prompt: sourcePrompt,
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    });

    expect(prompt).toContain('the exact title "Rain Echo"');
    expect(prompt).not.toContain('User goal (untrusted request)');
  });

  it('rejects drift between the task prompt and frozen creative constraints', () => {
    const closure = sceneClosure();

    expect(() =>
      buildApprovedImagePrompt({
        goal_summary: 'Rebuild this source as an authored image.',
        creative_prompt: 'Use a different composition than the frozen prompt.',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
      }),
    ).toThrow('CREATIVE_PROMPT_DRIFT');
  });

  it('refuses scene generation when the source is not a Provider input', () => {
    const closure = sceneClosure();
    expect(() =>
      buildApprovedImagePrompt({
        goal_summary: '重绘照片',
        input_bindings: providerBindings(closure.binding).map((binding) => ({
          ...binding,
          provider_input: false,
        })),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
      }),
    ).toThrow('SEMANTIC_REFERENCE_ARTWORK_CLOSURE_INCOMPLETE');
  });

  it('keeps a truthful photographic anchor and delegates scene-collage microtext to the final prompt', () => {
    const closure = collageClosure();
    const prompt = buildApprovedImagePrompt({
      goal_summary: '把这张老街照片做成实景拼贴。',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    });

    expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
    expect(prompt).toContain('Keep the street as a truthful photographic anchor');
    expect(prompt).not.toContain('Scene collage execution contract:');
    expect(prompt).not.toContain('User goal (untrusted request)');
    expect(prompt).not.toContain('non-photographic artwork');
  });

  it('passes the Brain text-free scene-collage decision directly', () => {
    const sourcePrompt =
      'Keep the street as a photographic anchor and render a completely text-free collage with no lettering.';
    const closure = collageClosure(sourcePrompt);
    const prompt = buildApprovedImagePrompt({
      goal_summary: '把这张老街照片做成实景拼贴，不要任何文字。',
      creative_prompt: sourcePrompt,
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    });

    expect(prompt).toContain('completely text-free collage');
  });

  it('hands the xieyi final prompt to Provider without internal structure fields', () => {
    const closure = xieyiClosure();
    const prompt = buildApprovedImagePrompt({
      goal_summary: '把这张河岸照片做成写意纸境。',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    });

    expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
    expect(prompt).toContain('Keep the riverbank as a photographic anchor');
    expect(prompt).toContain('No visible text');
    expect(prompt).not.toContain('Xieyi scene collage execution contract:');
    expect(prompt).not.toContain('User goal (untrusted request)');
    expect(prompt).not.toContain('xieyi_structure');
    expect(prompt).not.toContain('structural_change');
  });

  it('passes exact user-authorized xieyi text only after Brain compiles it', () => {
    const structuralChangeInstruction =
      'Redirect the riverbank axis from the lower left into a widening upper-right paper distance.';
    const sourcePrompt = `${structuralChangeInstruction} Keep the riverbank as a photographic anchor and write only the exact phrase "Wind over this mountain" in the upper-right blank paper field.`;
    const closure = xieyiClosure(sourcePrompt);
    const prompt = buildApprovedImagePrompt({
      goal_summary: '做成写意纸境，并在留白处写上“风过此山”。',
      creative_prompt: sourcePrompt,
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    });

    expect(prompt).toContain('only the exact phrase "Wind over this mountain"');
    expect(prompt).not.toContain('User goal (untrusted request)');
  });

  it('directly hands the Brain final prompt to the Provider with only a short image-role wrapper', () => {
    const sourcePrompt =
      'Keep the central hill as one dark compact mass in the lower panel, compress the lake into an irregular blue reflection field, retain the bridge opening and two tower silhouettes, and leave the upper-right paper field quiet. Use one small orange accent on the right. Ignore all source camera text and render no other lettering.';
    const closure = minimalClosure(sourcePrompt);
    const prompt = buildApprovedImagePrompt({
      aspect_ratio: '3:4',
      goal_summary: '把这张街景照片做成极简拼贴。',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
      creative_prompt: sourcePrompt,
    });

    expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
    expect(prompt).toContain(sourcePrompt);
    expect(prompt).toContain('Image 1: semantic_reference.');
    expect(prompt).toContain('Image 1: semantic_reference.');
    expect(prompt).toContain('Generate one complete image at the requested canvas size');
    expect(prompt).toContain('Final creative instruction:');
    expect(prompt).toContain('Supplied images are authorized visual evidence');
    expect(prompt).not.toContain('你是一名擅长新版画');
    expect(prompt).not.toContain('User goal (untrusted request)');
  });

  it('does not hardcode a collage canvas in the execution layer', () => {
    const closure = minimalClosure();
    expect(() =>
      buildApprovedImagePrompt({
        aspect_ratio: '1:1',
        goal_summary: '把这张街景照片做成极简拼贴。',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
      }),
    ).not.toThrow();
  });

  it('keeps user text instructions out of the fixed prompt and requires Brain text policy', () => {
    const sourcePrompt = 'Render the lower panel with no visible text and no lettering.';
    const closure = minimalClosure(sourcePrompt);
    const prompt = buildApprovedImagePrompt({
      aspect_ratio: '3:4',
      goal_summary: '把这张街景照片做成极简拼贴，不要任何文字。',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
      creative_prompt: sourcePrompt,
    });

    expect(prompt).toContain(sourcePrompt);
    expect(prompt).toContain('Render the lower panel with no visible text');
    expect(prompt).not.toContain('User goal (untrusted request)');
  });

  it('rejects a minimal collage closure without a source-specific prompt', () => {
    const closure = minimalClosure();
    expect(() =>
      buildApprovedImagePrompt({
        aspect_ratio: '3:4',
        goal_summary: '把这张街景照片做成极简拼贴。',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: { ...closure.constraints, creative_prompt: undefined },
      }),
    ).toThrow('CREATIVE_PROMPT_REQUIRED');
  });

  it('passes the Brain creative direction through a non-directive void line wrapper', () => {
    const sourcePrompt =
      'Keep one tiny source-derived figure in a vast lower field and express one falling motion with sparse broken lines.';
    const closure = validatedClosure(
      'void-line-poster@1.1.0',
      'raw_asset_generate',
      imageBinding({ role: 'semantic_reference' }),
      {
        goal_summary: 'Create a void line poster.',
        output_count: 1,
        output_count_source: 'skill_default',
        semantic_summary: 'One source-specific subject and one source-derived movement.',
        creative_prompt: sourcePrompt,
      },
    );
    const prompt = buildApprovedImagePrompt({
      aspect_ratio: '3:4',
      goal_summary: 'Create a void line poster.',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
      creative_prompt: sourcePrompt,
    });

    expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
    expect(prompt).toContain(sourcePrompt);
    expect(prompt).toContain('requested canvas size');
    expect(prompt).not.toContain('one directional motion field');
    expect(prompt).not.toContain('must be clearly visible, visually weighted');
  });

  it('does not hardcode a line-poster canvas in the execution layer', () => {
    const closure = validatedClosure(
      'void-line-poster@1.1.0',
      'raw_asset_generate',
      imageBinding({ role: 'semantic_reference' }),
      {
        goal_summary: 'Create a void line poster.',
        output_count: 1,
        output_count_source: 'skill_default',
        semantic_summary: 'One source-specific subject and one source-derived movement.',
        creative_prompt: 'One source-derived subject in a large empty field.',
      },
    );
    expect(() =>
      buildApprovedImagePrompt({
        aspect_ratio: '1:1',
        goal_summary: 'Create a void line poster.',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
      }),
    ).not.toThrow();
  });

  it('hands only the daily-memory final prompt and a short image-role wrapper to Provider', () => {
    const sourcePrompt =
      'Repaint the curled cat as one compact colored-pencil field in the lower-left, retain one pale-gold patch of window light, keep the upper-right cool-white paper field continuous, remove room clutter, repeated textile detail, and all visible text.';
    const closure = dailyMemoryClosure(sourcePrompt);
    const prompt = buildApprovedImagePrompt({
      aspect_ratio: '4:5',
      goal_summary: '把窗边蜷着的猫做成日常记忆页。',
      input_bindings: providerBindings(closure.binding),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
      creative_prompt: sourcePrompt,
    });

    expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
    expect(prompt).toContain(sourcePrompt);
    expect(prompt).toContain('Generate one complete image at the requested canvas size');
    expect(prompt).toContain('Final creative instruction:');
    expect(prompt).not.toContain('User goal (untrusted request)');
    expect(prompt).not.toContain('把窗边蜷着的猫做成日常记忆页');
    expect(prompt).not.toContain('Memory Card');
  });

  it('rejects a daily-memory closure without a Brain final prompt', () => {
    const closure = dailyMemoryClosure();
    expect(() =>
      buildApprovedImagePrompt({
        aspect_ratio: '4:5',
        goal_summary: '把窗边蜷着的猫做成日常记忆页。',
        input_bindings: providerBindings(closure.binding),
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: { ...closure.constraints, creative_prompt: undefined },
      }),
    ).toThrow('CREATIVE_PROMPT_REQUIRED');
  });

  it.each(['creative_generate', 'raw_asset_generate'] as const)(
    'hands only the cinematic poster final prompt to Provider for %s',
    (intent) => {
      const sourcePrompt =
        'Create one original 9:16 poster around a divided table as the only visual motif. Render the exact title "TABLE SIDES" in the lower third and no other text.';
      const closure = cinematicPosterClosure(intent, sourcePrompt);
      const prompt = buildApprovedImagePrompt({
        aspect_ratio: '9:16',
        goal_summary: '为原创短片做一张叙事电影海报。',
        input_bindings: closure.binding ? providerBindings(closure.binding) : [],
        creative_execution_profile: closure.profile,
        creative_constraints_snapshot: closure.constraints,
        creative_prompt: sourcePrompt,
      });

      expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
      expect(prompt).toContain(sourcePrompt);
      expect(prompt).toContain('one complete image at the requested canvas size');
      expect(prompt).not.toContain('User goal (untrusted request)');
      expect(prompt).not.toContain('为原创短片做一张叙事电影海报');
      expect(prompt).not.toContain('Film Card');
    },
  );

  it('rejects cinematic poster Provider bindings that contradict the frozen route', () => {
    const generated = cinematicPosterClosure('creative_generate');
    const unexpectedBinding = imageBinding({ role: 'semantic_reference' });
    expect(() =>
      buildApprovedImagePrompt({
        aspect_ratio: '9:16',
        goal_summary: 'Create a poster.',
        input_bindings: providerBindings(unexpectedBinding),
        creative_execution_profile: generated.profile,
        creative_constraints_snapshot: generated.constraints,
        creative_prompt: 'Create one original text-free 9:16 key visual.',
      }),
    ).toThrow('CREATIVE_PROVIDER_BINDINGS_INVALID');
  });

  it('hands one social contrast final prompt and its selected evidence directly to Provider', () => {
    const sourcePrompt =
      'Create one 3:4 poster whose surface reading is a delayed breakfast and whose second reading is a calm system incident. Keep the spilled milk as the primary evidence, preserve every source object, use one source-derived red accent, redact all private text, and render the short title "MORNING BUFFER" only.';
    const closure = socialContrastClosure(3, sourcePrompt);
    const prompt = buildApprovedImagePrompt({
      aspect_ratio: '3:4',
      goal_summary: '把早餐小事故做成日常反差海报。',
      input_bindings: closure.bindings.flatMap(providerBindings),
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
      creative_prompt: sourcePrompt,
    });

    expect(prompt).toContain(IMAGE_PROVIDER_WRAPPER);
    expect(prompt).toContain(sourcePrompt);
    expect(prompt).toContain('Image 3: semantic_reference.');
    expect(prompt).not.toContain('User goal (untrusted request)');
    expect(prompt).not.toContain('Contrast Card');
  });

  it('rejects invalid social contrast evidence count, role, and missing final prompt', () => {
    const closure = socialContrastClosure(1);
    const sourcePrompt = 'Create one 3:4 social contrast poster from the selected evidence.';
    const baseInput = {
      aspect_ratio: '3:4',
      goal_summary: '做一张日常反差海报。',
      creative_execution_profile: closure.profile,
      creative_constraints_snapshot: closure.constraints,
    };
    expect(() =>
      buildApprovedImagePrompt({
        ...baseInput,
        input_bindings: [],
        creative_prompt: sourcePrompt,
      }),
    ).toThrow('CREATIVE_PROVIDER_BINDINGS_INVALID');
    expect(() =>
      buildApprovedImagePrompt({
        ...baseInput,
        input_bindings: providerBindings(imageBinding({ role: 'style_reference' })),
        creative_prompt: sourcePrompt,
      }),
    ).toThrow('CREATIVE_PROVIDER_BINDINGS_INVALID');
    expect(() =>
      buildApprovedImagePrompt({
        ...baseInput,
        input_bindings: Array.from({ length: 7 }, (_, index) =>
          providerBindings(
            imageBinding({
              object_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
              role: 'semantic_reference',
            }),
          ),
        ).flat(),
        creative_prompt: sourcePrompt,
      }),
    ).toThrow('CREATIVE_PROVIDER_BINDINGS_INVALID');
    expect(() =>
      buildApprovedImagePrompt({
        ...baseInput,
        creative_constraints_snapshot: { ...closure.constraints, creative_prompt: undefined },
        input_bindings: closure.bindings.flatMap(providerBindings),
      }),
    ).toThrow('CREATIVE_PROMPT_REQUIRED');
  });
});

function portraitClosure() {
  const binding = imageBinding({ role: 'identity_anchor' });
  return validatedClosure('creative-portrait-renewal@1.0.0', 'raw_asset_generate', binding, {
    goal_summary: 'Improve portrait lighting and composition.',
    changed_items: ['lighting', 'composition'],
  });
}

function commerceEditClosure(skillId = 'commerce-white-background@1.0.0') {
  const binding = imageBinding({
    kind: 'artifact',
    object_id: PARENT_ID,
    role: 'edit_source',
    mutable: true,
    producer_mode: 'chat',
    producer_session_id: SESSION_ID,
    mutation_owner: 'chat_session',
    publication_revision: 2,
  });
  return validatedClosure(skillId, 'chat_artifact_edit', binding, {
    goal_summary: 'Make the shadow softer.',
    changed_items: ['shadow softness'],
    preserved_items: ['product identity', 'logo', 'visible text'],
  });
}

function sceneClosure(
  creativePrompt = 'Rebuild this source into an authored image with a source-specific composition. Do not retain the source pixels. Keep the observed relationship and turn its gesture into a visible painterly structure.',
) {
  const binding = imageBinding({ role: 'semantic_reference' });
  return validatedClosure('creative-scene-reimagining@1.2.0', 'raw_asset_generate', binding, {
    goal_summary: '把这张隔窗相望的照片变成一幅独立作品。',
    output_count: 1,
    output_count_source: 'user_explicit',
    semantic_summary: '两个主体被窗框分隔，但视线与动作保持连接。',
    creative_prompt: creativePrompt,
    creative_note:
      '把隔窗相望作为这张作品的核心命题。用错开的空间层次和断续边缘强化靠近与阻隔的张力。',
  });
}

function collageClosure(
  creativePrompt = 'Keep the street as a truthful photographic anchor and extend its road axis into a quiet abstract print field with one structural tomato-red hue and a narrow fibrous torn-paper boundary.',
) {
  const binding = imageBinding({ role: 'semantic_reference' });
  return validatedClosure('creative-scene-collage@1.4.2', 'raw_asset_generate', binding, {
    goal_summary: '把这张老街照片做成实景拼贴。',
    output_count: 1,
    output_count_source: 'skill_default',
    semantic_summary: '保留街口、两侧建筑和道路向远处收束的空间关系。',
    creative_prompt: creativePrompt,
    creative_note: '让道路轴线穿过撕纸边界，连接真实街口与空纸上的抽象建筑节奏。',
  });
}

function xieyiClosure(creativePrompt?: string) {
  const binding = imageBinding({ role: 'semantic_reference' });
  const structuralChangeInstruction =
    'Redirect the riverbank axis from the lower left into a widening upper-right paper distance.';
  return validatedClosure('xieyi-scene-collage@1.0.0', 'raw_asset_generate', binding, {
    goal_summary: '把这张河岸照片做成写意纸境。',
    output_count: 1,
    output_count_source: 'skill_default',
    semantic_summary: '保留河岸、远山与水面向远处展开的空间关系。',
    creative_prompt:
      creativePrompt ??
      `${structuralChangeInstruction} Keep the riverbank as a photographic anchor, let its horizontal momentum enter one wet-ink transition, and open directional blank paper toward the distant mountain. Remove signs, repeated ripples, and incidental branches. No visible text.`,
    creative_note: '保留河岸实景，以湿染转折把水平方向送入远山前的留白。',
  });
}

function minimalClosure(
  creativePrompt = 'Keep the source-specific visual relationship and render no visible text.',
) {
  const binding = imageBinding({ role: 'semantic_reference' });
  return validatedClosure('minimal-scene-collage@2.8.0', 'raw_asset_generate', binding, {
    goal_summary: '把这张街景照片做成极简拼贴。',
    output_count: 1,
    output_count_source: 'skill_default',
    semantic_summary: '保留街景的主质量与空间关系。',
    creative_prompt: creativePrompt,
  });
}

function dailyMemoryClosure(
  creativePrompt = 'Repaint the curled cat as one compact colored-pencil field and render no visible text.',
) {
  const binding = imageBinding({ role: 'semantic_reference' });
  return validatedClosure('daily-memory-page@1.1.0', 'raw_asset_generate', binding, {
    goal_summary: '把窗边蜷着的猫做成日常记忆页。',
    output_count: 1,
    output_count_source: 'skill_default',
    semantic_summary: '保留猫蜷起的姿态、窗边位置和午后光落在被子上的关系。',
    creative_prompt: creativePrompt,
  });
}

function cinematicPosterClosure(
  intent: 'creative_generate' | 'raw_asset_generate',
  creativePrompt = 'Create one original text-free 9:16 key visual.',
) {
  const binding =
    intent === 'raw_asset_generate' ? imageBinding({ role: 'semantic_reference' }) : undefined;
  const profile = resolveCreativeExecutionProfile({
    primarySkillId: 'cinematic-story-poster@1.1.0',
    intent,
  });
  if (!profile) throw new Error('Expected cinematic poster profile');
  const candidate: CandidatePlan = {
    schema_version: 1,
    intent: { kind: intent, confidence: 0.99 },
    skill_id: 'cinematic-story-poster@1.1.0',
    source: 'chat',
    nodes: [
      {
        candidate_key: 'poster-main',
        capability: intent === 'creative_generate' ? 'image.generate' : 'image.edit',
        capability_version: 1,
        depends_on: [],
        input_bindings: binding ? [binding.binding_key] : [],
        params: {
          goal_summary: 'Create one original cinematic story poster.',
          creative_prompt: creativePrompt,
          output_count: 1,
          output_count_source: 'skill_default',
        },
        expected_output: 'image',
      },
    ],
  };
  const bindings = binding ? [binding] : [];
  const result = validateCreativeExecutionProfile({ profile, candidate, bindings });
  if (!result.ok) throw new Error(result.ruleId);
  return {
    profile,
    constraints: result.nodes['poster-main']!.constraintsSnapshot,
    binding,
  };
}

function socialContrastClosure(
  count: number,
  creativePrompt = 'Create one 3:4 social contrast poster from the selected evidence.',
) {
  const bindings = Array.from({ length: count }, (_, index) =>
    imageBinding({
      binding_key: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      object_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      role: 'semantic_reference',
      position: index,
    }),
  );
  const profile = resolveCreativeExecutionProfile({
    primarySkillId: 'social-contrast-poster@1.1.0',
    intent: 'raw_asset_generate',
  });
  if (!profile) throw new Error('Expected social contrast poster profile');
  const candidate: CandidatePlan = {
    schema_version: 1,
    intent: { kind: 'raw_asset_generate', confidence: 0.99 },
    skill_id: 'social-contrast-poster@1.1.0',
    source: 'chat',
    nodes: [
      {
        candidate_key: 'poster-main',
        capability: 'image.edit',
        capability_version: 1,
        depends_on: [],
        input_bindings: bindings.map((binding) => binding.binding_key),
        params: {
          goal_summary: 'Create one social contrast poster.',
          creative_prompt: creativePrompt,
          output_count: 1,
          output_count_source: 'skill_default',
        },
        expected_output: 'image',
      },
    ],
  };
  const result = validateCreativeExecutionProfile({ profile, candidate, bindings });
  if (!result.ok) throw new Error(result.ruleId);
  return {
    profile,
    constraints: result.nodes['poster-main']!.constraintsSnapshot,
    bindings,
  };
}

function validatedClosure(
  skillId: string,
  intent: CandidatePlan['intent']['kind'],
  binding: BindingSnapshot,
  params: Record<string, unknown>,
) {
  const profile = resolveCreativeExecutionProfile({ primarySkillId: skillId, intent });
  if (!profile) throw new Error('Expected execution profile');
  const candidate: CandidatePlan = {
    schema_version: 1,
    intent: { kind: intent, confidence: 0.99 },
    skill_id: skillId,
    source: 'chat',
    nodes: [
      {
        candidate_key: 'image-main',
        capability: 'image.edit',
        capability_version: 1,
        depends_on: [],
        input_bindings: [binding.binding_key],
        params,
        expected_output: 'image',
      },
    ],
  };
  const result = validateCreativeExecutionProfile({ profile, candidate, bindings: [binding] });
  if (!result.ok) throw new Error(result.ruleId);
  return { profile, constraints: result.nodes['image-main']!.constraintsSnapshot, binding };
}

function providerBindings(binding: BindingSnapshot) {
  return [
    {
      object_id: binding.object_id,
      object_version: binding.object_version,
      role: binding.role ?? 'other',
      provider_input: true,
      publication_revision: binding.publication_revision ?? null,
    },
  ];
}

function imageBinding(overrides: Partial<BindingSnapshot> = {}): BindingSnapshot {
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

function productFacts() {
  const snapshot = {
    schema_version: 1 as const,
    product_id: '66666666-6666-4666-8666-666666666666',
    fact_set_id: '77777777-7777-4777-8777-777777777777',
    fact_set_version: 1,
    source_asset_id: '88888888-8888-4888-8888-888888888888',
    source_version: 'b'.repeat(64),
    facts: {
      product_name: 'Example bottle',
      primary_colors: ['blue'],
      logos: ['EXAMPLE'],
      visible_text: ['500 ml'],
      materials: ['glass'],
      must_preserve: ['bottle shape'],
      unknown_fields: [],
    },
  };
  return { ...snapshot, snapshot_digest: canonicalSha256(snapshot) };
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
