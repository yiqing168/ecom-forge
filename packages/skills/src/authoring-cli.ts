import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  diffSkillPackages,
  packSkillPackage,
  parseSkillPackageManifest,
  parseSkillAuthorMarkdown,
  readIsolatedSkillPackageFile,
  scaffoldSkillPackage,
  skillPackageDigest,
  synchronizeSkillPackageManifest,
  type SkillPackageContentResource,
  type SkillAuthorFrontmatter,
} from './index.js';

function platformProfileFromFrontmatter(frontmatter: SkillAuthorFrontmatter) {
  const { schema_version, description, ...profile } = frontmatter;
  void schema_version;
  void description;
  return profile;
}

function parseOptions<T extends Record<string, { type: 'string' }>>(
  args: string[],
  options: T,
  allowPositionals = false,
) {
  const seen = new Set<string>();
  for (const argument of args) {
    if (!argument.startsWith('--')) continue;
    const name = argument.slice(2).split('=', 1)[0];
    if (!name) usage();
    if (seen.has(name)) usage();
    seen.add(name);
  }
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch {
    return usage();
  }
}

function requiredOption(value: string | undefined): string {
  if (!value?.trim()) return usage();
  return value;
}

function resolveFromInvocation(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

async function scaffold(args: string[], log: (message: string) => void): Promise<void> {
  const parsed = parseOptions(
    args,
    {
      target: { type: 'string' },
      'display-name': { type: 'string' },
    },
    true,
  );
  const [slug] = parsed.positionals;
  if (!slug || parsed.positionals.length !== 1) usage();
  const target = parsed.values.target ?? slug;
  const displayName = parsed.values['display-name'] ?? slug;
  const root = resolveFromInvocation(target);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  for (const file of scaffoldSkillPackage({ slug, displayName })) {
    const output = resolveInside(root, file.path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, file.content, { flag: 'wx' });
  }
  log(JSON.stringify({ event: 'skill_scaffolded', slug }));
}

async function readWorkspace(rootInput: string) {
  const root = resolveFromInvocation(rootInput);
  const manifestPath = resolveInside(root, 'skill-package/skill-package.json');
  const manifest = parseSkillPackageManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  );
  const resources: SkillPackageContentResource[] = [];
  for (const resource of manifest.resources) {
    const path = resolveInside(root, resource.path);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error('SKILL_PACKAGE_RESOURCE_INVALID');
    resources.push({
      path: resource.path,
      mediaType: resource.media_type,
      content: await readFile(path),
    });
  }
  return { root, manifest, resources };
}

async function pack(args: string[], log: (message: string) => void): Promise<void> {
  const parsed = parseOptions(args, { source: { type: 'string' }, output: { type: 'string' } });
  const workspace = requiredOption(parsed.values.source);
  const output = requiredOption(parsed.values.output);
  if (!output.toLowerCase().endsWith('.skillpkg')) usage();
  const source = await readWorkspace(workspace);
  const packed = await packSkillPackage(source);
  const outputPath = resolveFromInvocation(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, packed.archive, { flag: 'wx' });
  log(JSON.stringify({ event: 'skill_packed', package_digest: packed.packageDigest }));
}

async function sync(args: string[], log: (message: string) => void): Promise<void> {
  const parsed = parseOptions(args, { source: { type: 'string' } });
  const workspace = requiredOption(parsed.values.source);
  const source = await readWorkspace(workspace);
  const manifest = synchronizeSkillPackageManifest(source);
  const manifestPath = resolveInside(source.root, 'skill-package/skill-package.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(
    JSON.stringify({
      event: 'skill_manifest_synced',
      package_digest: skillPackageDigest(manifest),
    }),
  );
}

const discoverableMediaTypes = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.jsonl': 'application/jsonl',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
} as const;

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function extension(path: string): keyof typeof discoverableMediaTypes | undefined {
  const match = /\.[a-z0-9]+$/i.exec(path);
  const value = match?.[0]?.toLowerCase();
  return value && value in discoverableMediaTypes
    ? (value as keyof typeof discoverableMediaTypes)
    : undefined;
}

function resourcePurpose(path: string, kind?: 'primary' | 'auxiliary'): string {
  if (path.endsWith('/SKILL.md')) return `${kind ?? 'unknown'} skill definition`;
  if (path.includes('/presets/')) return 'presentation preset';
  if (path.includes('/references/')) return 'L2 quality reference';
  if (path.includes('/evals/')) return 'golden evaluation dataset';
  if (path.includes('/assets/')) return 'catalog asset';
  return 'package resource';
}

async function discoverFiles(root: string): Promise<string[]> {
  const packageRoot = resolveInside(root, 'skill-package');
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile() && entry.name !== 'skill-package.json') {
        const path = relative(root, absolutePath).replaceAll('\\', '/');
        if (!extension(path)) throw new Error('SKILL_PACKAGE_RESOURCE_TYPE_UNSUPPORTED');
        paths.push(path);
      }
    }
  };
  await visit(packageRoot);
  return paths.sort((left, right) => left.localeCompare(right, 'en-US'));
}

async function readExistingManifest(root: string) {
  try {
    return parseSkillPackageManifest(
      JSON.parse(
        await readFile(resolveInside(root, 'skill-package/skill-package.json'), 'utf8'),
      ) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function discover(args: string[], log: (message: string) => void): Promise<void> {
  const parsed = parseOptions(args, {
    source: { type: 'string' },
    'package-id': { type: 'string' },
    'package-version': { type: 'string' },
    provenance: { type: 'string' },
  });
  const root = resolveFromInvocation(requiredOption(parsed.values.source));
  const existing = await readExistingManifest(root);
  const packageId = parsed.values['package-id'] ?? existing?.package_id;
  const packageVersion = parsed.values['package-version'] ?? existing?.package_version;
  const provenance = parsed.values.provenance ?? existing?.source_provenance.type;
  if (!packageId || !packageVersion || !provenance) usage();
  if (!['first_party', 'legacy_owned', 'admin_upload'].includes(provenance)) usage();
  if (
    existing &&
    (packageId !== existing.package_id || packageVersion !== existing.package_version)
  ) {
    throw new Error('SKILL_PACKAGE_IDENTITY_CHANGE_REQUIRES_EXPLICIT_RELEASE');
  }

  const paths = await discoverFiles(root);
  const contents = new Map<string, Buffer>();
  for (const path of paths) contents.set(path, await readFile(resolveInside(root, path)));
  const skillDefinitions = paths.filter((path) => path.endsWith('/SKILL.md'));
  if (skillDefinitions.length === 0) throw new Error('SKILL_PACKAGE_SKILL_MISSING');
  const existingProfiles = existing?.skill_profiles ?? {};
  const parsedSkills = new Map(
    skillDefinitions.map((path) => {
      const content = contents.get(path);
      if (!content) throw new Error('SKILL_PACKAGE_RESOURCE_MISSING');
      const inventory = existing?.skills.find((skill) => skill.definition_path === path);
      return [
        path,
        parseSkillAuthorMarkdown(
          content.toString('utf8'),
          inventory ? existingProfiles[inventory.skill_id] : undefined,
        ).frontmatter,
      ] as const;
    }),
  );
  const resources = paths.map((path) => {
    const content = contents.get(path);
    const pathExtension = extension(path);
    if (!content || !pathExtension) throw new Error('SKILL_PACKAGE_RESOURCE_MISSING');
    return {
      path,
      purpose: resourcePurpose(path, parsedSkills.get(path)?.kind),
      media_type: discoverableMediaTypes[pathExtension],
      byte_size: content.byteLength,
      content_hash: sha256(content),
    };
  });
  const manifest = parseSkillPackageManifest({
    schema_version: 1,
    package_id: packageId,
    package_version: packageVersion,
    min_runtime_version: existing?.min_runtime_version ?? '1.0.0',
    skills: skillDefinitions.map((path) => {
      const skill = parsedSkills.get(path);
      const content = contents.get(path);
      if (!skill || !content) throw new Error('SKILL_PACKAGE_RESOURCE_MISSING');
      return {
        skill_id: `${skill.slug}@${skill.version}`,
        definition_path: path,
        definition_hash: sha256(content),
      };
    }),
    resources,
    eval_datasets: paths.filter((path) => path.startsWith('skill-package/evals/')),
    assets: resources
      .filter((resource) => resource.media_type.startsWith('image/'))
      .map((resource) => resource.path),
    source_provenance:
      existing?.source_provenance ??
      ({ type: provenance, summary_digest: sha256(`${provenance}:${packageId}`) } as const),
    license_summary: paths.map(
      (path) =>
        existing?.license_summary.find((entry) => entry.path === path) ?? {
          path,
          license: 'MIT',
          rights_holder: 'ecom-forge',
        },
    ),
    skill_profiles: Object.fromEntries(
      skillDefinitions.map((path) => {
        const skill = parsedSkills.get(path);
        if (!skill) throw new Error('SKILL_PACKAGE_SKILL_MISSING');
        return [`${skill.slug}@${skill.version}`, platformProfileFromFrontmatter(skill)];
      }),
    ),
  });
  await writeFile(
    resolveInside(root, 'skill-package/skill-package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  log(
    JSON.stringify({
      event: 'skill_manifest_discovered',
      package_id: manifest.package_id,
      skill_count: manifest.skills.length,
      resource_count: manifest.resources.length,
    }),
  );
}

async function validate(args: string[], log: (message: string) => void): Promise<number> {
  const parsed = parseOptions(args, { archive: { type: 'string' }, report: { type: 'string' } });
  const archivePath = requiredOption(parsed.values.archive);
  const reportPath = resolveFromInvocation(requiredOption(parsed.values.report));
  let report: Record<string, unknown>;
  let exitCode = 0;
  try {
    const result = await readIsolatedSkillPackageFile(resolveFromInvocation(archivePath));
    report = {
      schema_version: 1,
      status: 'passed',
      package_id: result.manifest.package_id,
      package_version: result.manifest.package_version,
      archive_sha256: result.archiveSha256,
      skill_count: result.validation.skills.length,
      resource_count: result.manifest.resources.length,
    };
  } catch (error) {
    report = {
      schema_version: 1,
      status: 'failed',
      error_code: safeErrorCode(error),
    };
    exitCode = 1;
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  log(JSON.stringify({ event: 'skill_validated', status: report.status }));
  return exitCode;
}

async function diff(args: string[], log: (message: string) => void): Promise<void> {
  const parsed = parseOptions(args, { from: { type: 'string' }, to: { type: 'string' } });
  const leftPath = requiredOption(parsed.values.from);
  const rightPath = requiredOption(parsed.values.to);
  const [left, right] = await Promise.all([
    readIsolatedSkillPackageFile(resolveFromInvocation(leftPath)),
    readIsolatedSkillPackageFile(resolveFromInvocation(rightPath)),
  ]);
  log(JSON.stringify({ event: 'skill_diffed', ...diffSkillPackages(left, right) }));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^SKILL_[A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'SKILL_PACKAGE_VALIDATION_FAILED';
}

function resolveInside(root: string, relativePath: string): string {
  const output = resolve(root, relativePath);
  if (output !== root && !output.startsWith(`${root}\\`) && !output.startsWith(`${root}/`)) {
    throw new Error('SKILL_PACKAGE_PATH_INVALID');
  }
  return output;
}

function usage(): never {
  throw new Error(
    'Usage: skill:scaffold <slug> [--target <dir>] [--display-name <name>] | skill:discover --source <dir> [--package-id <id> --package-version <version> --provenance <type>] | skill:sync --source <dir> | skill:pack --source <dir> --output <file.skillpkg> | skill:validate --archive <file.skillpkg> --report <path> | skill:diff --from <old.skillpkg> --to <new.skillpkg>',
  );
}

export async function runAuthoringCli(
  argv: string[],
  log: (message: string) => void = console.info,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'scaffold') await scaffold(args, log);
  else if (command === 'discover') await discover(args, log);
  else if (command === 'sync') await sync(args, log);
  else if (command === 'pack') await pack(args, log);
  else if (command === 'validate') return validate(args, log);
  else if (command === 'diff') await diff(args, log);
  else usage();
  return 0;
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectInvocation) process.exitCode = await runAuthoringCli(process.argv.slice(2));
