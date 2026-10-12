import { describe, expect, it } from 'vitest';

import { getSkillAttachmentRoleOptions, resolveAttachmentRole } from './attachment-roles';
import type { SkillCatalogItem } from '@/lib/agent-api';

describe('creative attachment roles', () => {
  it('automatically binds watercolor uploads as source photographs', () => {
    const skill = {
      primary_skill_id: 'watercolor-scene-collage@1.0.0',
      slug: 'watercolor-scene-collage',
      attachment_roles: [{ role: 'semantic_reference', label: '实景照片' }],
      version: '1.0.0',
      name: '实景拼贴-水彩',
      description: '上方原照片，下方淡彩水彩微缩小景',
      domain: 'creative',
      category: 'creative',
      required_inputs: ['semantic-reference'],
      preset_slots: [],
    } satisfies SkillCatalogItem;
    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
    ]);
    expect(resolveAttachmentRole(skill, undefined)).toBe('semantic_reference');
  });

  it('offers still, style, and composition roles for cinematic story posters', () => {
    const skill = {
      primary_skill_id: 'cinematic-story-poster@1.1.0',
      slug: 'cinematic-story-poster',
      attachment_roles: [
        { role: 'semantic_reference', label: '实景照片' },
        { role: 'style_reference', label: '风格参考' },
        { role: 'composition_reference', label: '构图参考' },
        { role: 'other', label: '其他' },
      ],
      version: '1.1.0',
      name: '叙事电影海报',
      description: '从原创影片梗概与授权视觉素材生成单张海报',
      domain: 'creative',
      category: 'creative',
      required_inputs: ['creative-brief'],
      preset_slots: [],
    } satisfies SkillCatalogItem;

    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
      { label: '风格参考', role: 'style_reference' },
      { label: '构图参考', role: 'composition_reference' },
      { label: '其他', role: 'other' },
    ]);
  });

  it('uses the stable catalog slug across Skill versions', () => {
    const skill = {
      primary_skill_id: 'creative-scene-reimagining@9.4.0',
      slug: 'creative-scene-reimagining',
      attachment_roles: [{ role: 'semantic_reference', label: '实景照片' }],
      version: '9.4.0',
      name: '照片意象重绘',
      description: '重绘照片',
      domain: 'creative',
      category: 'photo-transform',
      required_inputs: ['source_image'],
      preset_slots: [],
    } satisfies SkillCatalogItem;

    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
    ]);
  });

  it('labels the collage source as a real-scene photo while preserving the semantic role', () => {
    const skill = {
      primary_skill_id: 'creative-scene-collage@1.1.1',
      slug: 'creative-scene-collage',
      attachment_roles: [{ role: 'semantic_reference', label: '实景照片' }],
      version: '1.1.1',
      name: '实景拼贴',
      description: '把实景照片扩展为纸感拼贴',
      domain: 'creative',
      category: 'creative',
      required_inputs: ['semantic-reference'],
      preset_slots: [],
    } satisfies SkillCatalogItem;

    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
    ]);
  });

  it('binds a xieyi source photo as one semantic reference', () => {
    const skill = {
      primary_skill_id: 'xieyi-scene-collage@1.0.0',
      slug: 'xieyi-scene-collage',
      attachment_roles: [{ role: 'semantic_reference', label: '实景照片' }],
      version: '1.0.0',
      name: '实景拼贴·写意纸境',
      description: '把实景照片组织为写意纸境',
      domain: 'creative',
      category: 'creative',
      required_inputs: ['semantic-reference'],
      preset_slots: [],
    } satisfies SkillCatalogItem;

    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
    ]);
  });

  it('binds a minimal collage source photo as one semantic reference', () => {
    const skill = {
      primary_skill_id: 'minimal-scene-collage@2.8.0',
      slug: 'minimal-scene-collage',
      attachment_roles: [{ role: 'semantic_reference', label: '实景照片' }],
      version: '2.0.0',
      name: '极简拼贴',
      description: '把实景照片转成上下双区极简拼贴',
      domain: 'creative',
      category: 'creative',
      required_inputs: ['semantic-reference'],
      preset_slots: [],
    } satisfies SkillCatalogItem;

    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
    ]);
  });

  it('binds a daily memory source photo as one semantic reference', () => {
    const skill = {
      primary_skill_id: 'daily-memory-page@1.1.0',
      slug: 'daily-memory-page',
      attachment_roles: [{ role: 'semantic_reference', label: '实景照片' }],
      version: '1.1.0',
      name: '实景转译·日常记忆页',
      description: '把实景照片转译为日常记忆页',
      domain: 'creative',
      category: 'creative',
      required_inputs: ['semantic-reference'],
      preset_slots: [],
    } satisfies SkillCatalogItem;

    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
    ]);
  });

  it('binds social contrast life materials as semantic references', () => {
    const skill = {
      primary_skill_id: 'social-contrast-poster@1.1.0',
      slug: 'social-contrast-poster',
      attachment_roles: [{ role: 'semantic_reference', label: '实景照片' }],
      version: '1.1.0',
      name: '日常反差海报',
      description: '把授权生活素材转成具有单一反差的社交海报',
      domain: 'creative',
      category: 'creative',
      required_inputs: ['semantic-reference'],
      preset_slots: [],
    } satisfies SkillCatalogItem;

    expect(getSkillAttachmentRoleOptions(skill)).toEqual([
      { label: '实景照片', role: 'semantic_reference' },
    ]);
  });
});
