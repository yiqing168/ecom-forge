import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  getBuiltinSkill,
  getBuiltinSkillCatalog,
  loadBuiltinResource,
  resolveBuiltinSkill,
} from './builtin.js';

describe('builtin skill catalog', () => {
  it('loads the watercolor method with authorized photo input and a current content hash', async () => {
    const skill = await getBuiltinSkill('watercolor-scene-collage@1.0.1');
    const resource = await loadBuiltinResource('watercolor-scene-collage@1.0.1', 'SKILL.md');
    expect(skill?.definition.display_name).toBe('实景拼贴-水彩');
    expect(skill?.definition.required_inputs).toEqual(['semantic-reference']);
    expect(skill?.definition.required_facts).toEqual([]);
    expect(skill?.definition.required_capabilities).toEqual(['image.edit']);
    expect(skill?.definition.default_output_count).toBe(1);
    expect(resource?.content).toBe(skill?.resourceContent.get('SKILL.md'));
    expect(resource?.resource.resource_hash).toBe(
      createHash('sha256')
        .update(resource?.content ?? '')
        .digest('hex'),
    );
  });

  it('resolves the previous watercolor version to the current method and matching resource', async () => {
    const current = await getBuiltinSkill('watercolor-scene-collage@1.0.1');
    const resolved = await resolveBuiltinSkill('watercolor-scene-collage@1.0.0');
    const resource = await loadBuiltinResource('watercolor-scene-collage@1.0.0', 'SKILL.md');

    expect(current).toBeDefined();
    expect(resolved?.skillId).toBe(current?.skillId);
    expect(resource).toBeDefined();
    expect(resource?.content).toBe(current?.resourceContent.get('SKILL.md'));
    expect(resource?.resource.resource_hash).toBe(
      current?.resources.get('SKILL.md')?.resource_hash,
    );
    expect(resolved?.definition.required_inputs).toEqual(['semantic-reference']);
    expect(resolved?.definition.default_output_count).toBe(1);
  });

  it('loads first-party skills directly from the shipped content tree', async () => {
    const catalog = await getBuiltinSkillCatalog();
    const scene = await getBuiltinSkill('creative-scene-reimagining@1.3.1');

    expect(catalog.skills.length).toBeGreaterThan(0);
    expect(scene?.definition.display_name).toBe('照片意象重绘');
    expect(scene?.definition.required_facts).toEqual([]);
    expect(scene?.resources.get('SKILL.md')?.resource_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns current resource content and verifies its hash', async () => {
    const resource = await loadBuiltinResource('creative-scene-reimagining@1.3.1', 'SKILL.md');

    expect(resource?.content).toContain('Creative Decision Process');
    expect(resource?.resource.resource_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('resolves stale built-in version IDs to the currently shipped content', async () => {
    const skill = await resolveBuiltinSkill('creative-scene-reimagining@0.0.1');
    const resource = await loadBuiltinResource('creative-scene-reimagining@0.0.1', 'SKILL.md');

    expect(skill?.skillId).toBe('creative-scene-reimagining@1.3.1');
    expect(resource?.resource.resource_hash).toBe(skill?.resources.get('SKILL.md')?.resource_hash);
  });

  it.each(['1.0.0', '1.0.3'])(
    'loads the photo-line method for stale selection %s',
    async (version) => {
      const skill = await resolveBuiltinSkill(`second-world-photo-remix@${version}`);
      const resource = await loadBuiltinResource(`second-world-photo-remix@${version}`, 'SKILL.md');

      expect(skill?.skillId).toBe('second-world-photo-remix@1.0.4');
      expect(skill?.definition.display_name).toBe('实景延伸线稿');
      expect(skill?.definition.required_inputs).toEqual(['semantic-reference']);
      expect(skill?.definition.required_facts).toEqual([]);
      expect(skill?.definition.default_output_count).toBe(1);
      expect(resource?.content).toContain('# 实景延伸线稿');
      expect(resource?.content).toContain('3:4 竖版');
      expect(resource?.content).toContain('连续穿过中线');
      expect(resource?.content).toContain('2–5 个英文单词');
      expect(resource?.content).not.toContain('第二世界');
      expect(resource?.content).not.toContain('视觉DNA');
      expect(resource?.resource.resource_hash).toBe(
        skill?.resources.get('SKILL.md')?.resource_hash,
      );
      expect(resource?.content).toBe(skill?.resourceContent.get('SKILL.md'));
      expect(resource?.resource.resource_hash).toBe(
        createHash('sha256')
          .update(resource?.content ?? '')
          .digest('hex'),
      );
    },
  );

  it('resolves a previous void-line selection to the current method and resource hash', async () => {
    const skill = await resolveBuiltinSkill('void-line-poster@1.1.0');
    const resource = await loadBuiltinResource('void-line-poster@1.1.0', 'SKILL.md');

    expect(skill?.definition.slug).toBe('void-line-poster');
    expect(skill?.definition.required_facts).toEqual([]);
    expect(skill?.definition.default_output_count).toBe(1);
    expect(resource?.resource.resource_hash).toBe(skill?.resources.get('SKILL.md')?.resource_hash);
    expect(resource?.resource.resource_hash).toBe(
      createHash('sha256')
        .update(resource?.content ?? '')
        .digest('hex'),
    );
    expect(resource?.content).toBe(skill?.resourceContent.get('SKILL.md'));
    expect(resource?.content).toMatch(/^---\r?\nname: void-line-poster\r?\n/);
  });
});
