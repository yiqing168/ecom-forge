import { randomUUID } from 'node:crypto';

import {
  artifacts,
  createDatabaseClient,
  eq,
  inArray,
  taskAttempts,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { WorkflowQueryService } from '../src/modules/workflow/workflow-query.service.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';

function assertIsolatedDatabase(): void {
  const testUrl = new URL(databaseUrl);
  const testName = testUrl.pathname.replace(/^\//, '').toLowerCase();
  if (!/_test(?:_|$)/.test(testName)) {
    throw new Error('S05 workflow query tests require a database name containing _test');
  }
}

assertIsolatedDatabase();

const resource = createDatabaseClient({ databaseUrl, maxConnections: 10 });
const service = new WorkflowQueryService(resource.db, 's05-query-cursor-secret');
const tracked = {
  artifacts: new Set<string>(),
  users: new Set<string>(),
  workflows: new Set<string>(),
  tasks: new Set<string>(),
  attempts: new Set<string>(),
};

async function createFixture(input: {
  userId: string;
  createdAt: Date;
  taskCount?: number;
  imageOutputCount?: number;
}) {
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId: input.userId,
      triggerMode: 'chat',
      status: 'queued',
      createdAt: input.createdAt,
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
    })
    .returning();
  if (!workflow) throw new Error('Failed to create workflow query fixture');
  tracked.workflows.add(workflow.id);

  const createdTasks = [];
  for (let index = 0; index < (input.taskCount ?? 1); index += 1) {
    const [task] = await resource.db
      .insert(tasks)
      .values({
        workflowRunId: workflow.id,
        type: input.imageOutputCount ? 'image.generate' : `s05.query.${index}`,
        status: 'queued',
        costEstimate: '0.00',
        idempotencyKey: `s05-query-${workflow.id}-${index}`,
        dagNodeId: `query-node-${index}`,
        dagJson: {},
        paramsSnapshot: input.imageOutputCount ? { output_count: input.imageOutputCount } : {},
      })
      .returning();
    if (!task) throw new Error('Failed to create task query fixture');
    tracked.tasks.add(task.id);
    createdTasks.push(task);
  }
  return { workflow, tasks: createdTasks };
}

async function createUser(): Promise<typeof users.$inferSelect> {
  const [user] = await resource.db
    .insert(users)
    .values({
      email: `s05-query-${randomUUID()}@example.com`,
      displayName: 'S05 query test user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create query user fixture');
  tracked.users.add(user.id);
  return user;
}

afterEach(async () => {
  if (tracked.artifacts.size > 0) {
    await resource.db.delete(artifacts).where(inArray(artifacts.id, [...tracked.artifacts]));
    tracked.artifacts.clear();
  }
  if (tracked.attempts.size > 0) {
    await resource.db.delete(taskAttempts).where(inArray(taskAttempts.id, [...tracked.attempts]));
    tracked.attempts.clear();
  }
  if (tracked.tasks.size > 0) {
    await resource.db.delete(tasks).where(inArray(tasks.id, [...tracked.tasks]));
    tracked.tasks.clear();
  }
  if (tracked.workflows.size > 0) {
    await resource.db.delete(workflowRuns).where(inArray(workflowRuns.id, [...tracked.workflows]));
    tracked.workflows.clear();
  }
  if (tracked.users.size > 0) {
    await resource.db.delete(users).where(inArray(users.id, [...tracked.users]));
    tracked.users.clear();
  }
});

afterAll(async () => {
  await resource.client.end();
});

describe('S05 workflow query boundaries', () => {
  it('returns only the current user data and preserves the stable task cursor', async () => {
    const currentUser = await createUser();
    const otherUser = await createUser();
    const newest = await createFixture({
      userId: currentUser.id,
      createdAt: new Date('2026-08-10T02:00:00.000Z'),
      taskCount: 2,
    });
    const older = await createFixture({
      userId: currentUser.id,
      createdAt: new Date('2026-08-10T01:00:00.000Z'),
    });
    const other = await createFixture({
      userId: otherUser.id,
      createdAt: new Date('2026-08-10T03:00:00.000Z'),
    });

    await expect(service.getWorkflowSnapshot(otherUser.id, newest.workflow.id)).resolves.toBeNull();

    const firstPage = await service.listTasks({
      userId: currentUser.id,
      filters: {},
      limit: 2,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items.every((item) => item.workflow_run.id !== other.workflow.id)).toBe(true);
    expect(firstPage.next_cursor).toBeTruthy();

    const secondPage = await service.listTasks({
      userId: currentUser.id,
      filters: {},
      ...(firstPage.next_cursor ? { cursor: firstPage.next_cursor } : {}),
      limit: 2,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.workflow_run.id).toBe(older.workflow.id);
    expect(secondPage.next_cursor).toBeNull();
  });

  it('rejects a malformed cursor even when the batch source is not active yet', async () => {
    const user = await createUser();

    await expect(
      service.listTasks({
        userId: user.id,
        filters: { source: 'batch' },
        cursor: 'malformed',
        limit: 20,
      }),
    ).rejects.toThrow('Task cursor is invalid');
  });

  it('returns published workflow artifacts and excludes quarantined or deleted outputs', async () => {
    const user = await createUser();
    const fixture = await createFixture({
      userId: user.id,
      createdAt: new Date('2026-08-10T04:00:00.000Z'),
      imageOutputCount: 3,
    });
    const task = fixture.tasks[0]!;
    const inserted = await resource.db
      .insert(artifacts)
      .values(
        ['private', 'quarantined', 'deleted'].map((visibility, index) => ({
          taskId: task.id,
          userId: user.id,
          type: 'image' as const,
          storageKey: `s05-query/${task.id}/${index}.png`,
          metaJson: { output_index: index },
          paramsSnapshot: {},
          sourceAction: 'generate' as const,
          originDomain: 'creative' as const,
          producerMode: 'suite' as const,
          mutationOwner: 'suite' as const,
          visibility: visibility as 'private' | 'quarantined' | 'deleted',
        })),
      )
      .returning({ id: artifacts.id, visibility: artifacts.visibility });
    for (const artifact of inserted) tracked.artifacts.add(artifact.id);

    const snapshot = await service.getWorkflowSnapshot(user.id, fixture.workflow.id);

    expect(snapshot?.tasks[0]?.output_count).toBe(3);
    expect(snapshot?.artifacts).toEqual([
      expect.objectContaining({
        id: inserted.find((artifact) => artifact.visibility === 'private')?.id,
        task_id: task.id,
        type: 'image',
        visibility: 'private',
        output_index: 0,
      }),
    ]);
  });

  it('projects failed and outcome-unknown images as explicitly regenerable', async () => {
    const user = await createUser();
    const original = await createFixture({
      userId: user.id,
      createdAt: new Date('2026-08-10T05:00:00.000Z'),
      imageOutputCount: 1,
      taskCount: 3,
    });
    for (const task of original.tasks) {
      await resource.db
        .update(tasks)
        .set({ status: 'failed', endedAt: new Date() })
        .where(eq(tasks.id, task.id));
    }
    const attempts = await resource.db
      .insert(taskAttempts)
      .values([
        {
          taskId: original.tasks[0]!.id,
          attemptNo: 1,
          status: 'failed',
          dispatchState: 'accepted',
          provider: 's05-provider',
          endedAt: new Date(),
        },
        {
          taskId: original.tasks[1]!.id,
          attemptNo: 1,
          status: 'outcome_unknown',
          dispatchState: 'outcome_unknown',
          provider: 's05-provider',
          endedAt: new Date(),
        },
        {
          taskId: original.tasks[2]!.id,
          attemptNo: 1,
          status: 'failed',
          dispatchState: 'accepted',
          provider: 's05-provider',
          endedAt: new Date(),
        },
      ])
      .returning({ id: taskAttempts.id });
    for (const attempt of attempts) tracked.attempts.add(attempt.id);

    const retry = await createFixture({
      userId: user.id,
      createdAt: new Date('2026-08-10T05:01:00.000Z'),
      imageOutputCount: 1,
    });
    await resource.db
      .update(tasks)
      .set({ parentTaskId: original.tasks[0]!.id })
      .where(eq(tasks.id, retry.tasks[0]!.id));
    await resource.db
      .update(tasks)
      .set({ paramsSnapshot: { output_count: 2 } })
      .where(eq(tasks.id, original.tasks[2]!.id));

    const snapshot = await service.getWorkflowSnapshot(user.id, original.workflow.id);

    expect(snapshot?.tasks[0]).toMatchObject({
      retryable: false,
      latest_retry: {
        workflow_run_id: retry.workflow.id,
        task_id: retry.tasks[0]!.id,
        status: 'queued',
      },
    });
    expect(snapshot?.tasks[1]).toMatchObject({ retryable: true, latest_retry: null });
    expect(snapshot?.tasks[2]).toMatchObject({ retryable: false, latest_retry: null });
    expect(snapshot?.tasks[0]).not.toHaveProperty('dispatch_state');
  });
});
