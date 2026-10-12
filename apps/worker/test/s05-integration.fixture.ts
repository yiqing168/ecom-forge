import { randomUUID } from 'node:crypto';

import {
  createDatabaseClient,
  creditReservations,
  eventOutbox,
  inArray,
  models,
  providerCallbackEvents,
  providerCircuitStates,
  queueDispatchIntents,
  runQuotes,
  taskAttempts,
  tasks,
  users,
  workerHeartbeats,
  workflowRuns,
} from '@ecom-forge/db';
import { createBullMqConnection } from '@ecom-forge/queue';

const DEFAULT_TEST_DATABASE_URL =
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const DEFAULT_TEST_REDIS_URL = 'redis://127.0.0.1:6379/1';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
export const testRedisUrl = process.env.TEST_REDIS_URL ?? DEFAULT_TEST_REDIS_URL;
export const testRedisPrefix =
  process.env.TEST_REDIS_PREFIX ?? `s05-test-${randomUUID().replaceAll('-', '')}`;

function assertSafeTestInfrastructure(): void {
  const database = new URL(testDatabaseUrl);
  const databaseName = database.pathname.replace(/^\//, '').toLowerCase();
  if (!/_test(?:_|$)/.test(databaseName)) {
    throw new Error('S05 integration tests require a database name containing _test');
  }
  if (!testRedisPrefix.startsWith('s05-test-')) {
    throw new Error('S05 integration tests require a unique s05-test-* Redis prefix');
  }
}

assertSafeTestInfrastructure();

export const databaseResource: ReturnType<typeof createDatabaseClient> = createDatabaseClient({
  databaseUrl: testDatabaseUrl,
  maxConnections: 20,
});
export const redis = createBullMqConnection(testRedisUrl);

export const integrationWorkerConfig = {
  appEnv: 'test',
  databaseUrl: testDatabaseUrl,
  databasePoolMax: 20,
  databaseStatementTimeoutMs: 15_000,
  databaseTransactionTimeoutMs: 10_000,
  redisUrl: testRedisUrl,
  redisPrefix: testRedisPrefix,
  localUploadRoot: './uploads',
  storageEnabled: true,
  storageMaxImageBytes: 20 * 1024 * 1024,
  storageMaxImageWidth: 16_384,
  storageMaxImageHeight: 16_384,
  storageMaxImagePixels: 100_000_000,
  contentReviewDeadlineMs: 86_400_000,
  contentReviewSweepBatchSize: 50,
  outcomeUnknownReleaseDeadlineMs: 30 * 60 * 1_000,
  outcomeUnknownReleaseSweepBatchSize: 50,
  testProcessorEnabled: true,
  settlementProcessorEnabled: true,
  providerMode: 'fake',
  providerProcessorMode: 'disabled',
  providerAdapter: 'fake',
  providerRelayOrigins: ['https://local.invalid'],
  providerImageOutputOrigins: ['https://local.invalid'],
  providerRequestTimeoutMs: 30_000,
  imageProviderRequestTimeoutMs: 180_000,
  providerImageTaskConcurrency: 9,
  agentProcessorEnabled: true,
  agentBrainAdapter: 'fake',
  agentBrainReasoningEffort: 'medium',
  providerRealPocEnabled: false,
  agentRequestTimeoutMs: 5_000,
  agentProcessingLeaseMs: 10_000,
  agentProcessingRenewMs: 2_000,
  agentProcessingRetryAttempts: 3,
  agentProcessingRetryBaseMs: 1_000,
  agentMaxLlmRounds: 6,
  agentMaxToolCalls: 12,
  agentMaxInputTokens: 96_000,
  agentMaxOutputTokens: 8_192,
  agentBrainStepMaxOutputTokens: 1_024,
  agentBrainImageMaxEdge: 1_536,
  agentBrainRetryBaseDelayMs: 1_000,
  agentBrainRetryMaxDelayMs: 8_000,
  agentBrainImageMaterializationConcurrency: 2,
  agentBrainMaxMaterializedImageBytes: 64 * 1024 * 1024,
  agentMaxEstimatedCostCny: '0.15',
  agentMaxReferences: 12,
  agentExecutionPolicyVersion: 'agent-execution-policy-v1',
  compilerQuoteTtlSeconds: 600,
  heartbeatIntervalMs: 1_000,
  heartbeatStaleMs: 3_000,
  dispatchLeaseMs: 5_000,
  dispatchLeaseRenewMs: 1_000,
  dispatchPollMs: 100,
  dispatchBatchSize: 100,
  dispatchBackoffBaseMs: 100,
  dispatchBackoffMaxMs: 1_000,
  drainTimeoutMs: 1_000,
} as const;

const tracked = {
  users: new Set<string>(),
  workflows: new Set<string>(),
  tasks: new Set<string>(),
  attempts: new Set<string>(),
  intents: new Set<string>(),
  events: new Set<string>(),
  heartbeats: new Set<string>(),
  models: new Set<string>(),
  callbacks: new Set<string>(),
  circuits: new Set<string>(),
  quotes: new Set<string>(),
  reservations: new Set<string>(),
};

export function track(kind: keyof typeof tracked, id: string): string {
  tracked[kind].add(id);
  return id;
}

export async function createWorkflowFixture(
  input: {
    workflowStatus?: typeof workflowRuns.$inferInsert.status;
    taskStatus?: typeof tasks.$inferInsert.status;
    withTask?: boolean;
  } = {},
) {
  const suffix = randomUUID();
  const [user] = await databaseResource.db
    .insert(users)
    .values({
      email: `s05-${suffix}@example.com`,
      displayName: 'S05 integration user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create S05 integration user');
  track('users', user.id);

  const [workflow] = await databaseResource.db
    .insert(workflowRuns)
    .values({
      userId: user.id,
      triggerMode: 'chat',
      status: input.workflowStatus ?? 'queued',
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
    })
    .returning();
  if (!workflow) throw new Error('Failed to create S05 integration workflow');
  track('workflows', workflow.id);

  if (input.withTask === false) return { user, workflow, task: null };
  const [task] = await databaseResource.db
    .insert(tasks)
    .values({
      workflowRunId: workflow.id,
      type: 'test.echo',
      status: input.taskStatus ?? 'queued',
      costEstimate: '0.00',
      idempotencyKey: `s05-task-${suffix}`,
      dagNodeId: 'test-node',
      dagJson: {},
      paramsSnapshot: {},
    })
    .returning();
  if (!task) throw new Error('Failed to create S05 integration task');
  track('tasks', task.id);
  return { user, workflow, task };
}

async function deleteTracked<
  T extends { size: number; clear(): void; values(): IterableIterator<string> },
>(ids: T, remove: (values: string[]) => Promise<unknown>): Promise<void> {
  if (ids.size === 0) return;
  await remove([...ids.values()]);
  ids.clear();
}

export async function cleanupRedisPrefix(): Promise<void> {
  if (redis.status === 'wait') await redis.connect();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${testRedisPrefix}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
}

export async function cleanupTrackedResources(): Promise<void> {
  await cleanupRedisPrefix();
  const workflowIds = [...tracked.workflows];
  const quoteIds = [...tracked.quotes];
  const reservationIds = [...tracked.reservations];
  const aggregateIds = [
    ...tracked.workflows,
    ...tracked.tasks,
    ...tracked.attempts,
    ...tracked.callbacks,
  ];
  if (workflowIds.length > 0) {
    await databaseResource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, workflowIds));
  }
  if (aggregateIds.length > 0) {
    await databaseResource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, aggregateIds));
  }
  await deleteTracked(tracked.events, (ids) =>
    databaseResource.db.delete(eventOutbox).where(inArray(eventOutbox.id, ids)),
  );
  await deleteTracked(tracked.intents, (ids) =>
    databaseResource.db.delete(queueDispatchIntents).where(inArray(queueDispatchIntents.id, ids)),
  );
  await deleteTracked(tracked.callbacks, (ids) =>
    databaseResource.db
      .delete(providerCallbackEvents)
      .where(inArray(providerCallbackEvents.id, ids)),
  );
  await deleteTracked(tracked.circuits, (ids) =>
    databaseResource.db.delete(providerCircuitStates).where(inArray(providerCircuitStates.id, ids)),
  );
  await deleteTracked(tracked.attempts, (ids) =>
    databaseResource.db.delete(taskAttempts).where(inArray(taskAttempts.id, ids)),
  );
  await deleteTracked(tracked.tasks, (ids) =>
    databaseResource.db.delete(tasks).where(inArray(tasks.id, ids)),
  );
  await deleteTracked(tracked.models, (ids) =>
    databaseResource.db.delete(models).where(inArray(models.id, ids)),
  );
  if (quoteIds.length > 0) {
    await databaseResource.db
      .update(runQuotes)
      .set({ workflowRunId: null })
      .where(inArray(runQuotes.id, quoteIds));
  }
  if (reservationIds.length > 0) {
    await databaseResource.db
      .update(creditReservations)
      .set({ workflowRunId: null })
      .where(inArray(creditReservations.id, reservationIds));
  }
  await deleteTracked(tracked.workflows, (ids) =>
    databaseResource.db.delete(workflowRuns).where(inArray(workflowRuns.id, ids)),
  );
  if (reservationIds.length > 0) {
    await databaseResource.db
      .delete(creditReservations)
      .where(inArray(creditReservations.id, reservationIds));
  }
  tracked.reservations.clear();
  if (quoteIds.length > 0) {
    await databaseResource.db.delete(runQuotes).where(inArray(runQuotes.id, quoteIds));
  }
  tracked.quotes.clear();
  await deleteTracked(tracked.heartbeats, (ids) =>
    databaseResource.db.delete(workerHeartbeats).where(inArray(workerHeartbeats.id, ids)),
  );
  await deleteTracked(tracked.users, (ids) =>
    databaseResource.db.delete(users).where(inArray(users.id, ids)),
  );
}

export async function closeIntegrationInfrastructure(): Promise<void> {
  if (redis.status !== 'end') await redis.quit().catch(() => redis.disconnect());
  await databaseResource.client.end();
}
