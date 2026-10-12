import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type CapturedMail = { otp: string; purpose: string };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function secret(): string {
  return randomBytes(32).toString('base64url');
}

function assertLoopbackEndpoint(value: string, name: string): string {
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new Error(`${name} must use loopback infrastructure for live E2E`);
  }
  return value;
}

function assertTestDatabase(value: string): string {
  const databaseName = new URL(value).pathname.replace(/^\//, '').toLowerCase();
  if (!/_test(?:_|$)/.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL database name must contain _test for live E2E');
  }
  return value;
}

function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolveStop) => {
    const forceTimer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
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
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function waitForWorker(
  child: ChildProcessWithoutNullStreams,
  ready: () => boolean,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Worker exited with ${child.exitCode}: ${diagnostics()}`);
    }
    if (ready()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for live E2E Worker: ${diagnostics()}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const nextEnvPath = resolve(repoRoot, 'apps/web/next-env.d.ts');
  const nextEnvBeforeTest = await readFile(nextEnvPath, 'utf8');
  const secrets = Array.from({ length: 27 }, secret);
  const storageRoot = await mkdtemp(join(tmpdir(), 'ecom-forge-live-storage-'));
  const collectorToken = randomBytes(18).toString('base64url');
  const databaseUrl = assertTestDatabase(
    assertLoopbackEndpoint(
      process.env.TEST_DATABASE_URL ??
        'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test',
      'TEST_DATABASE_URL',
    ),
  );
  const redisUrl = assertLoopbackEndpoint(
    process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1',
    'TEST_REDIS_URL',
  );
  const redisPrefix = `s03-live-e2e-${randomBytes(8).toString('hex')}`;
  const environment = {
    ...process.env,
    APP_ENV: 'local',
    API_PORT: '3101',
    WEB_ORIGIN: 'http://127.0.0.1:3100',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    REDIS_PREFIX: redisPrefix,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    AUTH_SECRET: secrets[0],
    AUTH_TRUSTED_ORIGINS: 'http://127.0.0.1:3100',
    AUTH_OTP_HASH_SECRET: secrets[1],
    AUTH_RATE_LIMIT_SECRET: secrets[2],
    AUTH_VERIFICATION_TICKET_SECRET: secrets[3],
    AUTH_INVITE_CODE_ACTIVE_KEY_ID: 'invite-live-v1',
    AUTH_INVITE_CODE_KEYRING: `invite-live-v1:${secrets[4]}`,
    ADMIN_INVITE_CODE_ENCRYPTION_ACTIVE_KEY_ID: 'invite-envelope-live-v1',
    ADMIN_INVITE_CODE_ENCRYPTION_KEYRING: `invite-envelope-live-v1:${secrets[26]}`,
    MAIL_RECIPIENT_HASH_ACTIVE_KEY_ID: 'recipient-live-v1',
    MAIL_RECIPIENT_HASH_KEYRING: `recipient-live-v1:${secrets[5]}`,
    AUTH_REWARD_FINGERPRINT_ACTIVE_KEY_ID: 'reward-live-v1',
    AUTH_REWARD_FINGERPRINT_KEYRING: `reward-live-v1:${secrets[6]}`,
    ADMIN_ORIGIN: 'http://127.0.0.1:3200',
    ADMIN_ALLOWED_HOSTS: '127.0.0.1:3101,localhost:3101,127.0.0.1:3200,localhost:3200',
    TRUSTED_ADMIN_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    ADMIN_NETWORK_GATE_MODE: 'source_allowlist',
    ADMIN_SOURCE_ALLOWLIST_CIDRS: '127.0.0.1/32,::1/128',
    ADMIN_COOKIE_SECURE: 'false',
    ADMIN_IDENTIFIER_HASH_ACTIVE_KEY_ID: 'admin-identifier-live-v1',
    ADMIN_IDENTIFIER_HASH_KEYRING: `admin-identifier-live-v1:${secrets[12]}`,
    ADMIN_SESSION_HASH_ACTIVE_KEY_ID: 'admin-session-live-v1',
    ADMIN_SESSION_HASH_KEYRING: `admin-session-live-v1:${secrets[13]}`,
    ADMIN_CSRF_DERIVATION_ACTIVE_KEY_ID: 'admin-csrf-live-v1',
    ADMIN_CSRF_DERIVATION_KEYRING: `admin-csrf-live-v1:${secrets[14]}`,
    ADMIN_CHALLENGE_HASH_ACTIVE_KEY_ID: 'admin-challenge-live-v1',
    ADMIN_CHALLENGE_HASH_KEYRING: `admin-challenge-live-v1:${secrets[15]}`,
    ADMIN_ENROLLMENT_HASH_ACTIVE_KEY_ID: 'admin-enrollment-live-v1',
    ADMIN_ENROLLMENT_HASH_KEYRING: `admin-enrollment-live-v1:${secrets[16]}`,
    ADMIN_IDEMPOTENCY_HASH_ACTIVE_KEY_ID: 'admin-idempotency-live-v1',
    ADMIN_IDEMPOTENCY_HASH_KEYRING: `admin-idempotency-live-v1:${secrets[20]}`,
    ADMIN_RECOVERY_HASH_ACTIVE_KEY_ID: 'admin-recovery-live-v1',
    ADMIN_RECOVERY_HASH_KEYRING: `admin-recovery-live-v1:${secrets[17]}`,
    ADMIN_SOURCE_HASH_ACTIVE_KEY_ID: 'admin-source-live-v1',
    ADMIN_SOURCE_HASH_KEYRING: `admin-source-live-v1:${secrets[18]}`,
    ADMIN_TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'admin-totp-live-v1',
    ADMIN_TOTP_ENCRYPTION_KEYRING: `admin-totp-live-v1:${secrets[19]}`,
    PROVIDER_MODE: 'fake',
    PROVIDER_PROCESSOR_MODE: 'disabled',
    PROVIDER_ADAPTER: 'fake',
    PROVIDER_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'provider-credential-s11-live-v1',
    PROVIDER_CREDENTIAL_ENCRYPTION_KEYRING: `provider-credential-s11-live-v1:${secrets[22]}`,
    PROVIDER_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'provider-credential-hint-s11-live-v1',
    PROVIDER_CREDENTIAL_HINT_KEYRING: `provider-credential-hint-s11-live-v1:${secrets[23]}`,
    STORAGE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: 'storage-credential-s11-live-v1',
    STORAGE_CREDENTIAL_ENCRYPTION_KEYRING: `storage-credential-s11-live-v1:${secrets[24]}`,
    STORAGE_CREDENTIAL_HINT_ACTIVE_KEY_ID: 'storage-credential-hint-s11-live-v1',
    STORAGE_CREDENTIAL_HINT_KEYRING: `storage-credential-hint-s11-live-v1:${secrets[25]}`,
    PROVIDER_FAKE_WEBHOOK_KEY_ID: 'fake-webhook-live-v1',
    PROVIDER_FAKE_WEBHOOK_SECRET: secrets[7],
    PROVIDER_CALLBACK_DIGEST_ACTIVE_KEY_ID: 'callback-live-v1',
    PROVIDER_CALLBACK_DIGEST_KEYRING: `callback-live-v1:${secrets[8]}`,
    LOCAL_UPLOAD_ROOT: storageRoot,
    STORAGE_CAPABILITY_SECRET: secrets[9],
    RESOURCE_CURSOR_SECRET: secrets[10],
    RESOURCE_IDEMPOTENCY_SECRET: secrets[11],
    MAIL_PROVIDER: 'console',
    MAIL_FROM: 'no-reply@example.local',
    API_INTERNAL_ORIGIN: 'http://127.0.0.1:3101',
    NEXT_DIST_DIR: '.next-s03-live',
    S03_LIVE_E2E: '1',
    S06_LIVE_E2E: '1',
    S10_LIVE_E2E: process.env.S10_LIVE_E2E ?? '0',
    S11_LIVE_E2E: process.env.S11_LIVE_E2E ?? '0',
    S12_LIVE_E2E: process.env.S12_LIVE_E2E ?? '0',
    AGENT_BRAIN_ADAPTER: 'fake',
    AGENT_PROCESSOR_ENABLED:
      process.env.S11_LIVE_E2E === '1' || process.env.S12_LIVE_E2E === '1' ? 'true' : 'false',
    SSE_HEARTBEAT_INTERVAL_MS: '500',
    NEXT_PUBLIC_SSE_WATCHDOG_TIMEOUT_MS: '2000',
  } satisfies NodeJS.ProcessEnv;
  const workerEnvironment = {
    ...environment,
    PROVIDER_PROCESSOR_MODE: environment.S12_LIVE_E2E === '1' ? 'fake_validation' : 'disabled',
  } satisfies NodeJS.ProcessEnv;
  Object.assign(process.env, environment);

  if (environment.S12_LIVE_E2E === '1') {
    runS12OrphanCleanup(environment);
  }

  const capturedMail: CapturedMail[] = [];
  const collector = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || url.pathname !== `/${collectorToken}/latest`) {
      response.writeHead(404).end();
      return;
    }
    const purpose = url.searchParams.get('purpose');
    const message = capturedMail.findLast((candidate) => candidate.purpose === purpose);
    if (!message) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(message));
  });
  await new Promise<void>((resolveListen, reject) => {
    collector.once('error', reject);
    collector.listen(0, '127.0.0.1', resolveListen);
  });
  const collectorAddress = collector.address();
  if (!collectorAddress || typeof collectorAddress === 'string') {
    await closeServer(collector);
    throw new Error('S03 live mail collector did not bind a TCP port');
  }
  process.env.S03_LIVE_MAIL_COLLECTOR = `http://127.0.0.1:${collectorAddress.port}/${collectorToken}`;

  const api = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: resolve(repoRoot, 'apps/api'),
    env: environment,
    stdio: 'pipe',
  });
  let apiDiagnostics = '';
  api.stderr.on('data', (chunk: Buffer) => {
    apiDiagnostics = `${apiDiagnostics}${chunk.toString('utf8')}`.slice(-4_000);
  });
  let apiBuffer = '';
  api.stdout.on('data', (chunk: Buffer) => {
    apiBuffer += chunk.toString('utf8');
    const lines = apiBuffer.split(/\r?\n/);
    apiBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const match = line.match(/\[DEV MAIL\] ([a-z_]+):.+ -> (\d{6}) \(\d+m\)/);
      if (match?.[1] && match[2]) capturedMail.push({ purpose: match[1], otp: match[2] });
    }
  });

  const web = spawn(
    process.execPath,
    [resolve(repoRoot, 'apps/web/node_modules/next/dist/bin/next'), 'dev', '--port', '3100'],
    { cwd: resolve(repoRoot, 'apps/web'), env: environment, stdio: 'pipe' },
  );
  let webDiagnostics = '';
  web.stdout.on('data', (chunk: Buffer) => {
    webDiagnostics = `${webDiagnostics}${chunk.toString('utf8')}`.slice(-4_000);
  });
  web.stderr.on('data', (chunk: Buffer) => {
    webDiagnostics = `${webDiagnostics}${chunk.toString('utf8')}`.slice(-4_000);
  });

  let worker: ChildProcessWithoutNullStreams | undefined;
  let workerDiagnostics = '';
  let workerReady = false;
  let workerId: string | undefined;
  if (
    environment.S10_LIVE_E2E === '1' ||
    environment.S11_LIVE_E2E === '1' ||
    environment.S12_LIVE_E2E === '1'
  ) {
    worker = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: resolve(repoRoot, 'apps/worker'),
      env: workerEnvironment,
      stdio: 'pipe',
    });
    worker.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      workerDiagnostics = `${workerDiagnostics}${text}`.slice(-4_000);
      for (const line of text.split(/\r?\n/)) {
        try {
          const event = JSON.parse(line) as { event?: unknown; worker_id?: unknown };
          if (event.event === 'worker_ready' && typeof event.worker_id === 'string') {
            workerId = event.worker_id;
            workerReady = true;
          }
        } catch {
          // Ignore non-JSON process output.
        }
      }
    });
    worker.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      workerDiagnostics = `${workerDiagnostics}${text}`.slice(-4_000);
      if (environment.S12_LIVE_E2E === '1') process.stderr.write(text);
    });
  }

  try {
    await Promise.all([
      waitFor('http://127.0.0.1:3101/api/v1/health', api, () => apiDiagnostics),
      waitFor('http://127.0.0.1:3100/health', web, () => webDiagnostics),
      ...(worker
        ? [
            waitForWorker(
              worker,
              () => workerReady,
              () => workerDiagnostics,
            ),
          ]
        : []),
    ]);
  } catch (error) {
    await Promise.all([
      stopProcess(web),
      stopProcess(api),
      ...(worker ? [stopProcess(worker)] : []),
    ]);
    await writeFile(nextEnvPath, nextEnvBeforeTest, 'utf8');
    await closeServer(collector);
    await rm(storageRoot, { force: true, recursive: true });
    throw error;
  }

  return async () => {
    await Promise.all([
      stopProcess(web),
      stopProcess(api),
      ...(worker ? [stopProcess(worker)] : []),
    ]);
    if (workerId && environment.S10_LIVE_E2E === '1') {
      const fixture = resolve(repoRoot, 'apps/api/test/s10-live.fixture.ts');
      const tsx = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
      const cleanup = spawnSync(process.execPath, [tsx, fixture, 'cleanup-worker'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: environment,
        input: JSON.stringify({ workerId }),
      });
      if (cleanup.status !== 0) {
        throw new Error(`S10 Worker cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
      }
    }
    if (environment.S12_LIVE_E2E === '1') {
      runS12OrphanCleanup(environment);
    }
    if (environment.S11_LIVE_E2E === '1') {
      const fixture = resolve(repoRoot, 'apps/api/test/s11-live.fixture.ts');
      const tsx = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
      const cleanup = spawnSync(process.execPath, [tsx, fixture, 'cleanup'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: environment,
        input: JSON.stringify({ workerId }),
      });
      if (cleanup.status !== 0) {
        throw new Error(`S11 live cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
      }
    }
    await writeFile(nextEnvPath, nextEnvBeforeTest, 'utf8');
    await closeServer(collector);
    await rm(storageRoot, { force: true, recursive: true });
  };
}

function runS12OrphanCleanup(environment: NodeJS.ProcessEnv): void {
  const fixture = resolve(repoRoot, 'apps/api/test/s12-live.fixture.ts');
  const tsx = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
  const cleanup = spawnSync(process.execPath, [tsx, fixture, 'cleanup-orphans'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: environment,
    input: '{}',
  });
  if (cleanup.status !== 0) {
    throw new Error(`S12 user cleanup failed: ${cleanup.stderr || cleanup.stdout}`);
  }
}
