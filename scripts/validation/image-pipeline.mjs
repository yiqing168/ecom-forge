import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const DEFAULT_TEST_REDIS_URL = 'redis://127.0.0.1:6379/1';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
const databaseName = new URL(testDatabaseUrl).pathname.replace(/^\//u, '').toLowerCase();
if (!/_test(?:_|$)/u.test(databaseName)) {
  throw new Error('Image pipeline validation requires an isolated _test database');
}
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Image pipeline validation must be started through pnpm');

const env = {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
  TEST_REDIS_URL: process.env.TEST_REDIS_URL?.trim() || DEFAULT_TEST_REDIS_URL,
  TEST_REDIS_PREFIX:
    process.env.TEST_REDIS_PREFIX?.trim() || `s05-test-s12-${randomUUID().replaceAll('-', '')}`,
};

const suites = [
  {
    label: 'deterministic media compilation and cost closure',
    args: [
      '--filter',
      '@ecom-forge/compiler',
      'exec',
      'vitest',
      'run',
      'src/media-compile.spec.ts',
      'src/image-capabilities.spec.ts',
    ],
  },
  {
    label: 'bounded image and strict moderation adapters',
    args: [
      '--filter',
      '@ecom-forge/provider',
      'exec',
      'vitest',
      'run',
      'src/image/openai-images.adapter.spec.ts',
      'src/moderation/vercel-ai-moderation.adapter.spec.ts',
    ],
  },
  {
    label: 'product facts and unified model content-safety configuration',
    args: [
      '--filter',
      '@ecom-forge/api',
      'exec',
      'vitest',
      'run',
      'test/s12-product-facts.e2e-spec.ts',
      'test/s14-model-configuration.e2e-spec.ts',
    ],
  },
  {
    label: 'preflight, generation quarantine, post-moderation, publication and release',
    args: [
      '--filter',
      '@ecom-forge/worker',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.integration.config.ts',
      'test/s12-preflight.integration-spec.ts',
      'test/s12-image-pipeline.integration-spec.ts',
      'test/s12-post-moderation.integration-spec.ts',
    ],
  },
];

for (const suite of suites) {
  process.stdout.write(`\n[S12] ${suite.label}\n`);
  const result = spawnSync(process.execPath, [pnpmCli, ...suite.args], {
    stdio: 'inherit',
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  '\nImage pipeline validation passed: compiler, adapters, APIs, private quarantine, moderation, publication, and release.',
);
