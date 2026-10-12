import { spawnSync } from 'node:child_process';

import { assertCaseFilesExist } from './lib/assert-case-files.mjs';
import {
  provisionValidationTestDatabase,
  requirePnpmCli,
  resolveTestDatabaseUrl,
} from './lib/test-database.mjs';

const cases = {
  'agent-cost-exposure': [
    {
      workspace: '@ecom-forge/worker',
      config: 'vitest.integration.config.ts',
      file: 'test/s08-agent.integration-spec.ts',
      pattern: 'recovers a crashed started call as unknown without redispatch or clearing exposure',
    },
  ],
  'agent-trace-loop': [
    {
      workspace: '@ecom-forge/worker',
      config: 'vitest.integration.config.ts',
      file: 'test/s08-agent.integration-spec.ts',
      pattern: 'agent trace loop survives lease takeover and blocks persisted limits',
    },
  ],
  'agent-session-transcript': [
    ...['read', 'write', 'summary', 'lifecycle', 'perf'].map((suite) => ({
      workspace: '@ecom-forge/worker',
      config: 'vitest.integration.config.ts',
      file: `test/s08-transcript-${suite}.integration-spec.ts`,
    })),
    {
      workspace: '@ecom-forge/worker',
      config: 'vitest.config.ts',
      // Path filter (vitest matches the substring), not a literal file path.
      file: 'agent-transcript',
      filter: true,
    },
    {
      workspace: '@ecom-forge/worker',
      config: 'vitest.config.ts',
      file: 'src/agent/agent-native-memory-boundary.spec.ts',
    },
    { workspace: '@ecom-forge/provider', file: 'src/agent-brain/transcript-messages.spec.ts' },
    { workspace: '@ecom-forge/provider', file: 'src/agent-brain/vercel-ai-agent-brain.spec.ts' },
  ],
  'skill-load-cache': [
    {
      workspace: '@ecom-forge/worker',
      config: 'vitest.integration.config.ts',
      file: 'test/s08-agent.integration-spec.ts',
      pattern: 'loads only snapshotted one-hop references and falls back to DB when Redis misses',
    },
  ],
  'skill-package-install': [
    {
      workspace: '@ecom-forge/skills',
      file: 'src/authoring.spec.ts',
      pattern: 'scaffolds, validates and packs the same input reproducibly',
    },
    {
      workspace: '@ecom-forge/api',
      config: 'vitest.config.ts',
      file: 'test/s08-skill-package.e2e-spec.ts',
      pattern: 'creates exactly one package, report and v2 intent under concurrent installs',
    },
    {
      workspace: '@ecom-forge/worker',
      config: 'vitest.integration.config.ts',
      file: 'test/s08-skill-package.integration-spec.ts',
      pattern: 'terminally disables a package containing a privilege escalation instruction',
    },
  ],
  'golden-eval-gate': [
    {
      workspace: '@ecom-forge/provider',
      file: 'src/agent-brain/golden-eval.spec.ts',
      pattern:
        'covers deterministic terminal, clarification, tool, refusal and primary preservation cases',
    },
  ],
};

const name = process.argv[2];
const selected = cases[name];
if (!selected) throw new Error(`Unknown S08 validation case: ${name ?? '<missing>'}`);
assertCaseFilesExist(selected);

const pnpmCli = requirePnpmCli('S08');
// Resolve the configured database (still enforcing the isolated "_test" naming guard) and make
// sure it is migrated to the current head before any case runs. A stale configured database is
// transparently replaced by a stable, reused, migrated sibling database; nothing is ever dropped.
const baseUrl = resolveTestDatabaseUrl('S08');
const { url: testDatabaseUrl } = provisionValidationTestDatabase({ pnpmCli, baseUrl });
const env = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
  TEST_REDIS_URL: process.env.TEST_REDIS_URL?.trim() || 'redis://127.0.0.1:6379/1',
};

for (const testCase of selected) {
  const prefix = ['--filter', testCase.workspace, 'exec', 'vitest'];
  const config = testCase.config ? ['--config', testCase.config] : [];
  const vitestArgs = [
    ...config,
    testCase.file,
    ...(testCase.pattern ? ['-t', testCase.pattern] : []),
  ];
  const listed = spawnSync(process.execPath, [pnpmCli, ...prefix, 'list', ...vitestArgs], {
    encoding: 'utf8',
    env,
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) {
    process.stdout.write(listed.stdout ?? '');
    process.stderr.write(listed.stderr ?? '');
    process.exit(listed.status ?? 1);
  }
  const tests = (listed.stdout ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (tests.length === 0 || (testCase.pattern && tests.length !== 1)) {
    throw new Error(
      `Expected exactly one ${testCase.workspace} test matching ${testCase.pattern}, found ${tests.length}`,
    );
  }
  const result = spawnSync(process.execPath, [pnpmCli, ...prefix, 'run', ...vitestArgs], {
    stdio: 'inherit',
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
