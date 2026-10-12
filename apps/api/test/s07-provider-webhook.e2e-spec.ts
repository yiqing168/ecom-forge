import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { z } from 'zod';

import {
  eq,
  inArray,
  providerCallbackEvents,
  queueDispatchIntents,
  type Database,
} from '@ecom-forge/db';

import { AppModule } from '../src/app.module.js';
import { configureBodyParsers } from '../src/configure-body-parsers.js';
import { DATABASE } from '../src/shared/database/database.module.js';

const webhookSecret = Buffer.alloc(32, 9);

describe('S07 Provider webhook', () => {
  let app: INestApplication;
  let database: Database;
  const eventIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const expressApp = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
    });
    configureBodyParsers(expressApp, 65_536, 20 * 1024 * 1024);
    app = expressApp;
    database = moduleRef.get<Database>(DATABASE);
    await app.init();
  });

  afterEach(async () => {
    if (eventIds.length === 0) return;
    await database
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, eventIds));
    await database
      .delete(providerCallbackEvents)
      .where(inArray(providerCallbackEvents.id, eventIds));
    eventIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1_000).toString()) {
    return {
      'x-provider-key-id': 'fake-webhook-v1',
      'x-provider-timestamp': timestamp,
      'x-provider-signature': createHmac('sha256', webhookSecret)
        .update(timestamp)
        .update('.')
        .update(body)
        .digest('base64url'),
    };
  }

  it('persists one callback event and one intent for duplicate signed deliveries', async () => {
    const server = app.getHttpServer() as Server;
    const providerEventId = `event-${randomUUID()}`;
    const invalidRequestId = '11111111-1111-1111-1111-111111111111';
    const body = JSON.stringify({
      event_id: providerEventId,
      request_id: `request-${randomUUID()}`,
      status: 'failed',
      failed_at: new Date().toISOString(),
      error_code: 'provider_content_rejected',
    });

    for (let index = 0; index < 2; index += 1) {
      await request(server)
        .post('/api/v1/webhooks/providers/fake')
        .set({ ...signedHeaders(body), 'x-request-id': invalidRequestId })
        .set('content-type', 'application/json')
        .send(body)
        .expect('cache-control', 'no-store')
        .expect(202, { accepted: true });
    }

    const events = await database.query.providerCallbackEvents.findMany({
      where: eq(providerCallbackEvents.providerEventIdHint, providerEventId.slice(-16)),
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    eventIds.push(event.id);
    const intents = await database.query.queueDispatchIntents.findMany({
      where: eq(queueDispatchIntents.aggregateId, event.id),
    });
    expect(intents).toHaveLength(1);
    const queuedTrace = z.object({ trace_id: z.uuid() }).parse(intents[0]?.payload).trace_id;
    expect(queuedTrace).not.toBe(invalidRequestId);
    expect(intents[0]?.payload).toMatchObject({
      job_type: 'provider.callback.process',
      provider_callback_event_id: event.id,
      processing_no: 1,
    });
    expect(event.rawSummaryJson).toEqual({ schema_version: 1 });
  });

  it('rejects unknown providers, invalid signatures, and stale requests without persistence', async () => {
    const server = app.getHttpServer() as Server;
    const body = JSON.stringify({ status: 'not-a-valid-callback' });
    await request(server)
      .post('/api/v1/webhooks/providers/unknown')
      .set('content-type', 'application/json')
      .send(body)
      .expect('cache-control', 'no-store')
      .expect(404);
    await request(server)
      .post('/api/v1/webhooks/providers/fake')
      .set({ ...signedHeaders(body), 'x-provider-signature': 'invalid' })
      .set('content-type', 'application/json')
      .send(body)
      .expect('cache-control', 'no-store')
      .expect(401);
    await request(server)
      .post('/api/v1/webhooks/providers/fake')
      .set(signedHeaders(body, '1700000000'))
      .set('content-type', 'application/json')
      .send(body)
      .expect('cache-control', 'no-store')
      .expect(401);

    const eventId = `invalid-${randomUUID()}`;
    const invalidPayload = JSON.stringify({
      event_id: eventId,
      request_id: `request-${randomUUID()}`,
      status: 'unsupported',
    });
    await request(server)
      .post('/api/v1/webhooks/providers/fake')
      .set(signedHeaders(invalidPayload))
      .set('content-type', 'application/json')
      .send(invalidPayload)
      .expect('cache-control', 'no-store')
      .expect(400);
    await expect(
      database.query.providerCallbackEvents.findMany({
        where: eq(providerCallbackEvents.providerEventIdHint, eventId.slice(-16)),
      }),
    ).resolves.toHaveLength(0);
  });

  it('rejects an oversized raw body before webhook handling', async () => {
    const server = app.getHttpServer() as Server;
    const body = JSON.stringify({ padding: 'x'.repeat(70_000) });
    const response = await request(server)
      .post('/api/v1/webhooks/providers/fake')
      .set(signedHeaders(body))
      .set('content-type', 'application/json')
      .send(body)
      .expect('cache-control', 'no-store')
      .expect(413);
    expect(response.body).toEqual({
      error: { code: 'PROVIDER_WEBHOOK_INVALID', message: 'Webhook request rejected' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/stack|entity\.too\.large|request entity/i);
  });
});
