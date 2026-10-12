import { createDatabaseClient } from '@ecom-forge/db';
import { createBullMqConnection, QueueIntentRepository } from '@ecom-forge/queue';

import { loadWorkerConfig } from '../config/worker-config.js';
import { BullMqQueuePublisher } from '../queue/queue-publisher.js';
import { ensureQueueRecoveryReady, QueueReconciler } from '../queue/reconciler.js';

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const databaseResource = createDatabaseClient({ databaseUrl: config.databaseUrl });
  const redis = createBullMqConnection(config.redisUrl);
  const publisher = new BullMqQueuePublisher(config);
  try {
    const reconciler = new QueueReconciler(
      databaseResource.db,
      databaseResource.client,
      redis,
      new QueueIntentRepository(databaseResource.db),
      publisher,
      config,
    );
    const result = await ensureQueueRecoveryReady(reconciler);
    if (!result.ready) throw new Error('Queue recovery is owned by another process');
    console.log(
      JSON.stringify({
        event: 'queue_reconciliation_finished',
        status: result.reconciliation?.status ?? 'already_ready',
        scanned: result.reconciliation?.scanned ?? 0,
        rebuilt: result.reconciliation?.rebuilt ?? 0,
        skipped_terminal: result.reconciliation?.skippedTerminal ?? 0,
        skipped_protected: result.reconciliation?.skippedProtected ?? 0,
        poison_cancelled: result.reconciliation?.poisonCancelled ?? 0,
      }),
    );
  } finally {
    await publisher.close();
    if (redis.status !== 'end') {
      await redis.quit().catch(() => redis.disconnect());
    }
    await databaseResource.client.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'queue_reconciliation_failed',
      error_code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
    }),
  );
  process.exitCode = 1;
});
