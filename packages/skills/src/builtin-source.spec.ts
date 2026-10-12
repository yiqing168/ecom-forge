import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scaffoldSkillPackage, packSkillPackage } from './authoring.js';
import { loadBuiltinSkillCatalog } from './builtin.js';
import { loadBuiltinPackageSource } from './builtin-source.js';
import { loadSourceAndPack } from './first-release-validation-cli.js';

async function withSource(
  run: (root: string, packageRoot: string, skillPath: string) => Promise<void>,
) {
  const root = await mkdtemp(resolve(tmpdir(), 'ecom-forge-builtin-content-'));
  const packageRoot = resolve(root, 'first-party');
  try {
    for (const file of scaffoldSkillPackage({
      slug: 'product-story',
      displayName: 'Product Story',
    })) {
      const path = resolve(packageRoot, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
    }
    await run(
      root,
      packageRoot,
      resolve(packageRoot, 'skill-package/skills/product-story/SKILL.md'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('built-in content-only revisions', () => {
  it('loads an unsynchronized Markdown revision on restart without changing inventory or version', async () => {
    await withSource(async (root, packageRoot, path) => {
      const manifestPath = resolve(packageRoot, 'skill-package/skill-package.json');
      const manifestBefore = await readFile(manifestPath);
      const before = await loadBuiltinSkillCatalog(root);
      const oldSkill = before.skills[0]!;
      const oldContent = oldSkill.resourceContent.get('SKILL.md');
      const content = `${oldContent}\nA new source-specific creative method.\n`;
      await writeFile(path, content);
      const after = await loadBuiltinSkillCatalog(root);
      const current = after.skills[0]!;
      expect(current.skillId).toBe(oldSkill.skillId);
      expect(current.definitionHash).not.toBe(oldSkill.definitionHash);
      expect(current.packageDigest).not.toBe(oldSkill.packageDigest);
      expect(after.catalogVersion).not.toBe(before.catalogVersion);
      expect(current.resources.get('SKILL.md')?.resource_snapshot_id).not.toBe(
        oldSkill.resources.get('SKILL.md')?.resource_snapshot_id,
      );
      expect(current.resourceContent.get('SKILL.md')).toBe(content);
      expect(oldSkill.resourceContent.get('SKILL.md')).toBe(oldContent);
      expect(await readFile(manifestPath)).toEqual(manifestBefore);
      const packed = await loadSourceAndPack(packageRoot, { builtin: true });
      expect(packed.digest).toBe(current.packageDigest);
      await expect(loadSourceAndPack(packageRoot)).rejects.toThrow(
        'SKILL_PACKAGE_RESOURCE_DIGEST_MISMATCH',
      );
    });
  });

  it('updates listed non-definition content but does not discover unlisted files', async () => {
    await withSource(async (root, packageRoot) => {
      const before = await loadBuiltinSkillCatalog(root);
      await writeFile(resolve(packageRoot, 'unlisted.md'), 'Not an authorized Skill resource.');
      expect((await loadBuiltinSkillCatalog(root)).catalogVersion).toBe(before.catalogVersion);
      const evaluation = resolve(packageRoot, 'skill-package/evals/product-story.jsonl');
      const content = await readFile(evaluation, 'utf8');
      await writeFile(
        evaluation,
        content.replace('Example success request', 'A revised success request'),
      );
      const source = await loadBuiltinPackageSource(packageRoot);
      expect((await loadBuiltinSkillCatalog(root)).catalogVersion).not.toBe(before.catalogVersion);
      await expect(packSkillPackage(source)).resolves.toHaveProperty('packageDigest');
    });
  });

  it('still rejects missing inventoried resources and invalid portable identities', async () => {
    await withSource(async (root, packageRoot, path) => {
      const content = await readFile(path, 'utf8');
      await writeFile(path, content.replace('name: product-story', 'name: another-skill'));
      await expect(loadBuiltinSkillCatalog(root)).rejects.toThrow();
      await writeFile(path, content);
      await unlink(resolve(packageRoot, 'skill-package/evals/product-story.jsonl'));
      await expect(loadBuiltinSkillCatalog(root)).rejects.toThrow();
    });
  });
});
