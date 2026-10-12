import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { createDatabaseClient } from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { readIsolatedSkillPackageFile } from '@ecom-forge/skills';

import { loadAppConfig } from '../config/app-config.js';
import { SkillPackageInstallService } from '../modules/skill-package/skill-package-install.service.js';

async function run(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Skill package installation requires an interactive terminal');
  }
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: { archive: { type: 'string' } },
    strict: true,
  });
  const archivePath = parsed.values.archive?.trim();
  if (!archivePath) throw new Error('Usage: skill:install --archive <file.skillpkg>');
  const config = loadAppConfig();
  if (!['local', 'test'].includes(config.appEnv)) {
    throw new Error('SKILL_PACKAGE_INSTALL_FORBIDDEN');
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const resource = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  const writtenPaths: string[] = [];
  try {
    const isolated = await readIsolatedSkillPackageFile(resolve(archivePath));
    const confirm = (await readline.question('Type INSTALL to quarantine and validate: ')).trim();
    if (confirm !== 'INSTALL') return;
    const storagePrefix = `skill-quarantine/${isolated.archiveSha256}`;
    const root = resolve(config.localUploadRoot);
    await mkdir(resolve(root, storagePrefix), { recursive: true });
    const copiedPath = resolve(root, storagePrefix, basename(archivePath));
    await writeContentAddressedFile(copiedPath, await readFile(resolve(archivePath)), writtenPaths);
    for (const item of isolated.resources) {
      const resourcePath = resolve(root, storagePrefix, item.path);
      await mkdir(dirname(resourcePath), { recursive: true });
      await writeContentAddressedFile(resourcePath, item.content, writtenPaths);
    }
    const service = new SkillPackageInstallService(resource.db, config.appEnv);
    const result = await service.install({
      manifest: isolated.manifest,
      archiveSha256: isolated.archiveSha256,
      quarantineStorageKey: `${storagePrefix}/${basename(archivePath)}`,
      uploadExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      platformEvalSuiteDigest: canonicalSha256({ suite: 's08-platform-eval@1' }),
      actor: { actorType: 'bootstrap_cli' },
      resources: isolated.resources.map((item) => {
        const skill = isolated.manifest.skills.find((entry) =>
          item.path.startsWith(entry.definition_path.slice(0, -'SKILL.md'.length)),
        );
        const resourceInput = {
          path: item.path,
          mediaType: item.mediaType,
          byteSize: item.content.byteLength,
          contentHash: createHash('sha256').update(item.content).digest('hex'),
          storageKey: `${storagePrefix}/${item.path}`,
          rightsMetadata: { source: isolated.manifest.source_provenance.type },
        };
        return skill ? { ...resourceInput, skillId: skill.skill_id } : resourceInput;
      }),
    });
    console.info(
      JSON.stringify({
        event: result.reused ? 'skill_package_install_reused' : 'skill_package_install_queued',
        package_record_id: result.packageRecordId,
        validation_report_id: result.validationReportId,
        package_digest: result.packageDigest,
      }),
    );
  } catch (error) {
    for (const path of writtenPaths.reverse()) {
      await rm(path, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    readline.close();
    await resource.client.end();
  }
}

async function writeContentAddressedFile(
  path: string,
  content: Uint8Array,
  writtenPaths: string[],
): Promise<void> {
  try {
    await writeFile(path, content, { flag: 'wx' });
    writtenPaths.push(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    const existing = await readFile(path);
    if (
      createHash('sha256').update(existing).digest('hex') !==
      createHash('sha256').update(content).digest('hex')
    ) {
      throw new Error('SKILL_PACKAGE_STORAGE_CONFLICT');
    }
  }
}

await run();
