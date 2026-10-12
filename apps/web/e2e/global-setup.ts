import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const healthUrl = 'http://127.0.0.1:3100/health';

async function isReady(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl);
    return response.ok;
  } catch {
    return false;
  }
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

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Mock E2E web server exited with ${child.exitCode}: ${diagnostics()}`);
    }
    if (await isReady()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${healthUrl}: ${diagnostics()}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (await isReady()) {
    throw new Error(
      'Port 3100 is already in use before mock E2E startup; existing servers are never reused',
    );
  }

  const nextEnvPath = resolve(webRoot, 'next-env.d.ts');
  const nextEnvBeforeTest = await readFile(nextEnvPath, 'utf8');
  const child = spawn(
    process.execPath,
    [resolve(webRoot, 'node_modules/next/dist/bin/next'), 'dev', '--port', '3100'],
    { cwd: webRoot, env: process.env, stdio: 'pipe' },
  );
  let diagnostics = '';
  const capture = (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-4_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  try {
    await waitForReady(child, () => diagnostics);
  } catch (error) {
    await stopProcess(child);
    await writeFile(nextEnvPath, nextEnvBeforeTest, 'utf8');
    throw error;
  }

  return async () => {
    await stopProcess(child);
    await writeFile(nextEnvPath, nextEnvBeforeTest, 'utf8');
  };
}
