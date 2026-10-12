import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createDatabaseClient, eventOutbox, inArray, users, workflowRuns } from '@ecom-forge/db';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config/app-config.js';
import { AuthenticationService } from '../src/modules/auth/authentication.service.js';
import { EventOutboxRepository } from '../src/modules/events/event-outbox.repository.js';
import { EventsController } from '../src/modules/events/events.controller.js';
import { EventWakeHub } from '../src/modules/events/event-wake.hub.js';
import { SseStreamService } from '../src/modules/events/sse-stream.service.js';
import type { RedisPubSubClient } from '../src/shared/redis/redis.module.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/1';
const testRunId = randomUUID();
const redisPrefix = `s06-test-${testRunId}`;

function assertIsolatedInfrastructure(): void {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
  if (!/_test(?:_|$)/.test(databaseName)) {
    throw new Error('S06 integration tests require a database name containing _test');
  }
  if (!redisPrefix.startsWith('s06-test-')) {
    throw new Error('S06 integration tests require a unique Redis prefix');
  }
}

assertIsolatedInfrastructure();

class TestRedisPubSub implements RedisPubSubClient {
  private readonly command: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly subscribed: Promise<void>;
  private resolveSubscribed: (() => void) | undefined;

  constructor() {
    this.command = createClient({ url: redisUrl });
    this.subscriber = this.command.duplicate();
    this.subscribed = new Promise((resolve) => {
      this.resolveSubscribed = resolve;
    });
    this.command.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
  }

  async publish(channel: string, message: string): Promise<number> {
    await this.ensureCommand();
    return this.command.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    if (!this.subscriber.isReady) await this.subscriber.connect();
    await this.subscriber.subscribe(channel, listener);
    this.resolveSubscribed?.();
  }

  waitUntilSubscribed(): Promise<void> {
    return this.subscribed;
  }

  async unsubscribe(channel: string): Promise<void> {
    if (this.subscriber.isOpen) await this.subscriber.unsubscribe(channel);
  }

  async close(): Promise<void> {
    if (this.subscriber.isOpen) await this.subscriber.close();
    if (this.command.isOpen) await this.command.close();
  }

  private async ensureCommand(): Promise<void> {
    if (!this.command.isReady) await this.command.connect();
  }
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 10 });
const trackedUsers = new Set<string>();
const trackedWorkflows = new Set<string>();
const redisOne = new TestRedisPubSub();
const redisTwo = new TestRedisPubSub();
const hubOne = new EventWakeHub(redisOne, { redisPrefix } as AppConfig);
const hubTwo = new EventWakeHub(redisTwo, { redisPrefix } as AppConfig);
const outbox = new EventOutboxRepository(resource.db);
const streamService = new SseStreamService(outbox, hubOne, {
  heartbeatIntervalMs: 50,
  watchdogTimeoutMs: 150,
  replayBatchSize: 2,
  backpressureTimeoutMs: 500,
  maxConnections: 20,
  maxConnectionsPerUser: 3,
});
let app: INestApplication;
let origin: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [EventsController],
    providers: [
      { provide: SseStreamService, useValue: streamService },
      {
        provide: AuthenticationService,
        useValue: {
          currentSession(headers: Headers) {
            const userId = headers.get('x-s06-test-user');
            return Promise.resolve(
              userId
                ? {
                    user: { id: userId },
                    headers: new Headers(),
                    access: {
                      canCreate: true,
                      canUpload: true,
                      canCharge: true,
                      restrictionReason: null,
                    },
                  }
                : null,
            );
          },
        },
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  const httpServer = app.getHttpServer() as { address(): { port: number } };
  const address = httpServer.address();
  origin = `http://127.0.0.1:${address.port}`;
});

async function createUser() {
  const [user] = await resource.db
    .insert(users)
    .values({
      email: `s06-${testRunId}-${randomUUID()}@example.com`,
      displayName: 'S06 test user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create S06 user fixture');
  trackedUsers.add(user.id);
  return user;
}

async function createWorkflow(userId: string) {
  const [workflow] = await resource.db
    .insert(workflowRuns)
    .values({
      userId,
      triggerMode: 'chat',
      status: 'queued',
      planSnapshot: {},
      skillSnapshot: {},
      pricingSnapshot: {},
    })
    .returning();
  if (!workflow) throw new Error('Failed to create S06 workflow fixture');
  trackedWorkflows.add(workflow.id);
  return workflow;
}

async function insertWorkflowEvent(workflowRunId: string, eventSeq: number, to: string) {
  await resource.db.insert(eventOutbox).values({
    scopeType: 'workflow_run',
    scopeId: workflowRunId,
    eventSeq,
    eventType: 'workflow.status_changed',
    payload: { from: eventSeq === 1 ? 'reserved' : 'queued', to },
    retentionTier: 'critical',
  });
}

async function openFrames(input: {
  workflowRunId: string;
  userId?: string;
  lastEventSeq?: number;
  frameCount: number;
  onFrame?: (frame: string) => void;
}) {
  const controller = new AbortController();
  const response = await fetch(
    `${origin}/api/v1/events?scope=workflow_run:${input.workflowRunId}&last_event_seq=${input.lastEventSeq ?? 0}`,
    {
      headers: input.userId ? { 'x-s06-test-user': input.userId } : {},
      signal: controller.signal,
    },
  );
  if (!response.ok || !response.body) return { response, frames: [] as string[] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';
  try {
    while (frames.length < input.frameCount) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        frames.push(frame);
        input.onFrame?.(frame);
        buffer = buffer.slice(boundary + 2);
        if (frames.length >= input.frameCount) break;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }
  return { response, frames };
}

afterEach(async () => {
  if (trackedWorkflows.size > 0) {
    await resource.db
      .delete(eventOutbox)
      .where(inArray(eventOutbox.scopeId, [...trackedWorkflows]));
    await resource.db.delete(workflowRuns).where(inArray(workflowRuns.id, [...trackedWorkflows]));
    trackedWorkflows.clear();
  }
  if (trackedUsers.size > 0) {
    await resource.db.delete(users).where(inArray(users.id, [...trackedUsers]));
    trackedUsers.clear();
  }
});

afterAll(async () => {
  await app.close();
  await hubOne.onApplicationShutdown();
  await hubTwo.onApplicationShutdown();
  await redisOne.close();
  await redisTwo.close();
  await resource.client.end();
});

describe('S06 SSE integration', () => {
  it('replays in order and rejects unauthenticated, foreign, and future cursors before streaming', async () => {
    const owner = await createUser();
    const other = await createUser();
    const workflow = await createWorkflow(owner.id);
    await insertWorkflowEvent(workflow.id, 1, 'queued');
    await insertWorkflowEvent(workflow.id, 2, 'running');

    const replay = await openFrames({
      workflowRunId: workflow.id,
      userId: owner.id,
      frameCount: 2,
    });
    expect(replay.response.headers.get('content-type')).toContain('text/event-stream');
    expect(replay.response.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(replay.frames.map((frame) => frame.match(/^id: (\d+)/m)?.[1])).toEqual(['1', '2']);

    expect((await fetch(`${origin}/api/v1/events?scope=workflow_run:${workflow.id}`)).status).toBe(
      401,
    );
    expect((await fetch(`${origin}/api/v1/events?scope=invalid`)).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/v1/events?scope=invalid`, {
          headers: { 'x-s06-test-user': owner.id },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${origin}/api/v1/events?scope=workflow_run:${workflow.id}`, {
          headers: { 'x-s06-test-user': other.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${origin}/api/v1/events?scope=workflow_run:${workflow.id}&last_event_seq=3`, {
          headers: { 'x-s06-test-user': owner.id },
        })
      ).status,
    ).toBe(400);
  });

  it('recovers a committed event without a wake-up on the next heartbeat drain', async () => {
    const owner = await createUser();
    const workflow = await createWorkflow(owner.id);
    await insertWorkflowEvent(workflow.id, 1, 'queued');

    let resolveConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const pendingFrames = openFrames({
      workflowRunId: workflow.id,
      userId: owner.id,
      lastEventSeq: 1,
      frameCount: 3,
      onFrame: (frame) => {
        if (frame.includes('event: heartbeat')) resolveConnected?.();
      },
    });
    await connected;
    await insertWorkflowEvent(workflow.id, 2, 'running');
    const result = await pendingFrames;

    expect(result.frames.some((frame) => frame.includes('event: heartbeat'))).toBe(true);
    expect(result.frames.some((frame) => frame.includes('id: 2'))).toBe(true);
  });

  it('fans a routing-only wake-up across two API instance hubs', async () => {
    const workflowRunId = randomUUID();
    let resolveReceived: ((eventSeq: number) => void) | undefined;
    const received = new Promise<number>((resolve) => {
      resolveReceived = resolve;
    });
    await hubTwo.listen(workflowRunId, (wake) => resolveReceived?.(wake.event_seq));
    await redisTwo.waitUntilSubscribed();
    await hubOne.publish({
      schema_version: 1,
      scope_type: 'workflow_run',
      scope_id: workflowRunId,
      event_seq: 7,
    });
    await expect(received).resolves.toBe(7);
  });
});
