import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check as checkPrettier } from 'prettier';

const root = resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runPnpm(args, input) {
  const pnpmCli = process.env.npm_execpath;
  assert(pnpmCli, 'npm_execpath is required to run pnpm smoke checks');

  return spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
  });
}

assert(
  packageJson.scripts?.check?.includes('pnpm validate:quality-gates'),
  'pnpm check must execute validate:quality-gates',
);

function assertLintRule({ filename, source, ruleId, description }) {
  const result = runPnpm(
    ['exec', 'eslint', '--stdin', '--stdin-filename', filename, '--format', 'json'],
    source,
  );

  assert(
    result.error === undefined,
    `${description} probe could not start: ${result.error?.message}`,
  );
  assert(result.status !== 0, `${description} was accepted`);

  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${description} probe did not return ESLint JSON: ${result.stderr}`);
  }

  const messages = reports.flatMap((report) => report.messages ?? []);
  assert(
    !messages.some((message) => message.fatal),
    `${description} probe failed during parsing instead of rule evaluation`,
  );
  assert(
    messages.some((message) => message.ruleId === ruleId),
    `${description} did not trigger ${ruleId}`,
  );
}

const preCommit = readFileSync(resolve(root, '.husky/pre-commit'), 'utf8');
const commitMessage = readFileSync(resolve(root, '.husky/commit-msg'), 'utf8');

assert(
  preCommit.trim() === 'pnpm exec lint-staged --max-arg-length 4096',
  'pre-commit must only run lint-staged with bounded command batches',
);
assert(
  commitMessage.trim() === 'pnpm exec commitlint --edit "$1"',
  'commit-msg must run commitlint against the Git message file',
);

const stagedPatterns = Object.keys(packageJson['lint-staged'] ?? {});
assert(stagedPatterns.length === 2, 'lint-staged must contain exactly two staged-file groups');
assert(
  stagedPatterns.includes('*.{ts,tsx,js,mjs,cjs}') &&
    stagedPatterns.includes('*.{json,jsonc,yml,yaml,md,css,scss}'),
  'lint-staged file groups do not match the engineering contract',
);

const validCommit = runPnpm(['exec', 'commitlint'], 'chore: verify quality gates\n');
assert(validCommit.status === 0, `valid commit message was rejected: ${validCommit.stderr}`);

const invalidCommit = runPnpm(['exec', 'commitlint'], 'invalid message\n');
assert(invalidCommit.status !== 0, 'invalid commit message was accepted');

assertLintRule({
  filename: 'packages/shared/src/index.ts',
  source: "import type { ServiceHealth } from '@ecom-forge/types';\nexport const probe = 1;\n",
  ruleId: '@typescript-eslint/no-unused-vars',
  description: 'unused TypeScript import',
});

assertLintRule({
  filename: 'apps/web/app/page.tsx',
  source: "import '@ecom-forge/credit';\nexport default function Page() { return null; }\n",
  ruleId: 'no-restricted-imports',
  description: 'forbidden Web-to-Credit import',
});

assertLintRule({
  filename: 'packages/shared/src/index.ts',
  source: "import '@ecom-forge/db';\n",
  ruleId: 'no-restricted-imports',
  description: 'forbidden Shared-to-DB import',
});

assertLintRule({
  filename: 'packages/queue/src/index.ts',
  source: "import '@ecom-forge/api';\nexport const probe = true;\n",
  ruleId: 'no-restricted-imports',
  description: 'forbidden reusable-package-to-application import',
});

assertLintRule({
  filename: 'packages/credit/src/index.ts',
  source: 'export const probe = (value: any) => value;\n',
  ruleId: '@typescript-eslint/no-explicit-any',
  description: 'explicit any in a protected domain package',
});

const invalidFormatPasses = await checkPrettier('{"unformatted":true}', {
  filepath: 'hook-smoke.json',
});
assert(!invalidFormatPasses, 'unformatted staged JSON would pass Prettier');

console.log(
  'Quality-gate smoke passed: Husky, lint-staged, commitlint, ESLint, Prettier, and package boundaries reject bad input.',
);
