import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as OTPAuth from 'otpauth';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const password = 'S14-live-admin-password-123!';

function secret(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url');
}

function assertLoopbackUrl(value: string, name: string): string {
  const url = new URL(value);
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error(`${name} must use loopback infrastructure`);
  }
  return value;
}

function assertS14TestDatabase(value: string): string {
  const databaseName = new URL(value).pathname.replace(/^\//, '').toLowerCase();
  if (!/_test_s14(?:_|$)/.test(databaseName)) {
    throw new Error('S14 live E2E requires a dedicated database containing _test_s14');
  }
  return value;
}

function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function waitFor(
  url: string,
  child: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${url} process exited with ${child.exitCode}: ${diagnostics()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${diagnostics()}`);
}

function runFixture(
  action: 'setup' | 'cleanup',
  environment: NodeJS.ProcessEnv,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const fixture = resolve(repoRoot, 'apps/api/test/s14-live.fixture.ts');
  const tsx = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const result = spawnSync(process.execPath, [tsx, fixture, action], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    input: JSON.stringify(input),
  });
  if (result.status !== 0) {
    throw new Error(`S14 live fixture ${action} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const nextEnvPath = resolve(repoRoot, 'apps/admin/next-env.d.ts');
  const nextEnvBeforeTest = await readFile(nextEnvPath, 'utf8');
  const databaseUrl = assertS14TestDatabase(
    assertLoopbackUrl(
      process.env.TEST_DATABASE_URL ??
        'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test_s14_live',
      'TEST_DATABASE_URL',
    ),
  );
  const redisUrl = assertLoopbackUrl(
    process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/2',
    'TEST_REDIS_URL',
  );
  const redisPrefix = `s14-live-${randomBytes(8).toString('hex')}`;
  const totpSecret = new OTPAuth.Secret({ size: 20 }).base32;
  const runId = randomBytes(6).toString('hex');
  const environment = {
    ...process.env,
    APP_ENV: 'local',
    API_PORT: '3101',
    WEB_ORIGIN: 'http://127.0.0.1:3100',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    TEST_REDIS_URL: redisUrl,
    REDIS_PREFIX: redisPrefix,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    AUTH_SECRET: secret(1),
    AUTH_TRUSTED_ORIGINS: 'http://127.0.0.1:3100',
    AUTH_OTP_HASH_SECRET: secret(2),
    AUTH_RATE_LIMIT_SECRET: secret(3),
    AUTH_VERIFICATION_TICKET_SECRET: secret(4),
    AUTH_INVITE_CODE_ACTIVE_KEY_ID: 'invite-s14-live-v1',
    AUTH_INVITE_CODE_KEYRING: `invite-s14-live-v1:${secret(5)}`,
    ADMIN_INVITE_CODE_ENCRYPTION_ACTIVE_KEY_ID: 'invite-envelope-s14-live-v1',
    ADMIN_INVITE_CODE_ENCRYPTION_KEYRING: `invite-envelope-s14-live-v1:${secret(27)}`,
    MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID: 'recipient-s14-live-v1',
    MAIL_RECIPIENT_HASH_KEYRING: `recipient-s14-live-v1:${secret(6)}`,
    AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID: 'reward-s14-live-v1',
    AUTH_REWARD_FINGERPRINT_KEYRING: `reward-s14-live-v1:${secret(7)}`,
    ADMIN_ORIGIN: 'http://127.0.0.1:3200',
    ADMIN_ALLOWED_HOSTS: '127.0.0.1:3101,localhost:3101,127.0.0.1:3200,localhost:3200',
    TRUSTED_ADMIN_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    ADMIN_NETWORK_GATE_MODE: 'source_allowlist',
    ADMIN_SOURCE_ALLOWLIST_CIDRS: '127.0.0.1/32,::1/128',
    ADMIN_COOKIE_SECURE: 'false',
    ADMIN_IDENTIFIER_HASH_ACTIVE_KEY_ID: 'admin-identifier-s14-live-v1',
    ADMIN_IDENTIFIER_HASH_KEYRING: `admin-identifier-s14-live-v1:${secret(8)}`,
    ADMIN_SESSION_HASH_ACTIVE_KEY_ID: 'admin-session-s14-live-v1',
    ADMIN_SESSION_HASH_KEYRING: `admin-session-s14-live-v1:${secret(9)}`,
    ADMIN_CSRF_DERIVATION_ACTIVE_KEY_ID: 'admin-csrf-s14-live-v1',
    ADMIN_CSRF_DERIVATION_KEYRING: `admin-csrf-s14-live-v1:${secret(10)}`,
    ADMIN_CHALLENGE_HASH_ACTIVE_KEY_ID: 'admin-challenge-s14-live-v1',
    ADMIN_CHALLENGE_HASH_KEYRING: `admin-challenge-s14-live-v1:${secret(11)}`,
    ADMIN_ENROLLMENT_HASH_ACTIVE_KEY_ID: 'admin-enrollment-s14-live-v1',
    ADMIN_ENROLLMENT_HASH_KEYRING: `admin-enrollment-s14-live-v1:${secret(12)}`,
    ADMIN_IDEMPOTENCY_HASH_ACTIVE_KEY_ID: 'admin-idempotency-s14-live-v1',
    ADMIN_IDEMPOTENCY_HASH_KEYRING: `admin-idempotency-s14-live-v1:${secret(13)}`,
    ADMIN_RECOVERY_HASH_ACTIVE_KEY_ID: 'admin-recovery-s14-live-v1',
    ADMIN_RECOVERY_HASH_KEYRING: `admin-recovery-s14-live-v1:${secret(14)}`,
    ADMIN_SOURCE_HASH_ACTIVE_KEY_ID: 'admin-source-s14-live-v1',
    ADMIN_SOURCE_HASH_KEYRING: `admin-source-s14-live-v1:${secret(15)}`,
    ADMIN_TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'admin-totp-s14-live-v1',
    ADMIN_TOTP_ENCRYPTION_KEYRING: `admin-totp-s14-live-v1:${secret(16)}`,
    PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'provider-credential-s14-live-v1',
    PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING: `provider-credential-s14-live-v1:${secret(17)}`,
    PROVIDER_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'provider-credential-hint-s14-live-v1',
    PROVIDER_CREDENTIAL_HINT_KEYRING: `provider-credential-hint-s14-live-v1:${secret(25)}`,
    STORAGE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'storage-credential-s14-live-v1',
    STORAGE_CREDENTIAL_ENCRYPTION_KEYRING: `storage-credential-s14-live-v1:${secret(18)}`,
    STORAGE_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'storage-credential-hint-s14-live-v1',
    STORAGE_CREDENTIAL_HINT_KEYRING: `storage-credential-hint-s14-live-v1:${secret(26)}`,
    STORAGE_CAPABILITY_SECRET: secret(19),
    RESOURCE_CURSOR_SECRET: secret(20),
    RESOURCE_IDEMPOTENCY_SECRET: secret(21),
    PROVIDER_MODE: 'fake',
    PROVIDER_PROCESSOR_MODE: 'disabled',
    PROVIDER_ADAPTER: 'fake',
    PROVIDER_FAKE_WEBHOOK_KEY_ID: 'fake-webhook-s14-live-v1',
    PROVIDER_FAKE_WEBHOOK_SECRET: secret(22),
    PROVIDER_CALLBACK_DIGEST_ACTIVE_KEY_ID: 'callback-s14-live-v1',
    PROVIDER_CALLBACK_DIGEST_KEYRING: `callback-s14-live-v1:${secret(23)}`,
    LOCAL_UPLOAD_ROOT: resolve(repoRoot, 'uploads'),
    MAIL_PROVIDER: 'console',
    MAIL_FROM: 'no-reply@example.local',
    API_INTERNAL_ORIGIN: 'http://127.0.0.1:3101',
    NEXT_DIST_DIR: '.next-s14-live',
    S14_LIVE_E2E: '1',
  } satisfies NodeJS.ProcessEnv;
  Object.assign(process.env, environment, {
    S14_LIVE_ADMIN_IDENTIFIER: 's14-live-admin@example.test',
    S14_LIVE_ADMIN_PASSWORD: password,
    S14_LIVE_ADMIN_TOTP_SECRET: totpSecret,
    S14_LIVE_RUN_ID: runId,
  });

  const fixture = runFixture('setup', environment, {
    password,
    totpSecret,
  });
  if (typeof fixture.recovery_code !== 'string') {
    throw new Error('S14 live fixture did not return a recovery code');
  }
  if (typeof fixture.user_cookie !== 'string') {
    throw new Error('S14 live fixture did not return a user session cookie');
  }
  if (typeof fixture.totp_step !== 'number') {
    throw new Error('S14 live fixture did not return the bootstrap TOTP step');
  }
  process.env.S14_LIVE_ADMIN_RECOVERY_CODE = fixture.recovery_code;
  process.env.S14_LIVE_ADMIN_TOTP_LAST_USED_STEP = String(fixture.totp_step);
  process.env.S14_LIVE_USER_COOKIE = fixture.user_cookie;

  const api = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: resolve(repoRoot, 'apps/api'),
    env: environment,
    stdio: 'pipe',
  });
  const admin = spawn(
    process.execPath,
    [resolve(repoRoot, 'apps/admin/node_modules/next/dist/bin/next'), 'dev', '--port', '3200'],
    { cwd: resolve(repoRoot, 'apps/admin'), env: environment, stdio: 'pipe' },
  );
  const worker = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: resolve(repoRoot, 'apps/worker'),
    env: { ...environment, PROVIDER_PROCESSOR_MODE: 'fake_validation' },
    stdio: 'pipe',
  });
  let apiDiagnostics = '';
  let adminDiagnostics = '';
  let workerDiagnostics = '';
  let workerId: string | undefined;
  for (const stream of [api.stdout, api.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      apiDiagnostics = `${apiDiagnostics}${chunk.toString('utf8')}`.slice(-12_000);
    });
  }
  for (const stream of [admin.stdout, admin.stderr]) {
    stream.on('data', (chunk: Buffer) => {
      adminDiagnostics = `${adminDiagnostics}${chunk.toString('utf8')}`.slice(-6_000);
    });
  }
  worker.stdout.on('data', (chunk: Buffer) => {
    const value = chunk.toString('utf8');
    workerDiagnostics = `${workerDiagnostics}${value}`.slice(-6_000);
    for (const line of value.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as { event?: unknown; worker_id?: unknown };
        if (event.event === 'worker_ready' && typeof event.worker_id === 'string') {
          workerId = event.worker_id;
        }
      } catch {
        // Ignore framework startup output.
      }
    }
  });
  worker.stderr.on('data', (chunk: Buffer) => {
    workerDiagnostics = `${workerDiagnostics}${chunk.toString('utf8')}`.slice(-6_000);
  });

  try {
    await Promise.all([
      waitFor('http://127.0.0.1:3101/api/v1/health', api, () => apiDiagnostics),
      waitFor('http://127.0.0.1:3200/invites', admin, () => adminDiagnostics),
    ]);
    const deadline = Date.now() + 120_000;
    while (!workerId && Date.now() < deadline) {
      if (worker.exitCode !== null) {
        throw new Error(`S14 worker exited with ${worker.exitCode}: ${workerDiagnostics}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    if (!workerId) throw new Error(`Timed out waiting for S14 worker: ${workerDiagnostics}`);
  } catch (error) {
    await Promise.all([stopProcess(admin), stopProcess(api), stopProcess(worker)]);
    await writeFile(nextEnvPath, nextEnvBeforeTest, 'utf8');
    runFixture('cleanup', environment, { ...(workerId ? { workerId } : {}) });
    throw error;
  }

  return async () => {
    await Promise.all([stopProcess(admin), stopProcess(api), stopProcess(worker)]);
    await writeFile(
      resolve(repoRoot, 'apps/admin/test-results/s14-live-api.log'),
      apiDiagnostics,
      'utf8',
    );
    await writeFile(nextEnvPath, nextEnvBeforeTest, 'utf8');
    runFixture('cleanup', environment, { ...(workerId ? { workerId } : {}) });
  };
}
