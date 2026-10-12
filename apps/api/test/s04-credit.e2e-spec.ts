import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  and,
  creditAccounts,
  creditLedger,
  creditReservations,
  createDatabaseClient,
  eq,
  eventOutbox,
  inArray,
  queueDispatchIntents,
  runQuotes,
  tasks,
  users,
  workflowRuns,
} from '@ecom-forge/db';
import { CreditProjectionDriftError, type CreditError } from '@ecom-forge/credit';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { AuthenticationService } from '../src/modules/auth/authentication.service.js';
import { CreditController } from '../src/modules/credit/credit.controller.js';
import { CreditService } from '../src/modules/credit/credit.service.js';
import { LocalQuoteProducer } from '../src/modules/credit/quote-producer.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';

function assertIsolatedDatabase(): void {
  const testUrl = new URL(databaseUrl);
  const databaseName = testUrl.pathname.replace(/^\//, '').toLowerCase();
  if (!/_test(?:_|$)/.test(databaseName)) {
    throw new Error('S04 integration tests require a database name containing _test');
  }
}

assertIsolatedDatabase();

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const service = new CreditService(resource.db, 's04-test-cursor-secret', new LocalQuoteProducer());
const trackedUsers = new Set<string>();
let app: INestApplication;
let sessionUserId: string | null = null;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [CreditController],
    providers: [
      { provide: CreditService, useValue: service },
      {
        provide: AuthenticationService,
        useValue: {
          currentSession: () =>
            sessionUserId
              ? Promise.resolve({
                  user: { id: sessionUserId },
                  headers: new Headers(),
                  access: {
                    canCreate: true,
                    canUpload: true,
                    canCharge: true,
                    restrictionReason: null,
                  },
                })
              : Promise.resolve(null),
        },
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

async function createUser(balance = '10.00') {
  const id = randomUUID();
  const [user] = await resource.db
    .insert(users)
    .values({
      id,
      email: `s04-${id}@example.test`,
      displayName: 'S04 integration user',
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Failed to create S04 test user');
  trackedUsers.add(user.id);
  if (balance !== '0.00') {
    await resource.db.insert(creditAccounts).values({
      userId: user.id,
      balance,
      frozen: '0.00',
      version: 1,
    });
    await resource.db.insert(creditLedger).values({
      userId: user.id,
      type: 'grant',
      amount: balance,
      idempotencyKey: `s04-test-grant:${user.id}`,
      accountVersion: 1,
      balanceAfter: balance,
      frozenAfter: '0.00',
      metadata: { test_run_id: user.id },
    });
  }
  return user;
}

function quoteInput(targetId = randomUUID()) {
  return { source: 'chat' as const, targetIds: [targetId] };
}

async function cleanupUser(userId: string): Promise<void> {
  const userWorkflows = await resource.db.query.workflowRuns.findMany({
    where: eq(workflowRuns.userId, userId),
    columns: { id: true },
  });
  const workflowIds = userWorkflows.map((item) => item.id);
  const userTasks =
    workflowIds.length > 0
      ? await resource.db.query.tasks.findMany({
          where: inArray(tasks.workflowRunId, workflowIds),
          columns: { id: true },
        })
      : [];
  const taskIds = userTasks.map((item) => item.id);
  const aggregateIds = [...workflowIds, ...taskIds];

  if (workflowIds.length > 0) {
    await resource.db.delete(eventOutbox).where(inArray(eventOutbox.scopeId, workflowIds));
  }
  if (aggregateIds.length > 0) {
    await resource.db
      .delete(queueDispatchIntents)
      .where(inArray(queueDispatchIntents.aggregateId, aggregateIds));
  }
  await resource.db.delete(creditLedger).where(eq(creditLedger.userId, userId));
  if (taskIds.length > 0) await resource.db.delete(tasks).where(inArray(tasks.id, taskIds));
  await resource.db
    .update(runQuotes)
    .set({ workflowRunId: null })
    .where(eq(runQuotes.userId, userId));
  await resource.db
    .update(creditReservations)
    .set({ workflowRunId: null })
    .where(eq(creditReservations.userId, userId));
  if (workflowIds.length > 0) {
    await resource.db.delete(workflowRuns).where(inArray(workflowRuns.id, workflowIds));
  }
  await resource.db.delete(creditReservations).where(eq(creditReservations.userId, userId));
  await resource.db.delete(runQuotes).where(eq(runQuotes.userId, userId));
  await resource.db.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
  await resource.db.delete(users).where(eq(users.id, userId));
}

afterEach(async () => {
  sessionUserId = null;
  for (const userId of trackedUsers) await cleanupUser(userId);
  trackedUsers.clear();
});

afterAll(async () => {
  await app.close();
  await resource.client.end();
});

describe('S04 credit transaction integration', () => {
  it('exposes the authenticated quote, submit, account, and ledger HTTP contract', async () => {
    const user = await createUser();
    sessionUserId = user.id;
    const server = app.getHttpServer() as Server;
    const quote = await request(server)
      .post('/api/v1/run-quotes')
      .set('Idempotency-Key', `s04-http-quote-${user.id}`)
      .send({ source: 'chat', target_ids: [randomUUID()] })
      .expect(201)
      .expect('Cache-Control', 'no-store');
    const quoteBody = quote.body as {
      id: string;
      estimated_total_credits: string;
      items: unknown[];
    };
    expect(quoteBody.estimated_total_credits).toBe('1.00');
    expect(quoteBody.items).toHaveLength(1);
    const storedQuote = await resource.db.query.runQuotes.findFirst({
      where: eq(runQuotes.id, quoteBody.id),
    });
    expect(storedQuote?.promptPreview).toEqual({ source: 'chat', target_count: 1 });
    expect(storedQuote?.itemsSnapshot).toEqual([
      {
        task_key: 'task-1',
        task_type: 'image.generate',
        estimated_credits: '1.00',
      },
    ]);

    await request(server)
      .post(`/api/v1/run-quotes/${quoteBody.id}/submit`)
      .set('Idempotency-Key', `s04-http-submit-${user.id}`)
      .send({
        confirmation_snapshot: { estimated_total_credits: '1.00', currency: 'credits' },
        cost_confirmation: 'required',
      })
      .expect(201)
      .expect('Cache-Control', 'no-store');
    const account = await request(server)
      .get('/api/v1/credits/account')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(account.body).toMatchObject({ balance: '9.00', frozen: '1.00' });
    const ledger = await request(server)
      .get('/api/v1/credits/ledger?limit=20')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect((ledger.body as { items: unknown[] }).items).toHaveLength(2);
  });

  it('returns stable public errors for unauthenticated and invalid HTTP requests', async () => {
    const server = app.getHttpServer() as Server;
    const unauthorized = await request(server).get('/api/v1/credits/account').expect(401);
    expect(unauthorized.body).toMatchObject({ error: { code: 'AUTH_SESSION_REQUIRED' } });

    const user = await createUser();
    sessionUserId = user.id;
    const invalid = await request(server)
      .post('/api/v1/run-quotes')
      .set('Idempotency-Key', `s04-http-invalid-${user.id}`)
      .send({ source: 'canvas', target_ids: [] })
      .expect(400);
    expect(invalid.body).toMatchObject({ error: { code: 'REQUEST_INVALID' } });
  });

  it('deduplicates concurrent active quotes through the database constraint', async () => {
    const user = await createUser();
    const input = quoteInput();

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.createQuote(user.id, input, `s04-quote-${user.id}-${index}`),
      ),
    );

    expect(new Set(responses.map((response) => response.id)).size).toBe(1);
    const stored = await resource.db.query.runQuotes.findMany({
      where: eq(runQuotes.userId, user.id),
    });
    expect(stored).toHaveLength(1);
  });

  it('submits a quote concurrently exactly once without partial financial state', async () => {
    const user = await createUser();
    const quote = await service.createQuote(user.id, quoteInput(), `s04-quote-${user.id}`);

    const submissions = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.submitQuote(user.id, quote.id, '1.00', 'required', `s04-submit-${user.id}`),
      ),
    );

    expect(new Set(submissions.map((response) => response.workflow_run_id)).size).toBe(1);
    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, user.id),
      }),
    ).toHaveLength(1);
    expect(
      await resource.db.query.workflowRuns.findMany({
        where: eq(workflowRuns.userId, user.id),
      }),
    ).toHaveLength(1);
    const ledger = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, user.id),
    });
    expect(ledger.filter((entry) => entry.type === 'reservation_freeze')).toHaveLength(1);
    const account = await resource.db.query.creditAccounts.findFirst({
      where: eq(creditAccounts.userId, user.id),
    });
    expect(account).toMatchObject({ balance: '9.00', frozen: '1.00' });
    const workflowEvents = await resource.db.query.eventOutbox.findMany({
      where: and(
        eq(eventOutbox.scopeId, submissions[0]!.workflow_run_id),
        eq(eventOutbox.eventType, 'workflow.created'),
      ),
    });
    expect(workflowEvents).toHaveLength(1);
    expect(workflowEvents[0]?.payload).toMatchObject({ status: 'queued' });
  });

  it('creates one stable task intent for every task in the first executable stage', async () => {
    const user = await createUser();
    const quote = await service.createQuote(
      user.id,
      { source: 'chat', targetIds: [randomUUID(), randomUUID()] },
      `s04-multi-quote-${user.id}`,
    );

    const submitted = await service.submitQuote(
      user.id,
      quote.id,
      '2.00',
      'required',
      `s04-multi-submit-${user.id}`,
    );

    const createdTasks = await resource.db.query.tasks.findMany({
      where: eq(tasks.workflowRunId, submitted.workflow_run_id),
    });
    const intents = await resource.db.query.queueDispatchIntents.findMany({
      where: inArray(
        queueDispatchIntents.aggregateId,
        createdTasks.map((task) => task.id),
      ),
    });
    expect(createdTasks).toHaveLength(2);
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((intent) => intent.jobId))).toEqual(
      new Set(createdTasks.map((task) => task.id)),
    );
  });

  it('persists quote expiry and permits a fresh quote for the same input', async () => {
    const user = await createUser();
    const input = quoteInput();
    const quote = await service.createQuote(user.id, input, `s04-expired-${user.id}`);
    await resource.db
      .update(runQuotes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(runQuotes.id, quote.id));

    await expect(
      service.submitQuote(user.id, quote.id, '1.00', 'required', `s04-submit-${user.id}`),
    ).rejects.toMatchObject({ code: 'RUN_QUOTE_EXPIRED' });
    const expired = await resource.db.query.runQuotes.findFirst({
      where: eq(runQuotes.id, quote.id),
    });
    expect(expired?.status).toBe('expired');

    const fresh = await service.createQuote(user.id, input, `s04-fresh-${user.id}`);
    expect(fresh.id).not.toBe(quote.id);
    expect(fresh.status).toBe('quoted');
  });

  it('rejects reuse of one submit idempotency key across different quotes', async () => {
    const user = await createUser();
    const first = await service.createQuote(user.id, quoteInput(), `s04-first-${user.id}`);
    const second = await service.createQuote(user.id, quoteInput(), `s04-second-${user.id}`);
    const submitKey = `s04-shared-submit-${user.id}`;

    await service.submitQuote(user.id, first.id, '1.00', 'required', submitKey);
    await expect(
      service.submitQuote(user.id, second.id, '1.00', 'required', submitKey),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const storedSecond = await resource.db.query.runQuotes.findFirst({
      where: eq(runQuotes.id, second.id),
    });
    expect(storedSecond).toMatchObject({ status: 'quoted', workflowRunId: null });
  });

  it('rolls back the entire submission when credits are insufficient', async () => {
    const user = await createUser('0.00');
    const quote = await service.createQuote(user.id, quoteInput(), `s04-quote-${user.id}`);

    await expect(
      service.submitQuote(user.id, quote.id, '1.00', 'required', `s04-submit-${user.id}`),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' } satisfies Partial<CreditError>);

    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, user.id),
      }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.workflowRuns.findMany({
        where: eq(workflowRuns.userId, user.id),
      }),
    ).toHaveLength(0);
    expect(await resource.db.query.queueDispatchIntents.findMany()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ aggregateId: quote.id })]),
    );
  });

  it('keeps account and ledger queries isolated by user', async () => {
    const current = await createUser('7.00');
    const other = await createUser('13.00');

    await expect(service.account(current.id)).resolves.toMatchObject({
      balance: '7.00',
      frozen: '0.00',
      available: '7.00',
    });
    const page = await service.ledger(current.id, undefined, 20);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.amount).toBe('7.00');
    const otherPage = await service.ledger(other.id, undefined, 20);
    expect(otherPage.items).toHaveLength(1);
    expect(otherPage.items[0]?.amount).toBe('13.00');
  });

  it('replays ledger by account version and rejects projection drift', async () => {
    const user = await createUser();
    const quote = await service.createQuote(user.id, quoteInput(), `s04-replay-quote-${user.id}`);
    await service.submitQuote(
      user.id,
      quote.id,
      '1.00',
      'required',
      `s04-replay-submit-${user.id}`,
    );

    const entries = await resource.db.query.creditLedger.findMany({
      where: eq(creditLedger.userId, user.id),
    });
    expect(entries.map((entry) => entry.accountVersion).sort()).toEqual([1, 2]);
    await expect(service.account(user.id)).resolves.toMatchObject({
      balance: '9.00',
      frozen: '1.00',
    });

    await resource.db
      .update(creditAccounts)
      .set({ balance: '8.00' })
      .where(eq(creditAccounts.userId, user.id));
    await expect(service.account(user.id)).rejects.toBeInstanceOf(CreditProjectionDriftError);
  });

  it('rejects intermediate ledger drift before a submission writes funds or a workflow', async () => {
    const user = await createUser();
    await resource.db.insert(creditLedger).values([
      {
        userId: user.id,
        type: 'manual_correction',
        amount: '-2.00',
        accountVersion: 2,
        balanceAfter: '9.00',
        frozenAfter: '0.00',
        idempotencyKey: `s04-drift-middle:${user.id}`,
        metadata: { test_run_id: user.id },
      },
      {
        userId: user.id,
        type: 'grant',
        amount: '1.00',
        accountVersion: 3,
        balanceAfter: '10.00',
        frozenAfter: '0.00',
        idempotencyKey: `s04-drift-final:${user.id}`,
        metadata: { test_run_id: user.id },
      },
    ]);
    await resource.db
      .update(creditAccounts)
      .set({ version: 3 })
      .where(eq(creditAccounts.userId, user.id));
    const quote = await service.createQuote(user.id, quoteInput(), `s04-drift-quote:${user.id}`);
    await expect(
      service.submitQuote(user.id, quote.id, '1.00', 'required', `s04-drift-submit:${user.id}`),
    ).rejects.toBeInstanceOf(CreditProjectionDriftError);
    expect(
      await resource.db.query.creditReservations.findMany({
        where: eq(creditReservations.userId, user.id),
      }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.workflowRuns.findMany({ where: eq(workflowRuns.userId, user.id) }),
    ).toHaveLength(0);
    expect(
      await resource.db.query.creditLedger.findMany({ where: eq(creditLedger.userId, user.id) }),
    ).toHaveLength(3);
    expect(
      await resource.db.query.creditAccounts.findFirst({
        where: eq(creditAccounts.userId, user.id),
      }),
    ).toMatchObject({ balance: '10.00', frozen: '0.00', version: 3 });
    expect(
      await resource.db.query.runQuotes.findFirst({ where: eq(runQuotes.id, quote.id) }),
    ).toMatchObject({ status: 'quoted', workflowRunId: null });
  });

  it.each([
    ['unverified', { emailVerifiedAt: null }, 'AUTH_VERIFICATION_REQUIRED'],
    ['risk restricted', { riskStatus: 'frozen' as const }, 'FORBIDDEN'],
  ])('rejects quote creation for a %s account', async (_, update, expectedCode) => {
    const user = await createUser();
    await resource.db.update(users).set(update).where(eq(users.id, user.id));

    await expect(
      service.createQuote(user.id, quoteInput(), `s04-forbidden-${user.id}`),
    ).rejects.toMatchObject({
      code: expectedCode,
    });
    expect(
      await resource.db.query.runQuotes.findMany({
        where: eq(runQuotes.userId, user.id),
      }),
    ).toHaveLength(0);
  });
});
