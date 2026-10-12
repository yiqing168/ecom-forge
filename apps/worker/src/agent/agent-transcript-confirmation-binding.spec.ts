import {
  agentConfirmationContextSchema,
  agentConfirmationDependencies,
  agentConfirmedFactDependencySchema,
  normalizeAgentProductFacts,
  prepareAgentConfirmationContext,
  prepareAgentTranscriptItem,
} from '@ecom-forge/agent';
import { createDatabaseClient, type Database } from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AgentTranscriptConfirmationBinding } from './agent-transcript-confirmation-binding.js';

const uuid = (id: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${id.toString(16).padStart(12, '0')}`;
const userId = uuid(1),
  sessionId = uuid(2),
  turnId = uuid(3),
  confirmationId = uuid(4);
const facts = {
  product_name: 'Product',
  primary_colors: ['red', 'red'],
  logos: [],
  visible_text: [],
  materials: [],
  must_preserve: [],
  unknown_fields: [],
};
const sqlResource = createDatabaseClient({
  databaseUrl: 'postgresql://fixture:fixture@127.0.0.1:1/transcript_sql_test',
});
afterAll(() => sqlResource.client.end());

function fixture(productFacts = false) {
  const publicPayloadJson = productFacts
    ? {
        schema_version: 1,
        mode: 'create_product',
        source_asset_id: uuid(5),
        source_version: 'a'.repeat(64),
        candidate_facts: facts,
        required_fields: ['product_name'],
      }
    : {
        schema_version: 1,
        question: 'Choose one',
        options: [{ id: 'soft', label: 'Soft light' }],
        allow_free_text: true,
        max_response_chars: 2000,
      };
  const confirmation = {
    id: confirmationId,
    userId,
    turnId,
    type: productFacts ? 'product_facts' : 'clarification',
    status: 'answered',
    answerSchemaVersion: 1,
    publicPayloadJson,
    payloadDigest: canonicalSha256(publicPayloadJson),
    answerJson: productFacts
      ? { facts, product_id: uuid(6), fact_set_id: uuid(7), fact_set_version: 1 }
      : { selected_option_id: 'soft', selected_option_label: 'Soft light' },
    responseJson: {
      turn_id: turnId,
      user_status: 'thinking',
      revision: 4,
      continuation_no: 2,
      event_scope: `turn:${turnId}`,
      last_event_seq: 10,
    },
    answeredAt: new Date('2026-09-08T00:00:00.000Z'),
    expiresAt: new Date('2026-09-08T00:01:00.000Z'),
  };
  const context = prepareAgentConfirmationContext(confirmation)!;
  const item = prepareAgentTranscriptItem(
    {
      id: uuid(8),
      user_id: userId,
      session_id: sessionId,
      turn_id: turnId,
      continuation_no: 2,
      sequence_no: '3',
      schema_version: 1,
      item_type: 'host_context',
      source_key: `confirmation:${confirmationId}:answered`,
      source_message_id: null,
      source_trace_step_id: null,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'confirmation_answer@1',
        content: { type: 'inline', value: context },
      },
      resource_dependencies_json: agentConfirmationDependencies(userId, context),
      created_at: '2026-09-08T00:00:00.000Z',
    },
    {
      userMessage: { schema: z.never() },
      legacyMessage: { schema: z.never() },
      calls: [],
      hostContexts: [
        { name: 'confirmation_answer@1', content: { schema: agentConfirmationContextSchema } },
      ],
      resourceDependencySchema: agentConfirmedFactDependencySchema,
    },
  ).item;
  const asset = {
    id: uuid(5),
    userId,
    status: 'ready',
    deletedAt: null,
    contentHash: 'a'.repeat(64),
    productId: uuid(6),
  };
  const product = { id: uuid(6), userId, status: 'active' };
  const factSet = {
    id: uuid(7),
    userId,
    productId: uuid(6),
    versionNo: 1,
    sourceAssetId: uuid(5),
    sourceVersion: 'a'.repeat(64),
    factsJson: normalizeAgentProductFacts(facts),
    confirmedBy: userId,
    confirmedAt: new Date('2026-09-08T00:00:00.000Z'),
  };
  const database = {
    query: {
      agentTurnConfirmations: { findFirst: vi.fn().mockResolvedValue(confirmation) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: userId, riskStatus: 'normal' }) },
      assets: { findFirst: vi.fn().mockResolvedValue(asset) },
      products: { findFirst: vi.fn().mockResolvedValue(product) },
      productFactSets: { findFirst: vi.fn().mockResolvedValue(factSet) },
    },
  };
  return {
    item,
    database,
    confirmation,
    asset,
    product,
    factSet,
    binding: new AgentTranscriptConfirmationBinding(database as unknown as Pick<Database, 'query'>),
  };
}

describe('confirmed transcript host binding', () => {
  it('reads an answered clarification after the old pending expiry without consuming it again', async () => {
    const { item, binding, database } = fixture();
    expect(await binding.verifySource(item)).toBe(true);
    expect(await binding.authorizeDependencies(item)).toBe(true);
    expect(database.query.assets.findFirst).not.toHaveBeenCalled();
  });

  it('accepts the actual confirmed fact version and retains the duplicate user answer', async () => {
    const { item, binding } = fixture(true);
    expect(await binding.verifySource(item)).toBe(true);
    expect(await binding.authorizeDependencies(item)).toBe(true);
    expect(item.payload_json).toMatchObject({ content: { value: { answer: { facts } } } });
  });

  it('scopes confirmation and fact SQL to the real user/turn/product/version', async () => {
    const { item, binding, database } = fixture(true);
    expect(await binding.authorizeDependencies(item)).toBe(true);
    const sourceSql = sqlResource.db.query.agentTurnConfirmations
      .findFirst(
        database.query.agentTurnConfirmations.findFirst.mock.calls[0]![0] as Parameters<
          typeof sqlResource.db.query.agentTurnConfirmations.findFirst
        >[0],
      )
      .toSQL();
    expect(sourceSql.params).toEqual(expect.arrayContaining([confirmationId, userId, turnId]));
    const factSql = sqlResource.db.query.productFactSets
      .findFirst(
        database.query.productFactSets.findFirst.mock.calls[0]![0] as Parameters<
          typeof sqlResource.db.query.productFactSets.findFirst
        >[0],
      )
      .toSQL();
    expect(factSql.params).toEqual(expect.arrayContaining([uuid(7), userId, uuid(6), 1]));
  });

  it.each([
    { userId: uuid(99) },
    { turnId: uuid(99) },
    { id: uuid(99) },
    { status: 'pending' },
    { status: 'expired' },
    { answerSchemaVersion: 2 },
    { payloadDigest: 'b'.repeat(64) },
    { answeredAt: null },
    { answerJson: { selected_option_id: 'soft', selected_option_label: 'Changed' } },
  ])('rejects source mismatch or an uncommitted confirmation: %j', async (change) => {
    const { item, binding, database, confirmation } = fixture();
    database.query.agentTurnConfirmations.findFirst.mockResolvedValue({
      ...confirmation,
      ...change,
    });
    expect(await binding.verifySource(item)).toBe(false);
    expect(await binding.authorizeDependencies(item)).toBe(false);
    expect(database.query.users.findFirst).not.toHaveBeenCalled();
  });

  it.each([{ turn_id: uuid(99) }, { continuation_no: 3 }, { event_scope: `turn:${uuid(99)}` }])(
    'rejects a confirmation response bound to another continuation: %j',
    async (change) => {
      const { item, binding, database, confirmation } = fixture();
      database.query.agentTurnConfirmations.findFirst.mockResolvedValue({
        ...confirmation,
        responseJson: { ...confirmation.responseJson, ...change },
      });
      expect(await binding.verifySource(item)).toBe(false);
    },
  );

  it('rejects missing dependency indexing and unknown host events', async () => {
    const { item, binding } = fixture(true);
    expect(await binding.authorizeDependencies({ ...item, resource_dependencies_json: [] })).toBe(
      false,
    );
    expect(await binding.verifySource({ ...item, source_key: 'context:unrelated' })).toBe(false);
    expect(await binding.verifySource({ ...item, item_type: 'user_message' })).toBe(false);
  });

  it.each([
    { status: 'deleted' },
    { deletedAt: new Date() },
    { userId: uuid(99) },
    { contentHash: 'b'.repeat(64) },
    { productId: uuid(99) },
  ])('rejects revoked or rebound source assets: %j', async (change) => {
    const { item, binding, database, asset } = fixture(true);
    database.query.assets.findFirst.mockResolvedValue({ ...asset, ...change });
    expect(await binding.authorizeDependencies(item)).toBe(false);
    expect(database.query.productFactSets.findFirst).not.toHaveBeenCalled();
  });

  it.each([{ status: 'archived' }, { userId: uuid(99) }])(
    'rejects unavailable products: %j',
    async (change) => {
      const { item, binding, database, product } = fixture(true);
      database.query.products.findFirst.mockResolvedValue({ ...product, ...change });
      expect(await binding.authorizeDependencies(item)).toBe(false);
    },
  );

  it.each([
    { userId: uuid(99) },
    { productId: uuid(99) },
    { versionNo: 2 },
    { confirmedBy: uuid(99) },
    { confirmedAt: null },
    { sourceAssetId: uuid(99) },
    { sourceVersion: 'b'.repeat(64) },
    { factsJson: { ...facts, primary_colors: ['blue'] } },
  ])('rejects incorrect fact provenance or content: %j', async (change) => {
    const { item, binding, database, factSet } = fixture(true);
    database.query.productFactSets.findFirst.mockResolvedValue({ ...factSet, ...change });
    expect(await binding.authorizeDependencies(item)).toBe(false);
  });

  it('keeps an older immutable confirmation when a newer fact version exists', async () => {
    const { item, binding, database, product } = fixture(true);
    database.query.products.findFirst.mockResolvedValue({ ...product, latestFactSetId: uuid(99) });
    expect(await binding.authorizeDependencies(item)).toBe(true);
  });

  it('revalidates sources without caching a prior success', async () => {
    const { item, binding, database } = fixture(true);
    expect(await binding.authorizeDependencies(item)).toBe(true);
    database.query.agentTurnConfirmations.findFirst.mockResolvedValueOnce(undefined);
    expect(await binding.authorizeDependencies(item)).toBe(false);
  });

  it('rejects inaccessible users and suppresses storage exception details', async () => {
    const { item, binding, database } = fixture();
    database.query.users.findFirst.mockResolvedValueOnce({ id: userId, riskStatus: 'frozen' });
    expect(await binding.authorizeDependencies(item)).toBe(false);
    database.query.agentTurnConfirmations.findFirst.mockRejectedValueOnce(
      new Error('private DB details'),
    );
    expect(await binding.verifySource(item)).toBe(false);
  });
});
