import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export function createLocalEnvironment(template) {
  const values = parseEnv(template);
  for (const [key, value] of Object.entries(values)) {
    if (!value.includes('replace-with')) continue;
    const secret = randomBytes(32).toString('base64url');
    if (key.endsWith('_SECRET')) {
      values[key] = secret;
    } else if (key.endsWith('_KEYRING')) {
      const activeId = values[key.replace(/_KEYRING$/, '_ACTIVE_KEY_ID')];
      if (!activeId) throw new Error(`Missing active key ID for ${key}`);
      values[key] = `${activeId}:${secret}`;
    } else {
      throw new Error(`Unrecognized placeholder field: ${key}`);
    }
  }
  values.APP_ENV = 'local';
  values.DATABASE_URL = 'postgresql://ecom_forge:ecom_forge_dev@localhost:5432/ecom_forge';
  values.REDIS_URL = 'redis://localhost:6379';

  return [
    '# Generated for local development only. Never commit this file.',
    '# Keep these keys stable and back them up privately with your database.',
    '# Change Provider allowlists before adding real models in the admin console.',
    ...Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    '',
  ].join('\n');
}

export async function initializeLocalEnvironment(root) {
  const template = await readFile(resolve(root, '.env.example'), 'utf8');
  const target = resolve(root, '.env.local');
  try {
    await writeFile(target, createLocalEnvironment(template), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error(
      'Usage: node scripts/setup-local.mjs (no arguments; existing files stay unchanged)',
    );
    process.exitCode = 1;
  } else {
    const root = fileURLToPath(new URL('..', import.meta.url));
    try {
      const created = await initializeLocalEnvironment(root);
      console.info(
        created
          ? 'Created private .env.local. Next: pnpm install, docker compose up -d --wait, pnpm db:migrate.'
          : 'Existing .env.local preserved. No keys or connection settings were changed.',
      );
    } catch (error) {
      console.error(`Local setup failed: ${error.code ?? 'INVALID_TEMPLATE'}`);
      process.exitCode = 1;
    }
  }
}
