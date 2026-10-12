import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { getBuiltinSkill, loadBuiltinResource } from './builtin.js';
import { loadBuiltinPackageSource } from './builtin-source.js';
import { parseSkillAuthorMarkdown } from './content-validator.js';

const packageRoot = fileURLToPath(new URL('../content/social-art-creative-v1/', import.meta.url));
const skillSlugs = [
  'photo-doodle-world',
  'yarn-miniature-scene',
  'bold-stroke-poster',
  'blue-white-porcelain-poster',
  'dunhuang-mural-poster',
  'silk-embroidery-poster',
] as const;

describe('social art built-in content', () => {
  it.each(skillSlugs)(
    'loads %s with one self-contained method and current source bytes',
    async (slug) => {
      const skill = await getBuiltinSkill(`${slug}@1.0.0`);
      const resource = await loadBuiltinResource(`${slug}@1.0.0`, 'SKILL.md');
      const packageSource = await loadBuiltinPackageSource(packageRoot);
      const source = await readFile(
        new URL(
          `../content/social-art-creative-v1/skill-package/skills/${slug}/SKILL.md`,
          import.meta.url,
        ),
        'utf8',
      );

      expect(skill).toBeDefined();
      expect(resource?.content).toBe(source);
      expect(resource?.resource.resource_hash).toBe(
        createHash('sha256').update(source).digest('hex'),
      );
      expect([...skill!.resources.keys()]).toEqual(['SKILL.md']);
      expect(skill!.definition.required_facts).toEqual([]);
      expect(
        parseSkillAuthorMarkdown(source, packageSource.manifest.skill_profiles[`${slug}@1.0.0`])
          .frontmatterFormat,
      ).toBe('portable');
    },
  );

  it.each(skillSlugs)(
    'ships three examples per required evaluation category for %s',
    async (slug) => {
      const source = await loadBuiltinPackageSource(packageRoot);
      const path = `skill-package/evals/${slug}.jsonl`;
      expect(source.manifest.eval_datasets).toContain(path);
      const evaluation = source.resources.find((resource) => resource.path === path);
      const cases = Buffer.from(evaluation!.content)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { case_id: string; category: string });

      for (const category of [
        'success',
        'missing_fact',
        'skill_mismatch',
        'material_role_drift',
        'prompt_injection',
      ]) {
        expect(cases.filter((item) => item.category === category).length).toBeGreaterThanOrEqual(3);
      }
      expect(cases.some((item) => item.category === 'cross_image_duplicate')).toBe(true);
      expect(new Set(cases.map((item) => item.case_id)).size).toBe(cases.length);
    },
  );
});
