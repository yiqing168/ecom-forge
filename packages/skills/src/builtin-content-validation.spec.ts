import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scaffoldSkillPackage } from './authoring.js';
import { loadBuiltinSkillCatalog } from './builtin.js';
import { validateFirstReleaseSkillContent } from './first-release-validation-cli.js';
import type { SkillPackageManifest } from './package.js';

async function withWorkspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'ecom-forge-skill-validation-'));
  try {
    await mkdir(resolve(root, 'packages/skills/content'), { recursive: true });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addPackage(root: string, directory: string, slug: string) {
  const packageRoot = resolve(root, 'packages/skills/content', directory);
  for (const file of scaffoldSkillPackage({ slug, displayName: slug })) {
    const path = resolve(packageRoot, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  return {
    manifest: resolve(packageRoot, 'skill-package/skill-package.json'),
    definition: resolve(packageRoot, `skill-package/skills/${slug}/SKILL.md`),
    evaluation: resolve(packageRoot, `skill-package/evals/${slug}.jsonl`),
  };
}

async function reviseManifest(path: string, revise: (manifest: SkillPackageManifest) => void) {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as SkillPackageManifest;
  revise(manifest);
  await writeFile(path, `${JSON.stringify(manifest)}\n`);
}

describe('declarative built-in startup validation', () => {
  it('discovers unfamiliar packages and Skill names without another code inventory', async () => {
    await withWorkspace(async (root) => {
      const files = await addPackage(root, 'new-medium', 'paper-relief');
      await addPackage(root, 'another-package', 'glass-study');
      const manifestBefore = await readFile(files.manifest);
      const before = await validateFirstReleaseSkillContent(root);
      await writeFile(
        files.definition,
        '---\nname: paper-relief\ndescription: Explore relief shapes.\n---\n# Relief\nUse the photographed edges to choose one cut.\n',
      );
      const after = await validateFirstReleaseSkillContent(root);
      expect(after).toMatchObject({ package_count: 2, primary_count: 2, auxiliary_count: 0 });
      expect(after.package_digests).not.toEqual(before.package_digests);
      expect(await readFile(files.manifest)).toEqual(manifestBefore);
      const catalog = await loadBuiltinSkillCatalog(resolve(root, 'packages/skills/content'));
      expect(catalog.skills.map((skill) => skill.definition.slug).sort()).toEqual([
        'glass-study',
        'paper-relief',
      ]);
    });
  });

  it('rejects an empty content directory in validation and runtime', async () => {
    await withWorkspace(async (root) => {
      await expect(validateFirstReleaseSkillContent(root)).rejects.toThrow(
        'BUILTIN_SKILL_CONTENT_EMPTY',
      );
      await expect(
        loadBuiltinSkillCatalog(resolve(root, 'packages/skills/content')),
      ).rejects.toThrow('BUILTIN_SKILL_CONTENT_EMPTY');
    });
  });

  it('rejects duplicate package identities across directories', async () => {
    await withWorkspace(async (root) => {
      await addPackage(root, 'first', 'paper-relief');
      const files = await addPackage(root, 'second', 'glass-study');
      await reviseManifest(files.manifest, (manifest) => {
        manifest.package_id = 'paper-relief-package';
      });
      await expect(validateFirstReleaseSkillContent(root)).rejects.toThrow(
        'BUILTIN_SKILL_PACKAGE_DUPLICATE',
      );
    });
  });

  it('rejects duplicate Skill names even in distinct packages', async () => {
    await withWorkspace(async (root) => {
      await addPackage(root, 'first', 'paper-relief');
      const files = await addPackage(root, 'second', 'paper-relief');
      await reviseManifest(files.manifest, (manifest) => {
        manifest.package_id = 'another-package';
      });
      await expect(validateFirstReleaseSkillContent(root)).rejects.toThrow(
        'BUILTIN_SKILL_SLUG_DUPLICATE',
      );
    });
  });

  it('requires a complete golden dataset without a per-Skill list of art checks', async () => {
    await withWorkspace(async (root) => {
      const files = await addPackage(root, 'first', 'paper-relief');
      const evaluation = await readFile(files.evaluation, 'utf8');
      const cases = evaluation.trim().split('\n');
      await writeFile(files.evaluation, `${cases[0]}\n`);
      await expect(validateFirstReleaseSkillContent(root)).rejects.toThrow(
        'SKILL_GOLDEN_DATASET_INCOMPLETE',
      );
      await writeFile(files.evaluation, evaluation);
      await reviseManifest(files.manifest, (manifest) => {
        manifest.eval_datasets = [];
      });
      await expect(validateFirstReleaseSkillContent(root)).rejects.toThrow(
        'SKILL_GOLDEN_DATASET_MISSING',
      );
    });
  });

  it.each(['missing', 'primary'] as const)('rejects a %s dependency target', async (kind) => {
    await withWorkspace(async (root) => {
      const files = await addPackage(root, 'first', 'paper-relief');
      if (kind === 'primary') await addPackage(root, 'second', 'glass-study');
      await reviseManifest(files.manifest, (manifest) => {
        manifest.skill_profiles['paper-relief@0.1.0']!.dependencies = [
          { skill_id: 'glass-study@0.1.0', mode: 'optional', reason: 'Shared knowledge' },
        ];
      });
      await expect(validateFirstReleaseSkillContent(root)).rejects.toThrow(
        'BUILTIN_SKILL_DEPENDENCY_INVALID',
      );
    });
  });

  it('resolves auxiliary knowledge from a different discovered package', async () => {
    await withWorkspace(async (root) => {
      const primary = await addPackage(root, 'first', 'paper-relief');
      const auxiliary = await addPackage(root, 'second', 'glass-study');
      await reviseManifest(auxiliary.manifest, (manifest) => {
        const profile = manifest.skill_profiles['glass-study@0.1.0']!;
        profile.kind = 'auxiliary';
        profile.catalog = { visibility: 'internal' };
        delete profile.execution_policy;
        delete profile.attachment_roles;
      });
      await reviseManifest(primary.manifest, (manifest) => {
        manifest.skill_profiles['paper-relief@0.1.0']!.dependencies = [
          { skill_id: 'glass-study@0.1.0', mode: 'optional', reason: 'Shared knowledge' },
        ];
      });
      await expect(validateFirstReleaseSkillContent(root)).resolves.toMatchObject({
        primary_count: 1,
        auxiliary_count: 1,
      });
    });
  });

  it.each(['candidate_plan', 'image.edit'])(
    'keeps %s out of portable Skill bodies',
    async (marker) => {
      await withWorkspace(async (root) => {
        const files = await addPackage(root, 'first', 'paper-relief');
        const content = await readFile(files.definition, 'utf8');
        await writeFile(files.definition, `${content}\nReturn ${marker}.\n`);
        await expect(validateFirstReleaseSkillContent(root)).rejects.toThrow(
          'SKILL_CONTENT_PLATFORM_PROTOCOL_LEAK',
        );
      });
    },
  );
});
