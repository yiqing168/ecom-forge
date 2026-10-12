import { Worker, type Job } from 'bullmq';

import type { Database } from '@ecom-forge/db';
import { createBullMqConnection, parseQueuePayload, type QueuePayload } from '@ecom-forge/queue';

import { AssetProcessingService } from '../asset/asset-processing.service.js';
import type { WorkerConfig } from '../config/worker-config.js';
import type { ActiveWorkTracker, WorkerWriteFence } from '../lifecycle/processing-fence.js';
import type { WorkerLifecycleLogger } from '../lifecycle/worker-lifecycle.js';

type AssetPayload = Extract<QueuePayload, { job_type: 'asset.process' }>;

export class AssetProcessorWorker {
  private readonly worker: Worker<AssetPayload>;
  private readonly service: AssetProcessingService;

  constructor(
    database: Database,
    config: WorkerConfig,
    private readonly activeWork: ActiveWorkTracker,
    writeFence: WorkerWriteFence,
    telemetry?: WorkerLifecycleLogger,
  ) {
    this.service = new AssetProcessingService(database, config, writeFence, telemetry);
    this.worker = new Worker<AssetPayload>('asset', (job) => this.process(job), {
      connection: createBullMqConnection(config.redisUrl),
      prefix: config.redisPrefix,
      concurrency: 2,
      autorun: true,
    });
  }

  pauseNewWork(): Promise<void> {
    return this.worker.pause(true).then(() => undefined);
  }

  close(force: boolean): Promise<void> {
    return this.worker.close(force).then(() => undefined);
  }

  private process(job: Job<AssetPayload>): Promise<void> {
    return this.activeWork.run(async () => {
      const payload = parseQueuePayload(job.data);
      if (payload.job_type !== 'asset.process') return;
      await this.service.execute(payload);
    });
  }
}
