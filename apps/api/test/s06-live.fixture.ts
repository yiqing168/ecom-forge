import { stdin } from 'node:process';

import {
  and,
  createDatabaseClient,
  eq,
  eventOutbox,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import { encodeEventWake, eventWakeChannel } from '@ecom-forge/shared';
import { createClient } from 'redis';

import { loadAppConfig } from '../src/config/app-config.js';
import { appendOutboxEventInTransaction } from '../src/shared/database/outbox.repository.js';

const EMAIL_PATTERN = /^s06-live-[0-9a-f-]{36}@example\.com$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readInput(): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    if (typeof chunk !== 'string') throw new Error('Expected UTF-8 fixture input');
    chunks.push(chunk);
  }
  const serialized = chunks.join('').trim();
  return serialized ? (JSON.parse(serialized) as Record<string, unknown>) : {};
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

async function publishWake(
  redisUrl: string,
  redisPrefix: string,
  workflowRunId: string,
  eventSeq: number,
): Promise<void> {
  const client = createClient({ url: redisUrl });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.publish(
      eventWakeChannel(redisPrefix),
      encodeEventWake({
        schema_version: 1,
        scope_type: 'workflow_run',
        scope_id: workflowRunId,
        event_seq: eventSeq,
      }),
    );
  } finally {
    if (client.isOpen) await client.close();
  }
}

async function run(): Promise<void> {
  if (process.env.S06_LIVE_E2E !== '1') {
    throw new Error('This fixture is restricted to the S06 live E2E harness');
  }
  const action = process.argv[2];
  if (!action || process.argv.length > 3 || !['create', 'advance', 'cleanup'].includes(action)) {
    throw new Error('Expected exactly one action: create, advance, or cleanup');
  }

  const input = await readInput();
  const email = requiredString(input, 'email');
  if (!EMAIL_PATTERN.test(email)) throw new Error('Fixture email is outside the S06 namespace');

  const config = loadAppConfig();
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) throw new Error('S06 live E2E requires DATABASE_URL');
  const parsedDatabaseUrl = new URL(databaseUrl);
  const databaseHostname = parsedDatabaseUrl.hostname.replace(/^\[|\]$/g, '');
  const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '').toLowerCase();
  const redisHostname = new URL(config.redisUrl).hostname.replace(/^\[|\]$/g, '');
  if (
    config.appEnv !== 'local' ||
    !/_test(?:_|$)/.test(databaseName) ||
    !['127.0.0.1', '::1', 'localhost'].includes(databaseHostname) ||
    !['127.0.0.1', '::1', 'localhost'].includes(redisHostname)
  ) {
    throw new Error('S06 live E2E fixtures require loopback database and Redis endpoints');
  }

  const resource = createDatabaseClient({ databaseUrl });
  try {
    const user = await resource.db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) throw new Error('S06 fixture user does not exist');

    if (action === 'create') {
      const created = await resource.db.transaction(async (transaction) => {
        const [workflow] = await transaction
          .insert(workflowRuns)
          .values({
            userId: user.id,
            triggerMode: 'chat',
            status: 'queued',
            planSnapshot: {},
            skillSnapshot: {},
            pricingSnapshot: {},
          })
          .returning();
        if (!workflow) throw new Error('Workflow fixture insert returned no row');
        const [task] = await transaction
          .insert(tasks)
          .values({
            workflowRunId: workflow.id,
            type: 'image.generate',
            status: 'queued',
            costEstimate: '0.00',
            idempotencyKey: `s06-live:${workflow.id}`,
            dagNodeId: 's06-live-node',
            dagJson: {},
            paramsSnapshot: {},
          })
          .returning();
        if (!task) throw new Error('Task fixture insert returned no row');
        const event = await appendOutboxEventInTransaction(transaction, {
          scopeType: 'workflow_run',
          scopeId: workflow.id,
          eventType: 'workflow.created',
          payload: { workflow_run_id: workflow.id, status: 'queued' },
          retentionTier: 'critical',
        });
        return { workflowRunId: workflow.id, taskId: task.id, eventSeq: event.eventSeq };
      });
      await publishWake(
        config.redisUrl,
        config.redisPrefix,
        created.workflowRunId,
        created.eventSeq,
      );
      process.stdout.write(`${JSON.stringify(created)}\n`);
      return;
    }

    const workflowRunId = requiredString(input, 'workflowRunId');
    const taskId = requiredString(input, 'taskId');
    if (!UUID_PATTERN.test(workflowRunId) || !UUID_PATTERN.test(taskId)) {
      throw new Error('Fixture workflow and task IDs must be UUIDs');
    }
    const workflow = await resource.db.query.workflowRuns.findFirst({
      where: and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.userId, user.id)),
    });
    const task = await resource.db.query.tasks.findFirst({
      where: and(eq(tasks.id, taskId), eq(tasks.workflowRunId, workflowRunId)),
    });
    if (!workflow || !task) throw new Error('S06 fixture resources do not belong to the user');

    if (action === 'cleanup') {
      await resource.db.transaction(async (transaction) => {
        await transaction.delete(eventOutbox).where(eq(eventOutbox.scopeId, workflowRunId));
        await transaction.delete(tasks).where(eq(tasks.id, taskId));
        await transaction.delete(workflowRuns).where(eq(workflowRuns.id, workflowRunId));
      });
      process.stdout.write(`${JSON.stringify({ status: 'cleaned' })}\n`);
      return;
    }

    const target = requiredString(input, 'target');
    if (!['running', 'succeeded'].includes(target)) throw new Error('Unsupported target status');
    const targetStatus = target as 'running' | 'succeeded';
    const expected = targetStatus === 'running' ? 'queued' : 'running';
    if (workflow.status !== expected || task.status !== expected) {
      throw new Error(`Fixture transition expected ${expected} state`);
    }
    const now = new Date();
    const eventSeq = await resource.db.transaction(async (transaction) => {
      const [updatedTask] = await transaction
        .update(tasks)
        .set({
          status: targetStatus,
          startedAt: targetStatus === 'running' ? now : task.startedAt,
          endedAt: targetStatus === 'succeeded' ? now : null,
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.status, expected)))
        .returning({ id: tasks.id });
      const [updatedWorkflow] = await transaction
        .update(workflowRuns)
        .set({ status: targetStatus, finishedAt: targetStatus === 'succeeded' ? now : null })
        .where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, expected)))
        .returning({ id: workflowRuns.id });
      if (!updatedTask || !updatedWorkflow) throw new Error('Fixture transition lost its CAS');
      await appendOutboxEventInTransaction(transaction, {
        scopeType: 'workflow_run',
        scopeId: workflowRunId,
        eventType: 'task.status_changed',
        payload: { task_id: taskId, from: expected, to: targetStatus },
      });
      const event = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'workflow_run',
        scopeId: workflowRunId,
        eventType: 'workflow.status_changed',
        payload: { from: expected, to: targetStatus },
      });
      return event.eventSeq;
    });
    await publishWake(config.redisUrl, config.redisPrefix, workflowRunId, eventSeq);
    process.stdout.write(`${JSON.stringify({ eventSeq })}\n`);
  } finally {
    await resource.client.end();
  }
}

await run();
