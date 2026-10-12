import { canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import { skillPlatformProfileSchema } from './platform-profile.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safePath = z.string().min(1).max(240);

export const skillPackageManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  package_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  package_version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  min_runtime_version: z.string().min(1).max(64),
  skills: z
    .array(
      z.strictObject({
        skill_id: z.string().min(3).max(160),
        definition_path: safePath,
        definition_hash: sha256,
      }),
    )
    .min(1)
    .max(32),
  skill_profiles: z.record(z.string().min(3).max(160), skillPlatformProfileSchema),
  resources: z
    .array(
      z.strictObject({
        path: safePath,
        purpose: z.string().min(1).max(80),
        media_type: z.enum([
          'text/markdown',
          'application/json',
          'application/jsonl',
          'image/png',
          'image/jpeg',
          'image/webp',
        ]),
        byte_size: z
          .int()
          .positive()
          .max(16 * 1024 * 1024),
        content_hash: sha256,
      }),
    )
    .max(256),
  eval_datasets: z.array(safePath).max(32).default([]),
  assets: z.array(safePath).max(64).default([]),
  source_provenance: z.strictObject({
    type: z.enum(['first_party', 'legacy_owned', 'admin_upload']),
    summary_digest: sha256,
  }),
  license_summary: z
    .array(
      z.strictObject({
        path: safePath,
        license: z.string().min(1).max(160),
        rights_holder: z.string().min(1).max(160),
      }),
    )
    .min(1)
    .max(256),
});

export type SkillPackageManifest = z.infer<typeof skillPackageManifestSchema>;

const forbiddenExtensions =
  /\.(?:js|mjs|cjs|ts|tsx|jsx|wasm|exe|dll|so|sh|bat|cmd|ps1|html|svg|pdf|zip|tar|gz|woff2?|ttf|otf)$/i;

export function parseSkillPackageManifest(input: unknown): SkillPackageManifest {
  const result = skillPackageManifestSchema.safeParse(input);
  if (!result.success) throw new Error('SKILL_PACKAGE_MANIFEST_INVALID');
  const normalized = new Set<string>();
  const paths = result.data.resources.map((item) => item.path);
  for (const path of paths) {
    if (
      path !== path.normalize('NFC') ||
      path.includes('\\') ||
      path.includes('..') ||
      path.startsWith('/') ||
      /^[A-Za-z]:/.test(path) ||
      forbiddenExtensions.test(path)
    ) {
      throw new Error('SKILL_PACKAGE_PATH_INVALID');
    }
    const collisionKey = path.toLocaleLowerCase('en-US');
    if (normalized.has(collisionKey)) throw new Error('SKILL_PACKAGE_PATH_COLLISION');
    normalized.add(collisionKey);
  }
  const resourcePaths = new Set(result.data.resources.map((item) => item.path));
  if (
    result.data.resources.some((item) => {
      const limit = item.media_type.startsWith('image/') ? 16 * 1024 * 1024 : 1024 * 1024;
      return item.byte_size > limit;
    })
  ) {
    throw new Error('SKILL_PACKAGE_RESOURCE_SIZE_INVALID');
  }
  const skillIds = result.data.skills.map((item) => item.skill_id);
  if (new Set(skillIds).size !== skillIds.length) throw new Error('SKILL_PACKAGE_SKILL_DUPLICATE');
  const profileIds = Object.keys(result.data.skill_profiles);
  if (
    profileIds.length !== skillIds.length ||
    skillIds.some((skillId) => !result.data.skill_profiles[skillId]) ||
    profileIds.some((skillId) => !skillIds.includes(skillId))
  ) {
    throw new Error('SKILL_PACKAGE_PROFILE_INVENTORY_MISMATCH');
  }
  for (const skill of result.data.skills) {
    const expectedSlug = skill.skill_id.slice(0, skill.skill_id.lastIndexOf('@'));
    const profile = result.data.skill_profiles[skill.skill_id];
    if (
      !profile ||
      `${profile.slug}@${profile.version}` !== skill.skill_id ||
      skill.definition_path !== `skill-package/skills/${expectedSlug}/SKILL.md` ||
      !resourcePaths.has(skill.definition_path)
    )
      throw new Error('SKILL_PACKAGE_RESOURCE_MISSING');
  }
  for (const licensed of result.data.license_summary) {
    if (!resourcePaths.has(licensed.path)) throw new Error('SKILL_PACKAGE_LICENSE_INVALID');
  }
  const licensedPaths = new Set(result.data.license_summary.map((item) => item.path));
  if ([...resourcePaths].some((path) => !licensedPaths.has(path))) {
    throw new Error('SKILL_PACKAGE_LICENSE_MISSING');
  }
  return result.data;
}

export function skillPackageDigest(manifest: SkillPackageManifest): string {
  return canonicalSha256({
    manifest,
    resources: [...manifest.resources]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, content_hash }) => ({ path, content_hash })),
  });
}
