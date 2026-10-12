import { createHash } from 'node:crypto';

import { ZipFile } from 'yazl';

import { readIsolatedSkillPackageBuffer } from './archive.js';
import {
  parseSkillPackageManifest,
  skillPackageDigest,
  type SkillPackageManifest,
} from './package.js';
import {
  validateSkillPackageContents,
  type SkillPackageContentValidation,
  type SkillPackageContentResource,
} from './content-validator.js';

const fixedZipTime = new Date('1980-01-01T00:00:00.000Z');

export interface ScaffoldFile {
  path: string;
  content: Buffer;
}

export function scaffoldSkillPackage(input: { slug: string; displayName: string }): ScaffoldFile[] {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.slug) || !input.displayName.trim()) {
    throw new Error('SKILL_SCAFFOLD_INPUT_INVALID');
  }
  const definitionPath = `skill-package/skills/${input.slug}/SKILL.md`;
  const definition = Buffer.from(
    `---
name: ${input.slug}
description: Describe the user outcome and the situations where this Skill applies.
---
Describe planning principles, missing-fact checks, boundaries, and safe next steps.
`,
    'utf8',
  );
  const contentHash = sha256(definition);
  const evalPath = `skill-package/evals/${input.slug}.jsonl`;
  const evaluation = Buffer.from(
    [
      ['success', 'plan'],
      ['missing_fact', 'clarify'],
      ['skill_mismatch', 'suggest_switch'],
      ['material_role_drift', 'block'],
      ['prompt_injection', 'block'],
    ]
      .map(([category, decision]) =>
        JSON.stringify({
          case_id: `example-${category?.replaceAll('_', '-')}`,
          category,
          request: `Example ${category} request`,
          context: {},
          expected: { decision, required_checks: ['example-check'], forbidden: [] },
        }),
      )
      .join('\n') + '\n',
    'utf8',
  );
  const evaluationHash = sha256(evaluation);
  const manifest = parseSkillPackageManifest({
    schema_version: 1,
    package_id: `${input.slug}-package`,
    package_version: '0.1.0',
    min_runtime_version: '1.0.0',
    skills: [
      {
        skill_id: `${input.slug}@0.1.0`,
        definition_path: definitionPath,
        definition_hash: contentHash,
      },
    ],
    skill_profiles: {
      [`${input.slug}@0.1.0`]: {
        slug: input.slug,
        version: '0.1.0',
        display_name: input.displayName.trim(),
        kind: 'primary',
        category: 'creative',
        domain: 'creative',
        stage: '1A',
        sort_order: 0,
        required_inputs: [],
        required_facts: [],
        required_capabilities: [],
        default_output_count: 1,
        execution_policy: { version: 1, family: 'text_generation', max_sources: 9 },
        attachment_roles: [
          { role: 'style_reference', label: 'Style reference' },
          { role: 'composition_reference', label: 'Composition reference' },
          { role: 'other', label: 'Other' },
        ],
        catalog: { visibility: 'public' },
        preset_slots: [],
        dependencies: [],
        references: [],
      },
    },
    resources: [
      {
        path: definitionPath,
        purpose: 'skill definition',
        media_type: 'text/markdown',
        byte_size: definition.byteLength,
        content_hash: contentHash,
      },
      {
        path: evalPath,
        purpose: 'example golden evaluation',
        media_type: 'application/jsonl',
        byte_size: evaluation.byteLength,
        content_hash: evaluationHash,
      },
    ],
    eval_datasets: [evalPath],
    assets: [],
    source_provenance: { type: 'first_party', summary_digest: sha256('first_party') },
    license_summary: [
      { path: definitionPath, license: 'MIT', rights_holder: 'ecom-forge' },
      { path: evalPath, license: 'MIT', rights_holder: 'ecom-forge' },
    ],
  });
  return [
    { path: definitionPath, content: definition },
    { path: evalPath, content: evaluation },
    {
      path: 'skill-package/skill-package.json',
      content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    },
  ];
}

export async function packSkillPackage(input: {
  manifest: unknown;
  resources: SkillPackageContentResource[];
}): Promise<{ archive: Buffer; manifest: SkillPackageManifest; packageDigest: string }> {
  // Packing must not hide source drift. Authors explicitly run `sync` when they want
  // to update manifest hashes; packing only canonicalizes an already-valid source.
  const sourceManifest = parseSkillPackageManifest(input.manifest);
  validateSkillPackageContents({ manifest: sourceManifest, resources: input.resources });
  const manifest = synchronizeSkillPackageManifest({
    manifest: sourceManifest,
    resources: input.resources,
  });
  validateSkillPackageContents({ manifest, resources: input.resources });
  const archive = await deterministicZip([
    {
      path: 'skill-package/skill-package.json',
      content: Buffer.from(JSON.stringify(manifest), 'utf8'),
    },
    ...input.resources.map((item) => ({ path: item.path, content: Buffer.from(item.content) })),
  ]);
  await readIsolatedSkillPackageBuffer(archive);
  return { archive, manifest, packageDigest: skillPackageDigest(manifest) };
}

export function synchronizeSkillPackageManifest(input: {
  manifest: unknown;
  resources: SkillPackageContentResource[];
}): SkillPackageManifest {
  const sourceManifest = parseSkillPackageManifest(input.manifest);
  const resourcesByPath = new Map(input.resources.map((item) => [item.path, item]));
  return parseSkillPackageManifest({
    ...sourceManifest,
    resources: sourceManifest.resources.map((item) => {
      const resource = resourcesByPath.get(item.path);
      if (!resource) throw new Error('SKILL_PACKAGE_RESOURCE_MISSING');
      return {
        ...item,
        byte_size: resource.content.byteLength,
        content_hash: sha256(resource.content),
      };
    }),
    skills: sourceManifest.skills.map((item) => {
      const resource = resourcesByPath.get(item.definition_path);
      if (!resource) throw new Error('SKILL_PACKAGE_RESOURCE_MISSING');
      return { ...item, definition_hash: sha256(resource.content) };
    }),
  });
}

export interface SkillPackageDiffInput {
  manifest: SkillPackageManifest;
  validation: SkillPackageContentValidation;
}

export function diffSkillPackages(left: SkillPackageDiffInput, right: SkillPackageDiffInput) {
  const changed = <T>(a: T, b: T) => JSON.stringify(a) !== JSON.stringify(b);
  const leftSkills = new Map(left.validation.skills.map((skill) => [skill.skillId, skill]));
  const rightSkills = new Map(right.validation.skills.map((skill) => [skill.skillId, skill]));
  const addedSkills = [...rightSkills.keys()].filter((id) => !leftSkills.has(id)).sort();
  const removedSkills = [...leftSkills.keys()].filter((id) => !rightSkills.has(id)).sort();
  const commonSkills = [...leftSkills.keys()].filter((id) => rightSkills.has(id)).sort();
  const changedFields = (field: 'required_inputs' | 'preset_slots' | 'dependencies') =>
    commonSkills.filter((id) =>
      changed(leftSkills.get(id)?.frontmatter[field], rightSkills.get(id)?.frontmatter[field]),
    );
  const changedDefinitions = commonSkills.filter((id) => {
    const before = leftSkills.get(id);
    const after = rightSkills.get(id);
    return before?.definitionHash !== after?.definitionHash;
  });
  const resourceChanges = pathChanges(left.manifest.resources, right.manifest.resources, 'path');
  const evalChanges = valueChanges(left.manifest.eval_datasets, right.manifest.eval_datasets);
  const assetChanges = valueChanges(left.manifest.assets, right.manifest.assets);
  const requiredInputsChanged = changedFields('required_inputs');
  const presetsChanged = changedFields('preset_slots');
  const dependenciesChanged = changedFields('dependencies');
  const hasHighRiskChange =
    removedSkills.length > 0 ||
    requiredInputsChanged.length > 0 ||
    presetsChanged.length > 0 ||
    dependenciesChanged.length > 0;
  const hasAnyChange =
    addedSkills.length > 0 ||
    hasHighRiskChange ||
    changedDefinitions.length > 0 ||
    resourceChanges.added.length > 0 ||
    resourceChanges.removed.length > 0 ||
    resourceChanges.changed.length > 0 ||
    evalChanges.added.length > 0 ||
    evalChanges.removed.length > 0 ||
    assetChanges.added.length > 0 ||
    assetChanges.removed.length > 0;
  return {
    package_identity_changed:
      left.manifest.package_id !== right.manifest.package_id ||
      left.manifest.package_version !== right.manifest.package_version,
    risk_level: hasHighRiskChange ? 'high' : hasAnyChange ? 'medium' : 'none',
    skills: { added: addedSkills, removed: removedSkills, definitions_changed: changedDefinitions },
    required_inputs_changed: requiredInputsChanged,
    presets_changed: presetsChanged,
    dependencies_changed: dependenciesChanged,
    resources: resourceChanges,
    eval_datasets: evalChanges,
    assets: assetChanges,
    left_digest: skillPackageDigest(left.manifest),
    right_digest: skillPackageDigest(right.manifest),
  };
}

function pathChanges<T extends Record<K, string>, K extends keyof T>(
  left: T[],
  right: T[],
  key: K,
) {
  const before = new Map(left.map((item) => [item[key], item]));
  const after = new Map(right.map((item) => [item[key], item]));
  return {
    added: [...after.keys()].filter((value) => !before.has(value)).sort(),
    removed: [...before.keys()].filter((value) => !after.has(value)).sort(),
    changed: [...before.keys()]
      .filter(
        (value) =>
          after.has(value) &&
          JSON.stringify(before.get(value)) !== JSON.stringify(after.get(value)),
      )
      .sort(),
  };
}

function valueChanges(left: string[], right: string[]) {
  const before = new Set(left);
  const after = new Set(right);
  return {
    added: [...after].filter((value) => !before.has(value)).sort(),
    removed: [...before].filter((value) => !after.has(value)).sort(),
  };
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function deterministicZip(entries: Array<{ path: string; content: Buffer }>): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.once('error', reject);
    archive.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    archive.addBuffer(entry.content, entry.path, {
      mtime: fixedZipTime,
      mode: 0o100644,
      compress: true,
    });
  }
  archive.end();
  return result;
}
