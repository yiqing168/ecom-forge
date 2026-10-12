import { createInterface } from 'node:readline/promises';

import { createDatabaseClient } from '@ecom-forge/db';

import { loadAppConfig } from '../config/app-config.js';
import {
  parseProviderModelApproval,
  ProviderModelService,
} from '../modules/provider-model/provider-model.service.js';

async function run(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Provider model approval requires an interactive terminal');
  }
  if (process.argv.length > 2) {
    throw new Error('Provider model approval does not accept command-line arguments');
  }

  const config = loadAppConfig();
  const resource = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const approval = parseProviderModelApproval({
      model_id: (await readline.question('Model row ID: ')).trim(),
      expected_status: (await readline.question('Expected status: ')).trim(),
      target_status: (await readline.question('Target status: ')).trim(),
      evidence_digest: (await readline.question('Evidence SHA-256 digest: ')).trim(),
      operator_id: (await readline.question('Operator ID: ')).trim(),
      reason: (await readline.question('Approval reason: ')).trim(),
    });

    console.info(
      `Change model ${approval.model_id} from ${approval.expected_status} to ${approval.target_status}.`,
    );
    const confirm = (await readline.question('Type APPROVE to continue: ')).trim();
    if (confirm !== 'APPROVE') {
      console.info('Provider model approval cancelled.');
      return;
    }

    const result = await new ProviderModelService(resource.db).approve(approval);
    console.info(
      JSON.stringify({
        event: 'provider_model_status_changed',
        model_id: result.model.id,
        expected_status: approval.expected_status,
        target_status: result.model.status,
        evidence_digest: result.audit.evidenceDigest,
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
