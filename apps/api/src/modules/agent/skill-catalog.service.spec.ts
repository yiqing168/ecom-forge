import { describe, expect, it } from 'vitest';
import { getBuiltinSkillCatalog } from '@ecom-forge/skills';

import {
  excludeBuiltinSlugCollisions,
  latestPublishedSkillBySlug,
  SkillCatalogService,
} from './skill-catalog.service.js';

function published(id: string, slug: string, version: string, sortOrder: number) {
  return { row: { id, slug, version, sortOrder } };
}

describe('latestPublishedSkillBySlug', () => {
  it('exposes only the highest strict SemVer for each slug', () => {
    expect(
      latestPublishedSkillBySlug([
        published('scene@1.9.0', 'scene', '1.9.0', 20),
        published('portrait@2.0.0', 'portrait', '2.0.0', 10),
        published('scene@1.10.0', 'scene', '1.10.0', 20),
        published('scene@1.2.9', 'scene', '1.2.9', 20),
      ]).map((item) => item.row.id),
    ).toEqual(['portrait@2.0.0', 'scene@1.10.0']);
  });

  it('fails closed for a version outside the Skill contract', () => {
    expect(() =>
      latestPublishedSkillBySlug([
        published('scene@1.0.0', 'scene', '1.0.0', 10),
        published('scene@latest', 'scene', 'latest', 10),
      ]),
    ).toThrow('SKILL_VERSION_INVALID');
  });
});

describe('excludeBuiltinSlugCollisions', () => {
  it('prevents an external version from shadowing a built-in Skill slug', () => {
    expect(
      excludeBuiltinSlugCollisions(
        [
          { slug: 'creative-scene-reimagining', id: 'external-scene@9.9.9' },
          { slug: 'external-only', id: 'external-only@1.0.0' },
        ],
        [{ slug: 'creative-scene-reimagining' }],
      ),
    ).toEqual([{ slug: 'external-only', id: 'external-only@1.0.0' }]);
  });
});

describe('builtin Skill catalog', () => {
  const database = {
    query: {
      skillCatalogState: { findFirst: () => Promise.resolve(undefined) },
    },
  } as never;

  it('uses manifest visibility for the complete public catalog', async () => {
    const catalog = await new SkillCatalogService(database).list();
    const builtin = await getBuiltinSkillCatalog();
    const visible = builtin.skills
      .filter(
        (item) => item.definition.kind === 'primary' && item.definition.catalog_enabled !== false,
      )
      .map((item) => item.skillId)
      .sort();
    expect(catalog.items.map((item) => item.primary_skill_id).sort()).toEqual(visible);
    expect(catalog.items.some((item) => item.slug === 'xieyi-scene-collage')).toBe(false);
    expect(catalog.items.some((item) => item.slug === 'one-scene-three-crafts')).toBe(false);
    expect(builtin.skills.some((item) => item.definition.slug === 'xieyi-scene-collage')).toBe(
      true,
    );
  });

  it('lists built-in primary Skills without a database release', async () => {
    const catalog = await new SkillCatalogService(database).list('creative');
    const scene = catalog.items.find(
      (item) => item.primary_skill_id === 'creative-scene-reimagining@1.3.1',
    );
    const sceneCollage = catalog.items.find(
      (item) => item.primary_skill_id === 'creative-scene-collage@1.4.2',
    );
    const xieyi = catalog.items.find(
      (item) => item.primary_skill_id === 'xieyi-scene-collage@1.0.0',
    );
    const watercolor = catalog.items.find((item) => item.slug === 'watercolor-scene-collage');
    const dailyMemory = catalog.items.find(
      (item) => item.primary_skill_id === 'daily-memory-page@1.1.0',
    );
    const cinematicPoster = catalog.items.find(
      (item) => item.primary_skill_id === 'cinematic-story-poster@1.1.0',
    );
    const socialContrastPoster = catalog.items.find(
      (item) => item.primary_skill_id === 'social-contrast-poster@1.1.0',
    );

    expect(scene?.name).toBe('照片意象重绘');
    expect(sceneCollage?.name).toBe('实景拼贴');
    expect(xieyi).toBeUndefined();
    expect(dailyMemory?.name).toBe('实景转译·日常记忆页');
    expect(dailyMemory?.required_inputs).toEqual(['semantic-reference']);
    expect(cinematicPoster).toBeUndefined();
    expect(catalog.items.some((item) => item.slug === 'creative-portrait-renewal')).toBe(false);
    expect(watercolor?.name).toBe('实景拼贴-水彩');
    expect(watercolor?.required_inputs).toEqual(['semantic-reference']);
    expect(socialContrastPoster?.name).toBe('日常反差海报');
    expect(socialContrastPoster?.required_inputs).toEqual(['semantic-reference']);
    expect(scene && 'definition_hash' in scene).toBe(false);
  });

  it('resolves a built-in selection without approval or publication rows', async () => {
    const resolved = await new SkillCatalogService(database).resolveSelection({
      primary_skill_id: 'creative-scene-reimagining@1.3.1',
      preset_selections: [],
    });

    expect(resolved.snapshot.primary_skill_id).toBe('creative-scene-reimagining@1.3.1');
    expect(resolved.requiredCapabilities).toEqual(['image.edit']);
    expect(resolved.snapshot.primary_planning_resource.resource_path).toBe('SKILL.md');
  });

  it('allows free creation without a style and makes all shared knowledge optional', async () => {
    const service = new SkillCatalogService(database);
    const catalog = await service.list();
    const free = catalog.items.find((item) => item.slug === 'creative-free-generation');
    expect(free?.preset_slots).toEqual([]);
    expect(free?.required_inputs).toEqual([]);
    const resolved = await service.resolveSelection({
      primary_skill_id: free!.primary_skill_id,
      preset_selections: [],
    });
    expect(resolved.requiredCapabilities).toEqual(['image.generate']);
    expect(resolved.snapshot).toMatchObject({
      preset_selections: [],
      required_auxiliary: [],
      execution_policy: { version: 1, family: 'text_generation', max_sources: 9 },
    });
    expect(resolved.snapshot.optional_auxiliary).toHaveLength(4);
    await expect(
      service.resolveSelection({
        primary_skill_id: free!.primary_skill_id,
        preset_selections: [{ slot: 'visual-direction', preset_id: 'natural-cinematic@1.0.0' }],
      }),
    ).rejects.toThrow('SKILL_SELECTION_INVALID');
  });

  it.each([
    ['photo-doodle-world@1.0.0', '现实涂鸦'],
    ['yarn-miniature-scene@1.0.0', '绒线微景'],
    ['bold-stroke-poster@1.0.0', '粗笔艺术海报'],
    ['blue-white-porcelain-poster@1.0.0', '青花瓷绘'],
    ['dunhuang-mural-poster@1.0.0', '敦煌壁画'],
    ['silk-embroidery-poster@1.0.0', '刺绣锦缎'],
  ])('lists and resolves %s through the shared photo policy', async (skillId, name) => {
    const service = new SkillCatalogService(database);
    const catalog = await service.list('creative');
    const item = catalog.items.find((entry) => entry.primary_skill_id === skillId);
    expect(item).toMatchObject({
      name,
      required_inputs: ['semantic-reference'],
      attachment_roles: [{ role: 'semantic_reference', label: '源照片' }],
      preset_slots: [],
    });

    const resolved = await service.resolveSelection({
      primary_skill_id: skillId,
      preset_selections: [],
    });
    expect(resolved.requiredCapabilities).toEqual(['image.edit']);
    expect(resolved.snapshot).toMatchObject({
      primary_skill_id: skillId,
      execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
      default_output_count: 1,
      primary_planning_resource: { resource_path: 'SKILL.md' },
      required_auxiliary: [],
      preset_selections: [],
    });
    expect(resolved.snapshot.optional_auxiliary.map((entry) => entry.skill_id)).toEqual([
      'creative-image-prompting@1.1.0',
    ]);
  });

  it('resolves watercolor photo inputs and preserves hidden Skill history', async () => {
    const service = new SkillCatalogService(database);
    const watercolor = await service.resolveSelection({
      primary_skill_id: 'watercolor-scene-collage@1.0.0',
      preset_selections: [],
    });
    expect(watercolor.requiredCapabilities).toEqual(['image.edit']);
    expect(watercolor.snapshot.primary_planning_resource.resource_path).toBe('SKILL.md');
    const cinematic = await service.resolveSelection({
      primary_skill_id: 'cinematic-story-poster@1.1.0',
      preset_selections: [],
    });
    expect(cinematic.snapshot.primary_skill_id).toBe('cinematic-story-poster@1.1.0');
    const portrait = await service.resolveSelection({
      primary_skill_id: 'creative-portrait-renewal@1.0.0',
      preset_selections: [{ slot: 'portrait-direction', preset_id: 'clear-daylight@1.0.0' }],
    });
    expect(portrait.snapshot.primary_skill_id).toBe('creative-portrait-renewal@1.0.0');
  });

  it('normalizes a stale built-in version selection to the current shipped version', async () => {
    const resolved = await new SkillCatalogService(database).resolveSelection({
      primary_skill_id: 'creative-scene-reimagining@0.0.1',
      preset_selections: [],
    });

    expect(resolved.snapshot.primary_skill_id).toBe('creative-scene-reimagining@1.3.1');
  });
});
