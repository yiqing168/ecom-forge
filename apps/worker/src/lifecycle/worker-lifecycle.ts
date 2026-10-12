import type { WorkerHeartbeatRepository } from '../database/heartbeat.repository.js';
import type { ActiveWorkTracker, WorkerWriteFence } from './processing-fence.js';

export interface DrainableWorkerResources {
  pauseNewWork(): Promise<void>;
  close(force: boolean): Promise<void>;
}

export interface WorkerLifecycleLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface WorkerLifecycleResult {
  timedOut: boolean;
}

export class WorkerLifecycle {
  private shutdownPromise: Promise<WorkerLifecycleResult> | undefined;

  constructor(
    private readonly workerId: string,
    private readonly heartbeat: WorkerHeartbeatRepository,
    private readonly resources: DrainableWorkerResources,
    private readonly activeWork: ActiveWorkTracker,
    private readonly writeFence: WorkerWriteFence,
    private readonly drainTimeoutMs: number,
    private readonly metadata: Record<string, unknown>,
    private readonly logger: WorkerLifecycleLogger,
  ) {}

  shutdown(): Promise<WorkerLifecycleResult> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<WorkerLifecycleResult> {
    await this.resources.pauseNewWork();
    await this.heartbeat.write({
      id: this.workerId,
      workerType: 'queue-worker',
      status: 'draining',
      lastSeenAt: new Date(),
      metadata: this.metadata,
    });

    const timedOut = await this.waitForDrain();
    if (timedOut) {
      this.writeFence.disableWrites();
      await this.resources.close(true);
      this.logger.error({
        event: 'worker_drain_timeout',
        worker_id: this.workerId,
        active_jobs: this.activeWork.activeCount,
      });
      return { timedOut: true };
    }

    await this.resources.close(false);
    await this.heartbeat.write({
      id: this.workerId,
      workerType: 'queue-worker',
      status: 'stopped',
      lastSeenAt: new Date(),
      metadata: this.metadata,
    });
    this.logger.info({ event: 'worker_stopped', worker_id: this.workerId });
    return { timedOut: false };
  }

  private async waitForDrain(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.drainTimeoutMs);
      timer.unref();
    });
    const result = await Promise.race([
      this.activeWork.waitForIdle().then(() => 'idle' as const),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    return result === 'timeout';
  }
}
