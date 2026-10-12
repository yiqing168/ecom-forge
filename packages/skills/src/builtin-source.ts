import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { synchronizeSkillPackageManifest } from './authoring.js';
import { validateSkillPackageContents } from './content-validator.js';
import { parseSkillPackageManifest } from './package.js';

export async function listBuiltinPackageRoots(contentRoot: string): Promise<string[]> {
  const directories = (await readdir(contentRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (directories.length === 0) throw new Error('BUILTIN_SKILL_CONTENT_EMPTY');
  return directories.map((directory) => resolve(contentRoot, directory));
}

/** Built-in manifests are resource inventories; actual bytes define content identity. */
export async function loadBuiltinPackageSource(root: string) {
  const inventory = parseSkillPackageManifest(
    JSON.parse(
      await readFile(resolve(root, 'skill-package/skill-package.json'), 'utf8'),
    ) as unknown,
  );
  const resources = await Promise.all(
    inventory.resources.map(async (resource) => ({
      path: resource.path,
      mediaType: resource.media_type,
      content: await readFile(resolve(root, resource.path)),
    })),
  );
  const manifest = synchronizeSkillPackageManifest({ manifest: inventory, resources });
  validateSkillPackageContents({ manifest, resources });
  return { manifest, resources };
}
