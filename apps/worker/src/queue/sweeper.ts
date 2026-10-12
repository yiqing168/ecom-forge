import type { QueueIntentRepository } from '@ecom-forge/queue';

import type { WorkerConfig } from '../config/worker-config.js';

export class QueueLeaseSweeper {
  constructor(
    private readonly intents: QueueIntentRepository,
    private readonly config: WorkerConfig,
  ) {}

  recoverOnce(now = new Date()): Promise<number> {
    return this.intents.recoverExpiredLeases({
      now,
      limit: this.config.dispatchBatchSize,
    });
  }
}
