import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { listBuiltinPackageRoots, loadBuiltinPackageSource } from './builtin-source.js';
import {
  packSkillPackage,
  parseSkillPackageManifest,
  readIsolatedSkillPackageBuffer,
  validateSkillPackageContents,
  type SkillPackageContentResource,
} from './index.js';

const portableSkillForbiddenMarkers = [
  'CREATIVE_.*PROTOCOL',
  'candidate_plan',
  'candidate plan',
  'image\\.edit',
  'load_skill@1',
  'semantic_reference',
  'creative_prompt',
  'creative_note',
  'source-rights-confirmed',
  'Provider',
  'Compiler',
  'Worker',
  'Brain',
  'terminal tool',
  '平台 Agent 契约',
] as const;

async function loadSource(root: string) {
  const manifest = parseSkillPackageManifest(
    JSON.parse(
      await readFile(resolve(root, 'skill-package/skill-package.json'), 'utf8'),
    ) as unknown,
  );
  const resources: SkillPackageContentResource[] = await Promise.all(
    manifest.resources.map(async (resource) => ({
      path: resource.path,
      mediaType: resource.media_type,
      content: await readFile(resolve(root, resource.path)),
    })),
  );
  return { manifest, resources };
}

export async function loadSourceAndPack(root: string, options?: { builtin: true }) {
  const source = options?.builtin ? await loadBuiltinPackageSource(root) : await loadSource(root);
  validateSkillPackageContents(source);
  const first = await packSkillPackage(source);
  const second = await packSkillPackage(source);
  if (!first.archive.equals(second.archive) || first.packageDigest !== second.packageDigest) {
    throw new Error('SKILL_CONTENT_NOT_REPRODUCIBLE');
  }
  return {
    isolated: await readIsolatedSkillPackageBuffer(first.archive),
    digest: first.packageDigest,
  };
}

export async function validateFirstReleaseSkillContent(
  workspaceRoot = process.env.INIT_CWD ?? process.cwd(),
) {
  const roots = await listBuiltinPackageRoots(resolve(workspaceRoot, 'packages/skills/content'));
  const packages = [];
  for (const root of roots) {
    packages.push(await loadSourceAndPack(root, { builtin: true }));
  }
  const packageIds = packages.map((item) => item.isolated.manifest.package_id);
  if (new Set(packageIds).size !== packageIds.length) {
    throw new Error('BUILTIN_SKILL_PACKAGE_DUPLICATE');
  }
  const skills = packages.flatMap((item) => item.isolated.validation.skills);
  const slugs = skills.map((skill) => skill.frontmatter.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error('BUILTIN_SKILL_SLUG_DUPLICATE');
  }
  const skillsById = new Map(skills.map((skill) => [skill.skillId, skill]));
  for (const skill of skills) {
    if (portableSkillForbiddenMarkers.some((marker) => new RegExp(marker, 'i').test(skill.body))) {
      throw new Error('SKILL_CONTENT_PLATFORM_PROTOCOL_LEAK');
    }
    if (skill.frontmatter.kind === 'primary' && !skill.frontmatter.execution_policy) {
      throw new Error('BUILTIN_SKILL_EXECUTION_POLICY_REQUIRED');
    }
    for (const dependency of skill.frontmatter.dependencies) {
      const target = skillsById.get(dependency.skill_id);
      if (!target || target.frontmatter.kind !== 'auxiliary') {
        throw new Error('BUILTIN_SKILL_DEPENDENCY_INVALID');
      }
    }
  }

  return {
    package_count: packages.length,
    primary_count: skills.filter((skill) => skill.frontmatter.kind === 'primary').length,
    auxiliary_count: skills.filter((skill) => skill.frontmatter.kind === 'auxiliary').length,
    package_digests: packages.map((item) => ({
      package_id: item.isolated.manifest.package_id,
      digest: item.digest,
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  console.info(
    JSON.stringify({
      event: 'builtin_skill_content_validated',
      ...(await validateFirstReleaseSkillContent()),
    }),
  );
}
