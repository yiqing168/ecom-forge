#!/usr/bin/env node
/**
 * Stage 0 gate — aggregates the 1A `validate:*` commands documented in
 * `docs/09-validation-and-operations.md` ("验证命令") and runs each one for real.
 *
 * docs/09 requires this entrypoint to validate the actual matched test count of every
 * subcommand and forbids substituting fake results. A documented validation that is not
 * implemented is therefore a gate failure, not something to skip quietly.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The complete 1A list from `docs/09` ("验证命令"): every documented command must run here for
// real. Three entries are documented but not implemented yet — they are reported as failures
// (red is real) until they land or the document is amended.
const documented = [
  'validate:single-dispatch',
  'validate:provider-timeout',
  'validate:webhook-lost',
  'validate:duplicate-click',
  'validate:worker-recovery',
  'validate:ledger-replay',
  'validate:cost-report',
  'validate:agent-trace-loop',
  'validate:skill-load-cache',
  'validate:skill-content',
  'validate:golden-eval-gate',
  'validate:image-pipeline',
  'validate:creative-chat',
  'validate:specialized-skills',
  'validate:operations-control-plane',
  'validate:smoke',
];

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const failures = [];

for (const command of documented) {
  const script = pkg.scripts?.[command];
  if (typeof script !== 'string') {
    failures.push(`${command}: documented in docs/09 but not implemented in package.json`);
    continue;
  }
  console.log(`\n=== ${command} ===`);
  const result = spawnSync(script, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`[stage0] ${command} FAILED (exit ${result.status ?? 'signal'})`);
    failures.push(`${command}: exited ${result.status ?? 'signal'}`);
  }
}

if (failures.length > 0) {
  console.error('\n[stage0] FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    '\n[stage0] Implement the missing validations (or amend docs/09) before this gate can pass.',
  );
  process.exit(1);
}

console.log('\n[stage0] every documented 1A validation passed');
