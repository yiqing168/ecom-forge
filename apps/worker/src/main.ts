import { buildServiceName } from '@ecom-forge/shared';

import { loadWorkerConfig } from './config/worker-config.js';
import { ConsoleWorkerLogger, WorkerRuntime } from './worker-runtime.js';

export interface WorkerHealth {
  service: string;
  status: 'ready';
}

export function getWorkerHealth(): WorkerHealth {
  return {
    service: buildServiceName('worker'),
    status: 'ready',
  };
}

export async function startWorker(): Promise<WorkerRuntime> {
  const logger = new ConsoleWorkerLogger();
  const runtime = new WorkerRuntime(loadWorkerConfig(), logger);
  try {
    await runtime.start();
  } catch (error) {
    await runtime.shutdown().catch(() => undefined);
    throw error;
  }

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime
      .shutdown()
      .then(({ timedOut }) => {
        process.exit(timedOut ? 1 : 0);
      })
      .catch((error: unknown) => {
        logger.error({
          event: 'worker_shutdown_failed',
          error_code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
        });
        process.exit(1);
      });
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return runtime;
}

if (process.env.NODE_ENV !== 'test') {
  void startWorker().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'worker_start_failed',
        error_code: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      }),
    );
    process.exit(1);
  });
}
