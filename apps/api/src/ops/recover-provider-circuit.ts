import { createInterface } from 'node:readline/promises';

import { createDatabaseClient } from '@ecom-forge/db';

import { loadAppConfig } from '../config/app-config.js';
import {
  parseProviderCircuitRecovery,
  ProviderCircuitControlService,
} from '../modules/provider-model/provider-circuit-control.service.js';

async function run(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Provider circuit recovery requires an interactive terminal');
  }
  if (process.argv.length > 2) {
    throw new Error('Provider circuit recovery does not accept command-line arguments');
  }

  const config = loadAppConfig();
  const resource = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const recovery = parseProviderCircuitRecovery({
      scope_key: (await readline.question('Circuit scope key: ')).trim(),
      expected_revision: Number((await readline.question('Expected revision: ')).trim()),
      operator_id: (await readline.question('Operator ID: ')).trim(),
      reason: (await readline.question('Recovery reason: ')).trim(),
    });
    const confirm = (await readline.question('Type RECOVER to continue: ')).trim();
    if (confirm !== 'RECOVER') {
      console.info('Provider circuit recovery cancelled.');
      return;
    }
    const result = await new ProviderCircuitControlService(resource.db).recover(recovery);
    console.info(
      JSON.stringify({
        event: 'provider_circuit_recovered',
        scope_key: result.circuit.scopeKey,
        revision: result.circuit.revision,
        operator_id: result.audit.operatorId,
        reason: result.audit.reason,
      }),
    );
  } finally {
    readline.close();
    await resource.client.end();
  }
}

await run();
