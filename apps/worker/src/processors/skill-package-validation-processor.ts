import { Worker, type Job } from 'bullmq';
import type { Database } from '@ecom-forge/db';
import { createBullMqConnection, parseQueuePayload, type QueuePayload } from '@ecom-forge/queue';

import type { WorkerConfig } from '../config/worker-config.js';
import type { ActiveWorkTracker, WorkerWriteFence } from '../lifecycle/processing-fence.js';
import type { QuarantineResourceReader } from '../skill-package/quarantine-resource.reader.js';
import { SkillPackageValidationService } from '../skill-package/skill-package-validation.service.js';
import type { ProviderCredentialValidationService } from '../provider/provider-credential-validation.service.js';
import type { ModelPocService } from '../provider/model-poc.service.js';
import type { StorageCredentialValidationService } from '../storage/storage-credential-validation.service.js';

type ValidationPayload = Extract<
  QueuePayload,
  {
    job_type:
      | 'skill-package.validate'
      | 'provider-credential.validate'
      | 'storage-credential.validate'
      | 'model-poc.run';
  }
>;

export class SkillPackageValidationProcessor {
  private readonly worker: Worker<ValidationPayload>;
  private readonly service: SkillPackageValidationService;
  private readonly providerCredentialValidation: ProviderCredentialValidationService | undefined;
  private readonly storageCredentialValidation: StorageCredentialValidationService | undefined;
  private readonly modelPoc: ModelPocService | undefined;

  constructor(
    database: Database,
    private readonly config: WorkerConfig,
    private readonly activeWork: ActiveWorkTracker,
    private readonly writeFence: WorkerWriteFence,
    reader: QuarantineResourceReader,
    providerCredentialValidation?: ProviderCredentialValidationService,
    storageCredentialValidation?: StorageCredentialValidationService,
    modelPoc?: ModelPocService,
  ) {
    this.service = new SkillPackageValidationService(
      database,
      reader,
      config.dispatchLeaseMs,
      config.dispatchLeaseRenewMs,
    );
    this.providerCredentialValidation = providerCredentialValidation;
    this.storageCredentialValidation = storageCredentialValidation;
    this.modelPoc = modelPoc;
    this.worker = new Worker<ValidationPayload>('evaluation', (job) => this.process(job), {
      connection: createBullMqConnection(config.redisUrl),
      prefix: config.redisPrefix,
      concurrency: 1,
      autorun: true,
    });
  }

  pauseNewWork(): Promise<void> {
    return this.worker.pause(true).then(() => undefined);
  }

  close(force: boolean): Promise<void> {
    return this.worker.close(force).then(() => undefined);
  }

  private process(job: Job<ValidationPayload>): Promise<void> {
    return this.activeWork.run(async () => {
      const payload = parseQueuePayload(job.data);
      this.writeFence.assertWritesAllowed();
      if (payload.job_type === 'skill-package.validate') {
        await this.service.execute(payload);
        return;
      }
      if (
        payload.job_type === 'provider-credential.validate' &&
        this.providerCredentialValidation
      ) {
        await this.providerCredentialValidation.execute(payload);
        return;
      }
      if (payload.job_type === 'storage-credential.validate' && this.storageCredentialValidation) {
        await this.storageCredentialValidation.execute(payload);
        return;
      }
      if (payload.job_type === 'model-poc.run' && this.modelPoc) {
        await this.modelPoc.execute(payload);
        return;
      }
      throw new Error('S14_EVALUATION_JOB_NOT_ENABLED');
    });
  }
}
