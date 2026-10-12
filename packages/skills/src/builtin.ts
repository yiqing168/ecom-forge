import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';

import { parseSkillAuthorMarkdown } from './content-validator.js';
import { parseSkillDefinition, type SkillDefinition } from './definition.js';
import { listBuiltinPackageRoots, loadBuiltinPackageSource } from './builtin-source.js';
import { skillPackageDigest, type SkillPackageManifest } from './package.js';
import type { SkillResourceSelectionSnapshot } from './runtime.js';

const BUILTIN_CONTENT_DIRECTORY = 'content';

export interface BuiltinSkill {
  skillId: string;
  definition: SkillDefinition;
  definitionHash: string;
  packageRecordId: string;
  packageDigest: string;
  releaseDigest: string;
  catalogReleaseId: string;
  catalogVersion: string;
  resources: Map<string, SkillResourceSelectionSnapshot>;
  resourceContent: Map<string, string>;
}

export interface BuiltinSkillCatalog {
  catalogReleaseId: string;
  catalogVersion: string;
  skills: BuiltinSkill[];
}

let catalogPromise: Promise<BuiltinSkillCatalog> | undefined;

export async function getBuiltinSkillCatalog(): Promise<BuiltinSkillCatalog> {
  catalogPromise ??= loadBuiltinSkillCatalog();
  return catalogPromise;
}

export async function getBuiltinSkill(skillId: string): Promise<BuiltinSkill | undefined> {
  const catalog = await getBuiltinSkillCatalog();
  return catalog.skills.find((skill) => skill.skillId === skillId);
}

/**
 * Built-in Skill versions are audit identities. Runtime content is selected by
 * slug so a stale browser or queued turn cannot make a newly deployed Skill
 * unavailable merely because its recorded version is older.
 */
export async function resolveBuiltinSkill(skillId: string): Promise<BuiltinSkill | undefined> {
  const catalog = await getBuiltinSkillCatalog();
  const exact = catalog.skills.find((skill) => skill.skillId === skillId);
  if (exact) return exact;
  const separator = skillId.lastIndexOf('@');
  if (separator <= 0) return undefined;
  const slug = skillId.slice(0, separator);
  return catalog.skills.find((skill) => skill.definition.slug === slug);
}

export async function loadBuiltinResource(
  skillId: string,
  resourcePath: string,
): Promise<
  | {
      resource: SkillResourceSelectionSnapshot;
      content: string;
    }
  | undefined
> {
  const skill = await resolveBuiltinSkill(skillId);
  if (!skill) return undefined;
  const resource = skill.resources.get(resourcePath);
  const content = skill.resourceContent.get(resourcePath);
  if (!resource || content === undefined) throw new Error('SKILL_VERSION_DRIFT');
  return { resource, content };
}

export function builtinUuid(namespace: string): string {
  const digest = canonicalSha256(namespace);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function loadBuiltinSkillCatalog(
  contentDirectory?: string,
): Promise<BuiltinSkillCatalog> {
  const contentRoot = contentDirectory ?? (await locateContentRoot());
  const packageRoots = await listBuiltinPackageRoots(contentRoot);
  const packages = await Promise.all(packageRoots.map(readBuiltinPackage));
  const skills = packages.flatMap((item) => item.skills);
  const slugs = skills.map((skill) => skill.definition.slug);
  if (new Set(slugs).size !== slugs.length) {
    throw new Error('BUILTIN_SKILL_SLUG_DUPLICATE');
  }
  const catalogVersion = canonicalSha256(
    packages.map((item) => ({
      package_digest: item.packageDigest,
      skills: item.skills.map((skill) => skill.skillId).sort(),
    })),
  );
  const catalogReleaseId = builtinUuid(`catalog:${catalogVersion}`);
  return {
    catalogReleaseId,
    catalogVersion,
    skills: skills.map((skill) => ({
      ...skill,
      catalogReleaseId,
      catalogVersion,
      releaseDigest: catalogVersion,
    })),
  };
}

async function readBuiltinPackage(packageRoot: string): Promise<{
  packageDigest: string;
  skills: BuiltinSkill[];
}> {
  const { manifest, resources } = await loadBuiltinPackageSource(packageRoot);
  const contentByPath = new Map(
    resources.map((item) => [item.path, item.content.toString('utf8')]),
  );
  const packageDigest = skillPackageDigest(manifest);
  const packageRecordId = builtinUuid(`package:${manifest.package_id}:${manifest.package_version}`);
  const skills = manifest.skills.map((inventory) => {
    const source = contentByPath.get(inventory.definition_path);
    if (source === undefined) throw new Error('BUILTIN_SKILL_RESOURCE_MISSING');
    const parsed = parseSkillAuthorMarkdown(source, manifest.skill_profiles[inventory.skill_id]);
    const definition = parseSkillDefinition({
      schema_version: 1,
      slug: parsed.frontmatter.slug,
      version: parsed.frontmatter.version,
      display_name: parsed.frontmatter.display_name,
      description: parsed.frontmatter.description,
      kind: parsed.frontmatter.kind,
      visibility: parsed.frontmatter.catalog.visibility,
      domain: parsed.frontmatter.domain,
      category: parsed.frontmatter.category,
      stage: parsed.frontmatter.stage,
      sort_order: parsed.frontmatter.sort_order,
      required_inputs: parsed.frontmatter.required_inputs,
      required_facts: parsed.frontmatter.required_facts,
      required_capabilities: parsed.frontmatter.required_capabilities,
      default_output_count: parsed.frontmatter.default_output_count,
      ...(parsed.frontmatter.execution_policy
        ? { execution_policy: parsed.frontmatter.execution_policy }
        : {}),
      ...(parsed.frontmatter.attachment_roles
        ? { attachment_roles: parsed.frontmatter.attachment_roles }
        : {}),
      ...(parsed.frontmatter.catalog_enabled !== undefined
        ? { catalog_enabled: parsed.frontmatter.catalog_enabled }
        : {}),
      planning_view: { path: 'SKILL.md', content_hash: inventory.definition_hash },
      preset_slots: parsed.frontmatter.preset_slots.map((slot) => ({
        slot: slot.slot,
        label: slot.label,
        required: slot.required,
        max_selections: slot.max_selections,
        options: slot.options.map((option) => ({
          preset_id: option.preset_id,
          name: option.name,
          description: option.description,
          resource_path: option.resource_path,
          resource_hash: resourceHash(inventory.definition_path, option.resource_path, manifest),
          disabled: false,
        })),
      })),
      dependencies: parsed.frontmatter.dependencies,
      references: parsed.frontmatter.references.map((reference) => ({
        path: reference.path,
        content_hash: resourceHash(inventory.definition_path, reference.path, manifest),
      })),
    });
    const skillId = `${definition.slug}@${definition.version}`;
    if (definition.kind === 'primary' && !definition.execution_policy) {
      throw new Error('BUILTIN_SKILL_EXECUTION_POLICY_REQUIRED');
    }
    const prefix = inventory.definition_path.slice(0, -'SKILL.md'.length);
    const ownedResources = new Map<string, SkillResourceSelectionSnapshot>();
    const resourceContent = new Map<string, string>();
    for (const item of manifest.resources) {
      if (!item.path.startsWith(prefix)) continue;
      const resourcePath = item.path.slice(prefix.length);
      if (!/^(SKILL\.md|presets\/|references\/)/.test(resourcePath)) continue;
      const content = contentByPath.get(item.path);
      if (content === undefined) throw new Error('BUILTIN_SKILL_RESOURCE_MISSING');
      ownedResources.set(resourcePath, {
        resource_snapshot_id: builtinUuid(
          `snapshot:${skillId}:${resourcePath}:${item.content_hash}`,
        ),
        package_resource_id: builtinUuid(`resource:${manifest.package_id}:${item.path}`),
        resource_path: resourcePath,
        resource_hash: item.content_hash,
      });
      resourceContent.set(resourcePath, content);
    }
    if (!ownedResources.has('SKILL.md')) throw new Error('BUILTIN_SKILL_RESOURCE_MISSING');
    return {
      skillId,
      definition,
      definitionHash: canonicalSha256(definition),
      packageRecordId,
      packageDigest,
      releaseDigest: packageDigest,
      catalogReleaseId: builtinUuid(`release:${manifest.package_id}:${manifest.package_version}`),
      catalogVersion: packageDigest,
      resources: ownedResources,
      resourceContent,
    };
  });
  return { packageDigest, skills };
}

function resourceHash(
  definitionPath: string,
  relativePath: string,
  manifest: SkillPackageManifest,
): string {
  const fullPath = `${definitionPath.slice(0, -'SKILL.md'.length)}${relativePath}`;
  const resource = manifest.resources.find((item) => item.path === fullPath);
  if (!resource) throw new Error('BUILTIN_SKILL_RESOURCE_MISSING');
  return resource.content_hash;
}

async function locateContentRoot(): Promise<string> {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '..', BUILTIN_CONTENT_DIRECTORY),
    resolve(process.cwd(), 'packages', 'skills', BUILTIN_CONTENT_DIRECTORY),
  ];
  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // Try the next deployment layout.
    }
  }
  throw new Error('BUILTIN_SKILL_CONTENT_UNAVAILABLE');
}

export function builtinResourceHash(content: string): string {
  return utf8Sha256(content);
}
