import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { createDatabaseClient } from '@ecom-forge/db';

import { loadAppConfig } from '../config/app-config.js';
import {
  parseProviderModelRegistration,
  ProviderModelService,
} from '../modules/provider-model/provider-model.service.js';

async function readManifest(path: string): Promise<unknown> {
  const resolved = resolve(path);
  const metadata = await stat(resolved);
  if (!metadata.isFile() || metadata.size > 1_048_576) {
    throw new Error('Provider model manifest must be a JSON file no larger than 1 MiB');
  }
  const contents = await readFile(resolved, 'utf8');
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error('Provider model manifest must contain valid JSON');
  }
}

async function run(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Provider model registration requires an interactive terminal');
  }
  if (process.argv.length > 2) {
    throw new Error('Provider model registration does not accept command-line arguments');
  }

  const config = loadAppConfig();
  const resource = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const manifestPath = (await readline.question('Model snapshot manifest JSON path: ')).trim();
    if (!manifestPath) throw new Error('Model snapshot manifest path is required');
    const manifest = parseProviderModelRegistration(await readManifest(manifestPath));

    console.info(
      `Register ${manifest.provider}/${manifest.model_id}@${manifest.version} as free_test_only.`,
    );
    const confirm = (await readline.question('Type REGISTER to continue: ')).trim();
    if (confirm !== 'REGISTER') {
      console.info('Provider model registration cancelled.');
      return;
    }

    const result = await new ProviderModelService(resource.db).register(manifest);
    console.info(
      JSON.stringify({
        event: result.reused
          ? 'provider_model_snapshot_reused'
          : 'provider_model_snapshot_registered',
        model_id: result.model.id,
        provider: result.model.provider,
        provider_model_id: result.model.modelId,
        version: result.model.version,
        status: result.model.status,
      }),
    );
  } finally {
    readline.close();
    await resource.client.end();
  }
}

await run();
