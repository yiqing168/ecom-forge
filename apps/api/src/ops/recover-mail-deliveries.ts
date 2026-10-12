import { createDatabaseClient } from '@ecom-forge/db';

import { loadAppConfig } from '../config/app-config.js';
import { DrizzleMailDeliveryStore } from '../modules/auth/mail/drizzle-mail-delivery.store.js';
import { HmacKeyring } from '../modules/auth/security/hmac-keyring.js';

async function run(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error('Mail recovery does not accept command-line arguments');
  }

  const config = loadAppConfig();
  const resource = createDatabaseClient(
    config.databaseUrl ? { databaseUrl: config.databaseUrl } : {},
  );
  try {
    const store = new DrizzleMailDeliveryStore(
      resource.db,
      new HmacKeyring(config.auth.recipientHashKeys),
    );
    const cutoff = new Date(Date.now() - config.mail.recoveryStaleSeconds * 1000);
    const recovered = await store.recoverStaleQueued(cutoff);
    console.info(`Mail recovery converged ${recovered} queued delivery record(s).`);
  } finally {
    await resource.client.end();
  }
}

await run();
