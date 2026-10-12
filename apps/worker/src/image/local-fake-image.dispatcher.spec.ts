import { describe, expect, it, vi } from 'vitest';
import { canonicalSha256 } from '@ecom-forge/shared';

import type { WorkerConfig } from '../config/worker-config.js';
import { createLocalFakeImageDispatcher } from './local-fake-image.dispatcher.js';

describe('local fake image dispatcher', () => {
  it('returns consumable PNG outputs only after the dispatch boundary is recorded', async () => {
    const dispatch = createLocalFakeImageDispatcher({
      appEnv: 'test',
      providerProcessorMode: 'fake_validation',
    } as WorkerConfig);
    const markPotentiallyDispatched = vi.fn(() => Promise.resolve(true));
    const outcome = await dispatch({
      taskId: '11111111-1111-4111-8111-111111111111',
      workflowRunId: '22222222-2222-4222-8222-222222222222',
      userId: '33333333-3333-4333-8333-333333333333',
      attemptId: '44444444-4444-4444-8444-444444444444',
      traceId: '55555555-5555-4555-8555-555555555555',
      paramsSnapshot: paramsSnapshot(),
      markPotentiallyDispatched,
    });

    expect(markPotentiallyDispatched).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({ kind: 'succeeded' });
    expect(outcome).not.toHaveProperty('cost_summary');
    if (outcome.kind !== 'succeeded') throw new Error('Expected a successful fake image outcome');
    expect(outcome.outputs).toHaveLength(2);
    await expect(
      outcome.outputs[0]?.consume((bytes) =>
        Promise.resolve(Buffer.from(bytes).subarray(1, 4).toString()),
      ),
    ).resolves.toBe('PNG');
  });

  it('cannot be enabled outside local or test fake validation', () => {
    expect(() =>
      createLocalFakeImageDispatcher({
        appEnv: 'production',
        providerProcessorMode: 'real',
      } as WorkerConfig),
    ).toThrow('restricted');
  });

  it('rejects a tampered product facts snapshot before the dispatch boundary', async () => {
    const dispatch = createLocalFakeImageDispatcher({
      appEnv: 'test',
      providerProcessorMode: 'fake_validation',
    } as WorkerConfig);
    const markPotentiallyDispatched = vi.fn(() => Promise.resolve(true));
    const params = paramsSnapshot();
    const productFacts = productFactsSnapshot();

    await expect(
      dispatch({
        taskId: '11111111-1111-4111-8111-111111111111',
        workflowRunId: '22222222-2222-4222-8222-222222222222',
        userId: '33333333-3333-4333-8333-333333333333',
        attemptId: '44444444-4444-4444-8444-444444444444',
        traceId: '55555555-5555-4555-8555-555555555555',
        paramsSnapshot: {
          ...params,
          product_facts_snapshot: {
            ...productFacts,
            facts: { ...productFacts.facts, product_name: 'Tampered product' },
          },
        },
        markPotentiallyDispatched,
      }),
    ).rejects.toThrow('Product facts snapshot digest is invalid');
    expect(markPotentiallyDispatched).not.toHaveBeenCalled();
  });
});

function paramsSnapshot() {
  return {
    schema_version: 1,
    source: 'chat',
    operation: 'image.edit',
    goal_summary: 'Generate a product image',
    creative_note: 'This is user-facing task metadata and must not block dispatch.',
    aspect_ratio: '1:1',
    resolution_tier: '1k',
    output_count: 2,
    output_count_source: 'user_explicit',
    model_snapshot: { id: '44444444-4444-4444-8444-444444444444' },
    model_selection: { image: { model_snapshot_id: '44444444-4444-4444-8444-444444444444' } },
    input_bindings: [],
    operation_key: 'a'.repeat(64),
    depends_on: [],
    storage_snapshot: {
      schema_version: 1,
      purpose: 'private_assets',
      runtime_revision: 1,
      channel_id: '66666666-6666-4666-8666-666666666666',
      channel_revision: 1,
      adapter_key: 'local-private-v1',
      endpoint_profile_key: 'local',
      region: null,
      credential_version_id: '77777777-7777-4777-8777-777777777777',
      validation_evidence_digest: 'b'.repeat(64),
    },
    product_facts_snapshot: productFactsSnapshot(),
  };
}

function productFactsSnapshot() {
  const snapshot = {
    schema_version: 1 as const,
    product_id: '88888888-8888-4888-8888-888888888888',
    fact_set_id: '99999999-9999-4999-8999-999999999999',
    fact_set_version: 1,
    source_asset_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source_version: 'c'.repeat(64),
    facts: {
      product_name: 'Blue ceramic cup',
      primary_colors: ['blue'],
      logos: [],
      visible_text: [],
      materials: ['ceramic'],
      must_preserve: ['handle'],
      unknown_fields: [],
    },
  };
  return { ...snapshot, snapshot_digest: canonicalSha256(snapshot) };
}
