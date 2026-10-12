import { execFileSync, spawn } from 'node:child_process';

const watch = process.argv.includes('--watch');
const repositoryRoot = new URL('../../..', import.meta.url);

function runPreflight(label, command, args) {
  console.log(JSON.stringify({ event: 'worker_startup_check_started', check: label }));
  try {
    execFileSync(command, args, {
      cwd: repositoryRoot,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });
    console.log(JSON.stringify({ event: 'worker_startup_check_passed', check: label }));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'worker_startup_check_failed',
        check: label,
        error_code: error instanceof Error ? error.message : 'STARTUP_CHECK_FAILED',
      }),
    );
    process.exit(1);
  }
}

if (!watch) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  runPreflight('workspace_build', pnpm, ['--filter', '@ecom-forge/worker...', 'build']);
  runPreflight('skill_content_validation', pnpm, [
    '--filter',
    '@ecom-forge/skills',
    'validate:skill-content',
  ]);
}

const child = spawn(
  process.execPath,
  watch
    ? [
        '--conditions=development',
        '--watch',
        '--env-file-if-exists=../../.env.local',
        '--import',
        'tsx',
        'src/main.ts',
      ]
    : ['--env-file-if-exists=../../.env.local', 'dist/main.js'],
  {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      // Local API and Worker share the base env file; only this process enables real work.
      PROVIDER_MODE: 'real',
      PROVIDER_ADAPTER: 'disabled',
      PROVIDER_PROCESSOR_MODE: 'real',
      AGENT_BRAIN_ADAPTER: 'approved',
      AGENT_PROCESSOR_ENABLED: 'true',
    },
    stdio: 'inherit',
  },
);

let stopping = false;
const forwardSignal = (signal) => {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
const stopOnInterrupt = () => forwardSignal('SIGINT');
const stopOnTerminate = () => forwardSignal('SIGTERM');
process.on('SIGINT', stopOnInterrupt);
process.on('SIGTERM', stopOnTerminate);
child.once('exit', (code, signal) => {
  process.removeListener('SIGINT', stopOnInterrupt);
  process.removeListener('SIGTERM', stopOnTerminate);
  process.exit(typeof code === 'number' ? code : signal ? 1 : 0);
});
