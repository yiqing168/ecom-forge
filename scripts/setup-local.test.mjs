import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';

import { createLocalEnvironment, initializeLocalEnvironment } from './setup-local.mjs';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');

test('generates a complete local template with distinct 32-byte secret domains', () => {
  const env = parseEnv(createLocalEnvironment(template));
  assert.deepEqual(Object.keys(env).sort(), Object.keys(parseEnv(template)).sort());
  const secrets = Object.entries(env)
    .filter(([key]) => key.endsWith('_SECRET') || key.endsWith('_KEYRING'))
    .map(([key, value]) => {
      if (key.endsWith('_KEYRING')) {
        const [id, secret] = value.split(':');
        assert.equal(id, env[key.replace(/_KEYRING$/, '_ACTIVE_KEY_ID')]);
        return secret;
      }
      return value;
    });
  assert.equal(new Set(secrets).size, secrets.length);
  for (const secret of secrets) assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.ok(!JSON.stringify(env).includes('replace-with'));
  assert.equal(
    env.DATABASE_URL,
    'postgresql://ecom_forge:ecom_forge_dev@localhost:5432/ecom_forge',
  );
  assert.equal(env.REDIS_URL, 'redis://localhost:6379');
  assert.equal(env.APP_ENV, 'local');
  assert.equal(env.PROVIDER_PROCESSOR_MODE, undefined);
});

test('separate installations get different secrets', () => {
  assert.notEqual(
    parseEnv(createLocalEnvironment(template)).AUTH_SECRET,
    parseEnv(createLocalEnvironment(template)).AUTH_SECRET,
  );
});

test('rejects an unsupported placeholder or a keyring without an active ID', () => {
  assert.throws(() => createLocalEnvironment('FUTURE_CONFIG=replace-with-value'));
  assert.throws(() => createLocalEnvironment('MISSING_KEYRING=id:replace-with-secret'));
});

test('initialization is exclusive, concurrent-safe, and preserves existing private files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiangsu-setup-'));
  try {
    await writeFile(join(root, '.env.example'), template);
    const results = await Promise.all([
      initializeLocalEnvironment(root),
      initializeLocalEnvironment(root),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    const before = await readFile(join(root, '.env.local'), 'utf8');
    assert.equal(await initializeLocalEnvironment(root), false);
    assert.equal(await readFile(join(root, '.env.local'), 'utf8'), before);
    if (process.platform !== 'win32')
      assert.equal((await stat(join(root, '.env.local'))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing template fails without creating an environment file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xiangsu-setup-missing-'));
  try {
    await assert.rejects(initializeLocalEnvironment(root), { code: 'ENOENT' });
    await assert.rejects(stat(join(root, '.env.local')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
