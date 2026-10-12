import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseClient } from './client.js';
import { inArray } from 'drizzle-orm';
import { models } from './schema/index.js';
import { requireTestDatabaseUrl } from './test-database-env.js';

describe('Google Brain model constraint', () => {
  let connection: ReturnType<typeof createDatabaseClient>;
  const insertedIds: string[] = [];

  beforeAll(() => {
    connection = createDatabaseClient({
      databaseUrl: requireTestDatabaseUrl(),
      applicationName: 'google-model-constraint-test',
    });
  });

  afterEach(async () => {
    if (insertedIds.length) {
      await connection.db.delete(models).where(inArray(models.id, insertedIds));
      insertedIds.length = 0;
    }
  });

  afterAll(async () => connection.client.end());

  function insertModel(
    capabilityContractJson: unknown,
    protocolFamily = 'google',
    apiVariant = 'google_generate_content',
  ) {
    const id = randomUUID();
    insertedIds.push(id);
    return connection.db.insert(models).values({
      id,
      provider: 'google',
      modelId: 'gemini-constraint-test-' + id,
      version: '1',
      protocolFamily,
      apiVariant,
      capabilityContractJson,
      pricingJson: {},
      quotaJson: {},
      status: 'poc_passed',
    });
  }

  it('accepts an explicitly declared Agent Brain model', async () => {
    await expect(insertModel({ contract_kind: 'agent_brain' })).resolves.toBeDefined();
  });

  it.each([{}, { contract_kind: null }, { contract_kind: 'image' }])(
    'rejects missing, null or non-Brain capability %j',
    async (capability) => {
      await expect(insertModel(capability)).rejects.toMatchObject({ cause: { code: '23514' } });
    },
  );

  it.each([
    ['google', 'openai_images'],
    ['openai', 'google_generate_content'],
  ])('rejects a mismatched protocol pair %s / %s', async (protocol, variant) => {
    await expect(
      insertModel({ contract_kind: 'agent_brain' }, protocol, variant),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
