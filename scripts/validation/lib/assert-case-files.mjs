import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Fail fast when a validation case points at a file that no longer exists.
 *
 * `vitest list` already fails on a missing file, but only after the database has been provisioned
 * and with a raw sub-process error. This pre-check keeps the diagnosis obvious (and stops a
 * deleted/renamed suite from silently taking a registered `validate:*` command out of service).
 */

const WORKSPACE_DIRS = {
  '@ecom-forge/worker': 'apps/worker',
  '@ecom-forge/api': 'apps/api',
  '@ecom-forge/admin': 'apps/admin',
  '@ecom-forge/provider': 'packages/provider',
  '@ecom-forge/skills': 'packages/skills',
};

/** Glob/filter entries are validated by `vitest list`; only concrete paths are checked here. */
export function assertCaseFileExists(testCase) {
  const directory = WORKSPACE_DIRS[testCase.workspace];
  if (!directory) {
    throw new Error(`Validation case uses an unmapped workspace: ${testCase.workspace}`);
  }
  if (testCase.filter || testCase.file.includes('*')) return;
  const fullPath = resolve(process.cwd(), directory, testCase.file);
  if (!existsSync(fullPath)) {
    throw new Error(`Validation case file is missing: ${fullPath}`);
  }
}

/** Assert every entry of a selected case before any database provisioning starts. */
export function assertCaseFilesExist(testCases) {
  for (const testCase of testCases) assertCaseFileExists(testCase);
}
