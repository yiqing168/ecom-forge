import { eq, workerHeartbeats, type Database } from '@ecom-forge/db';
import type { WorkerStatus } from '@ecom-forge/types';

export interface WorkerHeartbeatInput {
  id: string;
  workerType: string;
  status: WorkerStatus;
  lastSeenAt: Date;
  metadata: Record<string, unknown>;
}

export class WorkerHeartbeatRepository {
  constructor(private readonly database: Database) {}

  async write(input: WorkerHeartbeatInput): Promise<void> {
    await this.database
      .insert(workerHeartbeats)
      .values(input)
      .onConflictDoUpdate({
        target: workerHeartbeats.id,
        set: {
          workerType: input.workerType,
          status: input.status,
          lastSeenAt: input.lastSeenAt,
          metadata: input.metadata,
        },
      });
  }

  findById(id: string) {
    return this.database.query.workerHeartbeats.findFirst({
      where: eq(workerHeartbeats.id, id),
    });
  }
}
