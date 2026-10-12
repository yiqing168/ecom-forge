import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type { TaskStatus } from '@ecom-forge/types';

export interface TaskListFilters {
  status?: TaskStatus;
  from?: Date;
  to?: Date;
  source?: 'chat' | 'canvas' | 'suite' | 'batch';
}

export interface TaskCursorPosition {
  workflowCreatedAt: Date;
  workflowRunId: string;
  taskId: string;
}

const cursorPayloadSchema = z.strictObject({
  v: z.literal(1),
  workflow_created_at: z.iso.datetime({ offset: true }),
  workflow_run_id: z.uuid(),
  task_id: z.uuid(),
  filter_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

function filterHash(filters: TaskListFilters): string {
  const canonical = JSON.stringify({
    status: filters.status ?? null,
    from: filters.from?.toISOString() ?? null,
    to: filters.to?.toISOString() ?? null,
    source: filters.source ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export class TaskCursorCodec {
  constructor(private readonly secret: string) {}

  encode(position: TaskCursorPosition, filters: TaskListFilters): string {
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        workflow_created_at: position.workflowCreatedAt.toISOString(),
        workflow_run_id: position.workflowRunId,
        task_id: position.taskId,
        filter_hash: filterHash(filters),
      }),
      'utf8',
    ).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  decode(cursor: string, filters: TaskListFilters): TaskCursorPosition {
    try {
      const parts = cursor.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error();
      const [body, signature] = parts;
      const expected = Buffer.from(this.sign(body), 'base64url');
      const actual = Buffer.from(signature, 'base64url');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error();
      }
      const parsed = cursorPayloadSchema.parse(
        JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      );
      if (parsed.filter_hash !== filterHash(filters)) throw new Error();
      return {
        workflowCreatedAt: new Date(parsed.workflow_created_at),
        workflowRunId: parsed.workflow_run_id,
        taskId: parsed.task_id,
      };
    } catch {
      throw new Error('Task cursor is invalid');
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body, 'utf8').digest('base64url');
  }
}
