import { describe, expect, it } from 'vitest';

import type { ComposerValue } from './composer-types';
import { buildTurnPayload } from './turn-payload';
import type { AgentCatalogState } from './use-agent-catalogs';

const brainId = '11111111-1111-4111-8111-111111111111';
const imageId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const bindingId = '44444444-4444-4444-8444-444444444444';

describe('buildTurnPayload', () => {
  it('preserves a complete free creation prompt without images or style selections', () => {
    const catalog = catalogs();
    const free = {
      ...catalog.skills!.items[0]!,
      primary_skill_id: 'creative-free-generation@1.0.1',
      slug: 'creative-free-generation',
      required_inputs: [],
      preset_slots: [],
    };
    catalog.skills!.items = [free];
    const prompt =
      'A blue ceramic cup in the lower left, overhead view, white background. No text.';
    const payload = buildTurnPayload({
      catalogs: catalog,
      composer: {
        ...composer(),
        selectedSkillId: free.primary_skill_id,
        selectedPresetIds: {},
        attachments: [],
        referencedAttachmentIds: [],
        prompt,
      },
    });
    expect(payload.message).toBe(prompt);
    expect(payload.attachments).toEqual([]);
    expect(payload.mention_bindings).toEqual([]);
    expect(payload.skill_selection).toEqual({
      primary_skill_id: free.primary_skill_id,
      preset_selections: [],
    });
  });

  it('defaults a new draft to v2 and does not upgrade an explicit legacy selection', () => {
    expect(
      buildTurnPayload({ catalogs: catalogs(), composer: composer() }).generation_preferences
        .creative_direction,
    ).toEqual({ mode: 'auto', version: 3 });
    for (const version of [1, 2] as const) {
      const selection = { mode: 'profile' as const, profile_id: 'spatial-drama' as const, version };
      expect(
        buildTurnPayload({
          catalogs: catalogs(),
          composer: { ...composer(), creativeDirection: selection },
        }).generation_preferences.creative_direction,
      ).toEqual(selection);
    }
  });
  it('sends only the validated designer selection, and blocks an invalid cached choice', () => {
    const selection = {
      mode: 'profile' as const,
      profile_id: 'graphic-order' as const,
      version: 1 as const,
    };
    const payload = buildTurnPayload({
      catalogs: catalogs(),
      composer: { ...composer(), creativeDirection: selection },
    });
    expect(payload.generation_preferences.creative_direction).toEqual(selection);
    expect(payload.generation_preferences.creative_direction).not.toHaveProperty('content');
    expect(() =>
      buildTurnPayload({
        catalogs: catalogs(),
        composer: { ...composer(), creativeDirection: null },
      }),
    ).toThrow('设计师选择已失效');
  });
  it.each(['selectedBrainModelVersion', 'selectedImageModelVersion'] as const)(
    'requires re-selection instead of upgrading a restored %s',
    (field) => {
      expect(() =>
        buildTurnPayload({ catalogs: catalogs(), composer: { ...composer(), [field]: 99 } }),
      ).toThrow('原选模型已更新');
    },
  );
  it('keeps an image-only reply empty instead of manufacturing a generation request', () => {
    const payload = buildTurnPayload({
      catalogs: catalogs(),
      composer: { ...composer(), prompt: '   ', referencedAttachmentIds: [] },
      sessionId: '55555555-5555-4555-8555-555555555555',
      createBindingId: () => bindingId,
    });
    expect(payload.message).toBe('');
    expect(payload.attachments).toMatchObject([{ binding_id: bindingId, resource_id: assetId }]);
  });
  it('builds all four immutable selections from current public catalogs', () => {
    const payload = buildTurnPayload({
      catalogs: catalogs(),
      composer: composer(),
      sessionId: '55555555-5555-4555-8555-555555555555',
      createBindingId: () => bindingId,
    });

    expect(payload).toMatchObject({
      session_id: '55555555-5555-4555-8555-555555555555',
      attachments: [{ binding_id: bindingId, resource_id: assetId, role: 'product' }],
      mention_bindings: [{ mention_key: '@商品原图', binding_id: bindingId }],
      skill_selection: {
        primary_skill_id: 'commerce-white-background@1.0.0',
        preset_selections: [{ slot: 'presentation', preset_id: 'clean-studio@1.0.0' }],
      },
      model_selection: { catalog_revision: 7 },
      generation_preferences: {
        schema_version: 2,
        output_kind: 'image',
        aspect_ratio: '1:1',
        resolution_tier: '2k',
      },
    });
    expect(payload).not.toHaveProperty('execution_authorization');
    expect(payload.generation_preferences).not.toHaveProperty('output_count');
  });

  it('rejects missing primary, required preset, stale models and demo attachments', () => {
    expect(() =>
      buildTurnPayload({
        catalogs: catalogs(),
        composer: { ...composer(), selectedSkillId: null },
      }),
    ).toThrow('请选择一个 Skill');
    expect(() =>
      buildTurnPayload({
        catalogs: catalogs(),
        composer: { ...composer(), selectedPresetIds: {} },
      }),
    ).toThrow('请选择展示方式');
    expect(() =>
      buildTurnPayload({
        catalogs: {
          ...catalogs(),
          imageModels: { ...catalogs().imageModels!, catalog_revision: 8 },
        },
        composer: composer(),
      }),
    ).toThrow('模型目录已更新');
    expect(() =>
      buildTurnPayload({
        catalogs: catalogs(),
        composer: {
          ...composer(),
          attachments: [
            {
              category: '示例',
              id: 'demo-image',
              imageUrl: '/demo/image.png',
              label: '示例图片',
              prompt: '',
              tags: '示例',
            },
          ],
        },
      }),
    ).toThrow('示例图片仅用于启发');
  });

  it('submits intelligent ratio as an explicit generation preference', () => {
    const payload = buildTurnPayload({
      catalogs: catalogs(),
      composer: { ...composer(), aspectRatio: 'auto' },
    });

    expect(payload.generation_preferences.aspect_ratio).toBe('auto');
  });

  it('allows a same-session continuation without a fresh attachment', () => {
    const payload = buildTurnPayload({
      catalogs: catalogs(),
      composer: { ...composer(), attachments: [], referencedAttachmentIds: [] },
      sessionId: '55555555-5555-4555-8555-555555555555',
    });

    expect(payload.session_id).toBe('55555555-5555-4555-8555-555555555555');
    expect(payload.attachments).toEqual([]);
  });

  it('still requires the source attachment when starting a new session', () => {
    expect(() =>
      buildTurnPayload({
        catalogs: catalogs(),
        composer: { ...composer(), attachments: [], referencedAttachmentIds: [] },
      }),
    ).toThrow('这个 Skill 需要至少一个图片附件');
  });

  it('accepts a text creative brief without inventing an image requirement', () => {
    const catalog = catalogs();
    catalog.skills!.items[0]!.required_inputs = ['creative-brief'];
    const payload = buildTurnPayload({
      catalogs: catalog,
      composer: { ...composer(), attachments: [], referencedAttachmentIds: [] },
    });
    expect(payload.message).toBe('做一张白底图');
    expect(payload.attachments).toEqual([]);
  });

  it.each(['identity_anchor', 'semantic-reference', 'authorized-scene-photo'])(
    'keeps the image requirement for %s in a new session',
    (requirement) => {
      const catalog = catalogs();
      catalog.skills!.items[0]!.required_inputs = ['creative-brief', requirement];
      expect(() =>
        buildTurnPayload({
          catalogs: catalog,
          composer: { ...composer(), attachments: [], referencedAttachmentIds: [] },
        }),
      ).toThrow('这个 Skill 需要至少一个图片附件');
    },
  );
});

function composer(): ComposerValue {
  return {
    agentMode: 'image',
    aspectRatio: '1:1',
    attachmentRoles: { [assetId]: 'product' },
    attachments: [
      {
        category: '商品',
        id: assetId,
        imageUrl: '/asset.png',
        label: '商品原图',
        prompt: '',
        tags: '商品',
        resourceType: 'asset',
        resourceVersion: 'sha256-content',
      },
    ],
    prompt: '做一张白底图',
    referencedAttachmentIds: [assetId],
    resolutionTier: '2k',
    selectedBrainModelId: brainId,
    selectedImageModelId: imageId,
    selectedPresetIds: { presentation: 'clean-studio@1.0.0' },
    selectedSkillId: 'commerce-white-background@1.0.0',
    videoDuration: '5 秒',
    videoResolution: '1080P',
  };
}

function catalogs(): AgentCatalogState {
  const model = (id: string, category: 'brain' | 'image') => ({
    id,
    public_slug: category,
    version_no: 1,
    category,
    display_name: category === 'brain' ? '创作助手' : '高清图片',
    description: '可用',
    public_capabilities: {},
    user_selectable: true,
    is_default: true,
    availability: 'available' as const,
    pricing_summary: [],
  });
  return {
    status: 'ready',
    error: '',
    brainModels: { catalog_revision: 7, items: [model(brainId, 'brain')] },
    imageModels: { catalog_revision: 7, items: [model(imageId, 'image')] },
    videoModels: { catalog_revision: 7, items: [] },
    skills: {
      catalog_version: 'skills-v1',
      response_version: 'response-v1',
      generation_policy: {
        schema_version: 2,
        policy_version: 'policy-v3',
      },
      items: [
        {
          primary_skill_id: 'commerce-white-background@1.0.0',
          slug: 'commerce-white-background',
          attachment_roles: [
            { role: 'product', label: '商品主图' },
            { role: 'style_reference', label: '风格参考' },
            { role: 'composition_reference', label: '构图参考' },
            { role: 'other', label: '其他' },
          ],
          version: '1.0.0',
          name: '商品白底精修',
          description: '白底图',
          domain: 'commerce',
          category: 'commerce',
          required_inputs: ['product_image'],
          preset_slots: [
            {
              slot: 'presentation',
              label: '展示方式',
              required: true,
              max_selections: 1,
              options: [
                {
                  preset_id: 'clean-studio@1.0.0',
                  name: '纯净棚拍',
                  description: '干净白底',
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
