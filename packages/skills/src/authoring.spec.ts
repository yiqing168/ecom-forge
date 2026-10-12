import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  diffSkillPackages,
  packSkillPackage,
  parseSkillPackageManifest,
  readIsolatedSkillPackageBuffer,
  scaffoldSkillPackage,
} from './index.js';
import { runAuthoringCli } from './authoring-cli.js';
import { loadSourceAndPack } from './first-release-validation-cli.js';

const execFileAsync = promisify(execFile);

function source() {
  const files = scaffoldSkillPackage({ slug: 'product-story', displayName: 'Product Story' });
  const manifestFile = files.find((file) => file.path.endsWith('skill-package.json'))!;
  const manifest = parseSkillPackageManifest(
    JSON.parse(manifestFile.content.toString('utf8')) as unknown,
  );
  const resources = manifest.resources.map((resource) => ({
    path: resource.path,
    mediaType: resource.media_type,
    content: files.find((file) => file.path === resource.path)!.content,
  }));
  return { manifest, resources };
}

async function validatedSource() {
  const input = source();
  const packed = await packSkillPackage(input);
  return readIsolatedSkillPackageBuffer(packed.archive);
}

describe('Skill authoring tools', () => {
  it('scaffolds, validates and packs the same input reproducibly', async () => {
    const input = source();
    expect(input.manifest.license_summary.every((entry) => entry.license === 'MIT')).toBe(true);
    const first = await packSkillPackage(input);
    const second = await packSkillPackage(input);
    expect(first.archive.equals(second.archive)).toBe(true);
    expect(first.packageDigest).toBe(second.packageDigest);
    const parsed = await readIsolatedSkillPackageBuffer(first.archive);
    expect(parsed.validation.skills[0]?.skillId).toBe('product-story@0.1.0');
  });

  it('reports structural changes without returning private content', async () => {
    const left = await validatedSource();
    const right = {
      ...left,
      manifest: parseSkillPackageManifest({ ...left.manifest, package_version: '0.2.0' }),
    };
    const result = diffSkillPackages(left, right);
    expect(result.package_identity_changed).toBe(true);
    expect(result.eval_datasets).toEqual({ added: [], removed: [] });
    expect(JSON.stringify(result)).not.toContain('planning principles');
  });

  it('rejects a stale source manifest before packaging can synchronize it', async () => {
    const root = resolve(tmpdir(), `ecom-forge-skill-source-${randomUUID()}`);
    const files = scaffoldSkillPackage({ slug: 'product-story', displayName: 'Product Story' });
    try {
      for (const file of files) {
        const path = resolve(root, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
      }
      const skillPath = resolve(root, 'skill-package/skills/product-story/SKILL.md');
      await writeFile(
        skillPath,
        `${await readFile(skillPath, 'utf8')}\nNew unsynchronized guidance.\n`,
      );

      await expect(loadSourceAndPack(root)).rejects.toThrow(
        'SKILL_PACKAGE_RESOURCE_DIGEST_MISMATCH',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale manifests when packSkillPackage is called directly', async () => {
    const input = source();
    const staleManifest = parseSkillPackageManifest({
      ...input.manifest,
      resources: input.manifest.resources.map((resource, index) =>
        index === 0 ? { ...resource, content_hash: '0'.repeat(64) } : resource,
      ),
    });

    await expect(packSkillPackage({ ...input, manifest: staleManifest })).rejects.toThrow(
      'SKILL_PACKAGE_RESOURCE_DIGEST_MISMATCH',
    );
  });

  it('supports the stable named-argument CLI and writes a validation report', async () => {
    const root = resolve(tmpdir(), `ecom-forge-skill-cli-${randomUUID()}`);
    const workspace = resolve(root, 'workspace');
    const archive = resolve(root, 'product-story.skillpkg');
    const report = resolve(root, 'validation-report.json');
    const cli = resolve(import.meta.dirname, 'authoring-cli.ts');
    const output: string[] = [];
    const run = (...args: string[]) => runAuthoringCli(args, (message) => output.push(message));
    try {
      await run(
        'scaffold',
        'product-story',
        '--target',
        workspace,
        '--display-name',
        'Product Story',
      );
      await run('sync', '--source', workspace);
      const manifestPath = resolve(workspace, 'skill-package/skill-package.json');
      const manifest = parseSkillPackageManifest(
        JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
      );
      const firstLicense = manifest.license_summary[0]!;
      firstLicense.license = 'Apache-2.0; modified';
      firstLicense.rights_holder = 'upstream contributor';
      await writeFile(manifestPath, JSON.stringify(manifest));
      await run('sync', '--source', workspace);
      const synchronized = parseSkillPackageManifest(
        JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
      );
      expect(
        synchronized.license_summary.find((entry) => entry.path === firstLicense.path),
      ).toEqual(firstLicense);
      await run('discover', '--source', workspace);
      await run('pack', '--source', workspace, '--output', archive);
      await run('validate', '--archive', archive, '--report', report);
      await run('diff', '--from', archive, '--to', archive);

      await expect(run('scaffold', 'product-story', '--target', workspace)).rejects.toBeDefined();
      await expect(readFile(report, 'utf8')).resolves.toContain('"status": "passed"');
      expect(output.some((message) => message.includes('skill_diffed'))).toBe(true);
      expect(output.some((message) => message.includes('skill_manifest_synced'))).toBe(true);
      expect(output.some((message) => message.includes('skill_manifest_discovered'))).toBe(true);
      const smoke = resolve(root, 'smoke');
      await execFileAsync(process.execPath, [
        '--import',
        'tsx',
        cli,
        'scaffold',
        'smoke-skill',
        '--target',
        smoke,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
