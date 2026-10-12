import { stdin } from 'node:process';

import {
  assets,
  assetUploadIntents,
  createDatabaseClient,
  eq,
  inArray,
  productFactSets,
  products,
  queueDispatchIntents,
  resourceWriteRequests,
  users,
  workerHeartbeats,
} from '@ecom-forge/db';

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) {
    if (typeof chunk !== 'string') throw new Error('Expected UTF-8 fixture input');
    chunks.push(chunk);
  }
  return chunks.join('');
}

async function run(): Promise<void> {
  if (process.env.S10_LIVE_E2E !== '1') {
    throw new Error('This fixture is restricted to the S10 live E2E harness');
  }
  const action = process.argv[2];
  if (!action || !['cleanup', 'cleanup-worker'].includes(action) || process.argv.length > 3) {
    throw new Error('Expected exactly one action: cleanup or cleanup-worker');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('S10 live E2E cleanup requires a loopback database');
  }
  if (!/_test(?:_|$)/.test(url.pathname.replace(/^\//, '').toLowerCase())) {
    throw new Error('S10 live E2E cleanup requires a _test database');
  }
  const input = JSON.parse(await readStdin()) as { email?: unknown; workerId?: unknown };
  if (input.workerId !== undefined && typeof input.workerId !== 'string') {
    throw new Error('Cleanup worker ID must be a string');
  }
  if (
    action === 'cleanup' &&
    (typeof input.email !== 'string' || !/^s10-live-[0-9a-f-]{36}@example\.com$/.test(input.email))
  ) {
    throw new Error('Cleanup email is outside the S10 live E2E namespace');
  }
  if (action === 'cleanup-worker' && typeof input.workerId !== 'string') {
    throw new Error('cleanup-worker requires workerId');
  }

  const resource = createDatabaseClient({ databaseUrl });
  try {
    const user =
      typeof input.email === 'string'
        ? await resource.db.query.users.findFirst({ where: eq(users.email, input.email) })
        : undefined;
    if (user) {
      const userAssets = await resource.db
        .select({ id: assets.id })
        .from(assets)
        .where(eq(assets.userId, user.id));
      const assetIds = userAssets.map((asset) => asset.id);
      await resource.db
        .update(products)
        .set({ latestFactSetId: null, primaryAssetId: null })
        .where(eq(products.userId, user.id));
      await resource.db.delete(productFactSets).where(eq(productFactSets.userId, user.id));
      if (assetIds.length > 0) {
        await resource.db
          .delete(queueDispatchIntents)
          .where(inArray(queueDispatchIntents.aggregateId, assetIds));
        await resource.db
          .delete(assetUploadIntents)
          .where(inArray(assetUploadIntents.assetId, assetIds));
      }
      await resource.db.delete(assets).where(eq(assets.userId, user.id));
      await resource.db.delete(products).where(eq(products.userId, user.id));
      await resource.db
        .delete(resourceWriteRequests)
        .where(eq(resourceWriteRequests.userId, user.id));
    }
    if (typeof input.workerId === 'string') {
      await resource.db.delete(workerHeartbeats).where(eq(workerHeartbeats.id, input.workerId));
    }
    process.stdout.write(`${JSON.stringify({ status: 'cleaned' })}\n`);
  } finally {
    await resource.client.end();
  }
}

await run();
