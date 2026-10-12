import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillExecutionPolicy, type SkillExecutionPolicy } from '@ecom-forge/shared';
import { createHash } from 'node:crypto';
import type { Database } from '@ecom-forge/db';
import { describe, expect, it, vi } from 'vitest';

import type { ClaimedAgentTurn } from './agent-turn.types.js';
import { AgentSessionImageCandidateService } from './agent-session-image-candidate.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OUTPUT_ID = '33333333-3333-4333-8333-333333333333';
const PARENT_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_ID = '55555555-5555-4555-8555-555555555555';

describe('AgentSessionImageCandidateService', () => {
  it('includes a middle upload group within the bounded recent-history window', async () => {
    const ids = [
      SOURCE_ID,
      '55555555-5555-4555-8555-555555555556',
      '55555555-5555-4555-8555-555555555557',
    ];
    const messages = ids.map((id, index) => ({
      messageId: id,
      createdAt: new Date(1000 * (index + 1)),
      attachments: [originalAttachment(id, 0)],
    }));
    const candidates = await new AgentSessionImageCandidateService(
      queuedDatabase([[], [...messages].reverse(), ids.map(readyAsset)], [messages[0]!]),
    ).resolve(claimedTurn());
    expect(candidates.map((candidate) => candidate.object_id)).toEqual(ids);
    expect(candidates.map((candidate) => candidate.source_group?.is_latest_upload)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('does not silently truncate the union of recent upload groups above nine sources', async () => {
    const ids = Array.from(
      { length: 10 },
      (_, index) => '55555555-5555-4555-8555-' + String(index).padStart(12, '0'),
    );
    const messages = [ids.slice(0, 5), ids.slice(5)].map((group, index) => ({
      messageId: ids[index],
      createdAt: new Date(1000 * (index + 1)),
      attachments: group.map(originalAttachment),
    }));
    await expect(
      new AgentSessionImageCandidateService(
        queuedDatabase([[], [...messages].reverse(), ids.map(readyAsset)], [messages[0]!]),
      ).resolve(claimedTurn()),
    ).rejects.toThrow('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
  });
  it('preserves upload provenance when old and recent subjects share the candidate pool', async () => {
    const newer = '55555555-5555-4555-8555-555555555556';
    const database = queuedDatabase(
      [
        [outputRow()],
        [
          {
            messageId: SESSION_ID,
            createdAt: new Date('2026-08-25T02:00:00Z'),
            attachments: [originalAttachment(newer, 0)],
          },
        ],
        [readyAsset(SOURCE_ID), readyAsset(newer)],
      ],
      [
        {
          messageId: USER_ID,
          createdAt: new Date('2026-08-01T00:00:00Z'),
          attachments: [originalAttachment(SOURCE_ID, 0)],
        },
      ],
    );
    const candidates = await new AgentSessionImageCandidateService(database).resolve(claimedTurn());
    expect(candidates).toMatchObject([
      {
        object_id: SOURCE_ID,
        source_group: {
          message_id: USER_ID,
          is_latest_upload: false,
          created_at: '2026-08-01T00:00:00.000Z',
        },
      },
      { object_id: newer, source_group: { message_id: SESSION_ID, is_latest_upload: true } },
    ]);
  });
  it('selects one latest workflow before loading candidates from a long history', async () => {
    const latest = outputRow();
    const history = Array.from({ length: 1000 }, (_, index) => ({
      ...latest,
      workflowRunId: `77777777-7777-4777-8777-${String(index).padStart(12, '0')}`,
      workflowCreatedAt: new Date('2026-08-24T00:00:00Z'),
    }));
    const database = queuedDatabase([[...history, latest]]);
    const select = vi.spyOn(database, 'select');
    const candidates = await new AgentSessionImageCandidateService(database).resolve(
      claimedTurn({
        selection: {
          primary_skill_id: 'creative-free-generation@1.0.0',
          execution_policy: { version: 1, family: 'text_generation', max_sources: 9 },
        } as ClaimedAgentTurn['selection'],
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.object_id).toBe(OUTPUT_ID);
    const queries = select.mock.results;
    expect(queries).toHaveLength(2);
    const first = queries[0]?.value as { limit: ReturnType<typeof vi.fn> };
    expect(first.limit).toHaveBeenCalledWith(1);
  });

  it.each([
    'creative-scene-reimagining@1.3.1',
    'creative-scene-collage@1.4.2',
    'daily-memory-page@1.1.0',
    'minimal-scene-collage@2.8.0',
    'xieyi-scene-collage@1.0.0',
    'void-line-poster@1.1.0',
    'watercolor-scene-collage@1.0.0',
  ])('freezes the latest output and its original source for %s', async (primarySkillId) => {
    const database = queuedDatabase([
      [
        {
          id: OUTPUT_ID,
          taskId: '66666666-6666-4666-8666-666666666666',
          workflowRunId: '77777777-7777-4777-8777-777777777777',
          workflowCreatedAt: new Date('2026-08-25T00:59:00.000Z'),
          taskCreatedAt: new Date('2026-08-25T00:59:01.000Z'),
          userId: USER_ID,
          contentHash: 'a'.repeat(64),
          publicationRevision: 3,
          producerMode: 'chat',
          producerSessionId: SESSION_ID,
          mutationOwner: 'chat_session',
          sourceAction: 'edit',
          visibility: 'private',
          metaJson: { output_index: 0 },
          createdAt: new Date('2026-08-25T01:00:00.000Z'),
        },
      ],
      [],
      [
        {
          artifactId: OUTPUT_ID,
          sourceType: 'artifact',
          sourceAssetId: null,
          sourceArtifactId: PARENT_ID,
          role: 'edit_source',
          sortOrder: 0,
        },
      ],
      [{ id: OUTPUT_ID, sourceArtifactId: PARENT_ID }],
      [
        {
          artifactId: PARENT_ID,
          sourceType: 'asset',
          sourceAssetId: SOURCE_ID,
          sourceVersion: 'b'.repeat(64),
          sourceArtifactId: null,
          role: 'semantic_reference',
          sortOrder: 0,
        },
      ],
      [{ id: PARENT_ID, sourceArtifactId: null }],
      [readyAsset(SOURCE_ID)],
    ]);
    const service = new AgentSessionImageCandidateService(database);

    const candidates = await service.resolve(
      claimedTurn({
        selection: {
          primary_skill_id: primarySkillId,
          execution_policy: declaredPolicyForFixture(primarySkillId),
        } as ClaimedAgentTurn['selection'],
      }),
    );

    expect(candidates).toMatchObject([
      {
        binding_key: 'session-output-1',
        object_id: OUTPUT_ID,
        role: 'edit_source',
        candidate_kind: 'latest_output',
        candidate_position: 1,
        lineage_source_binding_keys: ['session-source-1'],
        publication_revision: 3,
      },
      {
        binding_key: 'session-source-1',
        object_id: SOURCE_ID,
        role: 'semantic_reference',
        candidate_kind: 'original_source',
        candidate_position: 1,
      },
    ]);
  });

  it('does not inject session candidates when this turn has an explicit attachment', async () => {
    const database = queuedDatabase([]);
    const candidates = await new AgentSessionImageCandidateService(database).resolve(
      claimedTurn({
        attachments: [
          {
            binding_key: 'current-source',
            kind: 'asset',
            object_id: SOURCE_ID,
            object_version: 'b'.repeat(64),
            content_hash: 'b'.repeat(64),
            owner_user_id: USER_ID,
            readable: true,
            mutable: false,
            producer_mode: null,
            producer_session_id: null,
            mutation_owner: null,
            source_action: null,
            media_type: 'image',
            lifecycle: 'active',
            visibility: 'private',
            role: 'semantic_reference',
            position: 0,
            publication_revision: null,
          },
        ],
      }),
    );

    expect(candidates).toEqual([]);
  });

  it('retains all three original inputs when only one image succeeded', async () => {
    const second = '55555555-5555-4555-8555-555555555556';
    const third = '55555555-5555-4555-8555-555555555557';
    const originals = [SOURCE_ID, second, third];
    const database = queuedDatabase([
      [outputRow()],
      [
        {
          createdAt: new Date('2026-08-25T00:58:00Z'),
          attachments: originals.map(originalAttachment),
        },
      ],
      originals.map(readyAsset),
      [
        {
          artifactId: OUTPUT_ID,
          sourceType: 'asset',
          sourceAssetId: SOURCE_ID,
          sourceArtifactId: null,
          sourceVersion: 'b'.repeat(64),
          role: 'semantic_reference',
          sortOrder: 0,
        },
      ],
      [{ id: OUTPUT_ID, sourceArtifactId: null }],
      originals.map(readyAsset),
    ]);
    const candidates = await new AgentSessionImageCandidateService(database).resolve(claimedTurn());
    expect(candidates.map((candidate) => candidate.object_id)).toEqual([OUTPUT_ID, ...originals]);
    expect(candidates[0]?.lineage_source_binding_keys).toEqual(['session-source-1']);
    expect(candidates.slice(1).map((candidate) => candidate.candidate_position)).toEqual([1, 2, 3]);
  });

  it('keeps the first original after a newer source and workflow, with truthful lineage', async () => {
    const newer = '55555555-5555-4555-8555-555555555556';
    const database = queuedDatabase(
      [
        [outputRow()],
        [
          {
            createdAt: new Date('2026-08-25T00:58:00Z'),
            attachments: [originalAttachment(newer, 0)],
          },
        ],
        [readyAsset(SOURCE_ID), readyAsset(newer)],
        [
          {
            artifactId: OUTPUT_ID,
            sourceType: 'asset',
            sourceAssetId: newer,
            sourceArtifactId: null,
            sourceVersion: 'b'.repeat(64),
            role: 'semantic_reference',
            sortOrder: 0,
          },
        ],
        [{ id: OUTPUT_ID, sourceArtifactId: null }],
        [readyAsset(SOURCE_ID), readyAsset(newer)],
      ],
      [
        {
          createdAt: new Date('2026-08-01T00:00:00Z'),
          attachments: [originalAttachment(SOURCE_ID, 0)],
        },
      ],
    );
    const candidates = await new AgentSessionImageCandidateService(database).resolve(claimedTurn());
    expect(candidates.map((candidate) => candidate.object_id)).toEqual([
      OUTPUT_ID,
      SOURCE_ID,
      newer,
    ]);
    expect(candidates[0]?.lineage_source_binding_keys).toEqual(['session-source-2']);
    expect(candidates.slice(1).map((candidate) => candidate.candidate_position)).toEqual([1, 2]);
  });

  it('does not replace a newer failed source group with an older successful image', async () => {
    const newer = '55555555-5555-4555-8555-555555555556';
    const database = queuedDatabase([
      [outputRow()],
      [
        {
          createdAt: new Date('2026-08-25T02:00:00Z'),
          attachments: [originalAttachment(newer, 0)],
        },
      ],
      [readyAsset(newer)],
    ]);
    expect(
      await new AgentSessionImageCandidateService(database).resolve(claimedTurn()),
    ).toMatchObject([
      { object_id: newer, candidate_kind: 'original_source', lineage_source_binding_keys: [] },
    ]);
  });

  it.each(['drift', 'foreign', 'deleted', 'not_image'])(
    'does not recover a %s lineage source or advertise its binding',
    async (kind) => {
      const source = {
        ...readyAsset(SOURCE_ID),
        ...(kind === 'drift' ? { contentHash: 'c'.repeat(64) } : {}),
        ...(kind === 'foreign' ? { userId: '99999999-9999-4999-8999-999999999999' } : {}),
        ...(kind === 'deleted' ? { deletedAt: new Date() } : {}),
        ...(kind === 'not_image' ? { mimeType: 'application/pdf' } : {}),
      };
      const database = queuedDatabase([
        [outputRow()],
        [],
        [
          {
            artifactId: OUTPUT_ID,
            sourceType: 'asset',
            sourceAssetId: SOURCE_ID,
            sourceArtifactId: null,
            sourceVersion: 'b'.repeat(64),
            role: 'semantic_reference',
            sortOrder: 0,
          },
        ],
        [{ id: OUTPUT_ID, sourceArtifactId: null }],
        [source],
      ]);
      expect(
        await new AgentSessionImageCandidateService(database).resolve(claimedTurn()),
      ).toMatchObject([
        { object_id: OUTPUT_ID, candidate_kind: 'latest_output', lineage_source_binding_keys: [] },
      ]);
    },
  );

  it('recovers original uploads when the previous generation produced no artifact', async () => {
    const secondSourceId = '55555555-5555-4555-8555-555555555556';
    const first = originalAttachment(SOURCE_ID, 0);
    const second = originalAttachment(secondSourceId, 1);
    const database = queuedDatabase([
      [],
      [{ attachments: [second, first] }],
      [readyAsset(SOURCE_ID), readyAsset(secondSourceId)],
    ]);

    const candidates = await new AgentSessionImageCandidateService(database).resolve(claimedTurn());

    expect(candidates).toMatchObject([
      {
        binding_key: 'session-source-1',
        object_id: SOURCE_ID,
        candidate_kind: 'original_source',
        candidate_position: 1,
        role: 'semantic_reference',
      },
      {
        binding_key: 'session-source-2',
        object_id: secondSourceId,
        candidate_kind: 'original_source',
        candidate_position: 2,
        role: 'semantic_reference',
      },
    ]);
  });

  it('rejects drifted or foreign source assets without selecting an older group', async () => {
    const foreignSourceId = '55555555-5555-4555-8555-555555555556';
    const database = queuedDatabase([
      [],
      [{ attachments: [originalAttachment(SOURCE_ID, 0), originalAttachment(foreignSourceId, 1)] }],
      [
        { ...readyAsset(SOURCE_ID), contentHash: 'c'.repeat(64) },
        { ...readyAsset(foreignSourceId), userId: '99999999-9999-4999-8999-999999999999' },
      ],
    ]);

    expect(await new AgentSessionImageCandidateService(database).resolve(claimedTurn())).toEqual(
      [],
    );
  });

  it('keeps valid members when only one asset in a source group has drifted', async () => {
    const secondSourceId = '55555555-5555-4555-8555-555555555556';
    const database = queuedDatabase([
      [],
      [{ attachments: [originalAttachment(SOURCE_ID, 0), originalAttachment(secondSourceId, 1)] }],
      [readyAsset(SOURCE_ID), { ...readyAsset(secondSourceId), contentHash: 'c'.repeat(64) }],
    ]);

    expect(
      await new AgentSessionImageCandidateService(database).resolve(claimedTurn()),
    ).toMatchObject([{ object_id: SOURCE_ID }]);
  });

  it('does not substitute an older valid group when the newer group has drifted', async () => {
    const newer = '55555555-5555-4555-8555-555555555556';
    const database = queuedDatabase(
      [
        [outputRow()],
        [
          {
            createdAt: new Date('2026-08-25T02:00:00Z'),
            attachments: [originalAttachment(newer, 0)],
          },
        ],
        [{ ...readyAsset(newer), contentHash: 'c'.repeat(64) }, readyAsset(SOURCE_ID)],
      ],
      [
        {
          createdAt: new Date('2026-08-01T00:00:00Z'),
          attachments: [originalAttachment(SOURCE_ID, 0)],
        },
      ],
    );
    expect(await new AgentSessionImageCandidateService(database).resolve(claimedTurn())).toEqual(
      [],
    );
  });

  it('keeps valid output lineage when an unrelated latest upload has drifted', async () => {
    const newer = '55555555-5555-4555-8555-555555555556';
    const database = queuedDatabase(
      [
        [outputRow()],
        [
          {
            createdAt: new Date('2026-08-25T00:58:00Z'),
            attachments: [originalAttachment(newer, 0)],
          },
        ],
        [readyAsset(SOURCE_ID), { ...readyAsset(newer), contentHash: 'c'.repeat(64) }],
        [
          {
            artifactId: OUTPUT_ID,
            sourceType: 'asset',
            sourceAssetId: SOURCE_ID,
            sourceArtifactId: null,
            sourceVersion: 'b'.repeat(64),
            role: 'semantic_reference',
            sortOrder: 0,
          },
        ],
        [{ id: OUTPUT_ID, sourceArtifactId: null }],
        [readyAsset(SOURCE_ID)],
      ],
      [
        {
          createdAt: new Date('2026-08-01T00:00:00Z'),
          attachments: [originalAttachment(SOURCE_ID, 0)],
        },
      ],
    );

    const candidates = await new AgentSessionImageCandidateService(database).resolve(claimedTurn());
    expect(candidates.map((candidate) => candidate.object_id)).toEqual([OUTPUT_ID, SOURCE_ID]);
    expect(candidates[0]?.lineage_source_binding_keys).toEqual(['session-source-1']);
  });

  it('fails explicitly when a historical group exceeds the source candidate limit', async () => {
    const attachments = Array.from({ length: 10 }, (_, index) =>
      originalAttachment(`55555555-5555-4555-8555-${String(index).padStart(12, '0')}`, index),
    );
    const database = queuedDatabase([
      [],
      [{ createdAt: new Date('2026-08-25T00:58:00Z'), attachments }],
    ]);
    await expect(
      new AgentSessionImageCandidateService(database).resolve(claimedTurn()),
    ).rejects.toThrow('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
  });

  it('numbers parallel outputs in the same stable order shown by the workflow UI', async () => {
    const firstTaskId = '66666666-6666-4666-8666-666666666661';
    const secondTaskId = '66666666-6666-4666-8666-666666666662';
    const firstOutputId = '33333333-3333-4333-8333-333333333331';
    const secondOutputId = '33333333-3333-4333-8333-333333333332';
    const workflowRunId = '77777777-7777-4777-8777-777777777777';
    const workflowCreatedAt = new Date('2026-08-25T00:59:00.000Z');
    const database = queuedDatabase([
      [
        {
          id: secondOutputId,
          taskId: secondTaskId,
          workflowRunId,
          workflowCreatedAt,
          taskCreatedAt: new Date('2026-08-25T00:59:02.000Z'),
          userId: USER_ID,
          contentHash: 'b'.repeat(64),
          publicationRevision: 1,
          producerMode: 'chat',
          producerSessionId: SESSION_ID,
          mutationOwner: 'chat_session',
          sourceAction: 'edit',
          visibility: 'private',
          metaJson: { output_index: 0 },
          createdAt: new Date('2026-08-25T01:00:01.000Z'),
        },
        {
          id: firstOutputId,
          taskId: firstTaskId,
          workflowRunId,
          workflowCreatedAt,
          taskCreatedAt: new Date('2026-08-25T00:59:01.000Z'),
          userId: USER_ID,
          contentHash: 'a'.repeat(64),
          publicationRevision: 1,
          producerMode: 'chat',
          producerSessionId: SESSION_ID,
          mutationOwner: 'chat_session',
          sourceAction: 'edit',
          visibility: 'private',
          metaJson: { output_index: 0 },
          createdAt: new Date('2026-08-25T01:00:02.000Z'),
        },
      ],
      [],
      [],
      [{ id: firstOutputId, sourceArtifactId: null }],
      [],
      [{ id: secondOutputId, sourceArtifactId: null }],
    ]);

    const candidates = await new AgentSessionImageCandidateService(database).resolve(
      claimedTurn({
        selection: {
          primary_skill_id: 'creative-scene-reimagining@1.3.1',
          execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
        } as ClaimedAgentTurn['selection'],
      }),
    );

    expect(
      candidates.map(({ candidate_position, object_id }) => [candidate_position, object_id]),
    ).toEqual([
      [1, firstOutputId],
      [2, secondOutputId],
    ]);
  });

  it('keeps all 16 published outputs without silently dropping the later images', async () => {
    const outputs = Array.from({ length: 16 }, (_, index) => ({
      ...outputRow(),
      id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
      metaJson: { output_index: index },
    }));
    const candidates = await new AgentSessionImageCandidateService(
      queuedDatabase([outputs]),
    ).resolve(
      claimedTurn({
        selection: {
          primary_skill_id: 'creative-free-generation@1.0.0',
          execution_policy: { version: 1, family: 'text_generation', max_sources: 9 },
        } as ClaimedAgentTurn['selection'],
      }),
    );
    expect(candidates).toHaveLength(16);
    expect(candidates.at(-1)).toMatchObject({
      object_id: outputs[15]?.id,
      candidate_kind: 'latest_output',
      candidate_position: 16,
      position: 15,
    });
  });

  it('fails explicitly when the latest workflow contains more than 16 outputs', async () => {
    const outputs = Array.from({ length: 17 }, (_, index) => ({
      ...outputRow(),
      id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
      metaJson: { output_index: index },
    }));
    await expect(
      new AgentSessionImageCandidateService(queuedDatabase([outputs])).resolve(
        claimedTurn({
          selection: {
            primary_skill_id: 'creative-free-generation@1.0.0',
            execution_policy: { version: 1, family: 'text_generation', max_sources: 9 },
          } as ClaimedAgentTurn['selection'],
        }),
      ),
    ).rejects.toThrow('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
  });

  it('fails instead of dropping the tenth distinct lineage source across outputs', async () => {
    const outputs = Array.from({ length: 10 }, (_, index) => ({
      ...outputRow(),
      id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
      metaJson: { output_index: index },
    }));
    const lineageQueries = outputs.flatMap((output, index) => [
      [
        {
          artifactId: output.id,
          sourceType: 'asset',
          sourceAssetId: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
          sourceVersion: 'b'.repeat(64),
          sourceArtifactId: null,
          role: 'semantic_reference',
          sortOrder: 0,
        },
      ],
      [{ id: output.id, sourceArtifactId: null }],
    ]);
    await expect(
      new AgentSessionImageCandidateService(
        queuedDatabase([outputs, [], ...lineageQueries]),
      ).resolve(claimedTurn()),
    ).rejects.toThrow('SESSION_IMAGE_CANDIDATE_LIMIT_EXCEEDED');
  });
});

function claimedTurn(overrides: Partial<ClaimedAgentTurn> = {}): ClaimedAgentTurn {
  return {
    turnId: '88888888-8888-4888-8888-888888888888',
    attachments: [],
    isFirstSessionTurn: false,
    selection: {
      primary_skill_id: 'creative-scene-reimagining@1.3.1',
      execution_policy: { version: 1, family: 'independent_sources', max_sources: 9 },
    } as ClaimedAgentTurn['selection'],
    sessionId: SESSION_ID,
    userId: USER_ID,
    ...overrides,
  } as ClaimedAgentTurn;
}

function outputRow() {
  return {
    id: OUTPUT_ID,
    taskId: '66666666-6666-4666-8666-666666666666',
    workflowRunId: '77777777-7777-4777-8777-777777777777',
    workflowCreatedAt: new Date('2026-08-25T00:59:00Z'),
    taskCreatedAt: new Date('2026-08-25T00:59:01Z'),
    userId: USER_ID,
    contentHash: 'a'.repeat(64),
    publicationRevision: 1,
    producerMode: 'chat',
    producerSessionId: SESSION_ID,
    mutationOwner: 'chat_session',
    sourceAction: 'edit',
    visibility: 'private',
    metaJson: { output_index: 0 },
    createdAt: new Date('2026-08-25T01:00:00Z'),
  };
}

function originalAttachment(objectId: string, position: number) {
  return {
    binding_key: `original-${position + 1}`,
    kind: 'asset',
    object_id: objectId,
    object_version: 'b'.repeat(64),
    content_hash: 'b'.repeat(64),
    owner_user_id: USER_ID,
    readable: true,
    mutable: false,
    producer_mode: null,
    producer_session_id: null,
    mutation_owner: null,
    source_action: null,
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    role: 'semantic_reference',
    position,
    publication_revision: null,
  };
}

function readyAsset(id: string) {
  return {
    id,
    userId: USER_ID,
    status: 'ready',
    deletedAt: null,
    mimeType: 'image/png',
    contentHash: 'b'.repeat(64),
  };
}

function queuedDatabase(results: unknown[][], earliestHistory?: unknown[]): Database {
  // The first fixture models available outputs; production first selects one workflow,
  // then reads only that workflow's artifacts instead of transferring the whole history.
  const [outputRows = [], ...remaining] = results;
  const latest = [...outputRows]
    .map((row) => row as ReturnType<typeof outputRow>)
    .sort(
      (left, right) =>
        left.workflowCreatedAt.getTime() - right.workflowCreatedAt.getTime() ||
        left.workflowRunId.localeCompare(right.workflowRunId),
    )
    .at(-1);
  const [history = [], ...afterHistory] = remaining;
  const normalizeHistory = (rows: unknown[]) =>
    rows.map((row) => {
      const message = row as { messageId?: string; createdAt?: Date; attachments: unknown[] };
      const hash = createHash('sha256').update(JSON.stringify(message)).digest('hex');
      return {
        ...message,
        createdAt: message.createdAt ?? new Date('2026-08-01T00:00:00Z'),
        messageId:
          message.messageId ??
          hash.slice(0, 8) +
            '-' +
            hash.slice(8, 12) +
            '-4' +
            hash.slice(13, 16) +
            '-8' +
            hash.slice(17, 20) +
            '-' +
            hash.slice(20, 32),
      };
    });
  const queue = latest
    ? [
        [latest],
        outputRows.filter(
          (row) => (row as ReturnType<typeof outputRow>).workflowRunId === latest.workflowRunId,
        ),
        normalizeHistory(history),
        normalizeHistory(earliestHistory ?? history),
        ...afterHistory,
      ]
    : [
        [],
        normalizeHistory(history),
        normalizeHistory(earliestHistory ?? history),
        ...afterHistory,
      ];
  const select = vi.fn(() => {
    let consumed = false;
    const consume = () => {
      if (consumed) throw new Error('Mock query consumed twice');
      consumed = true;
      const result = queue.shift();
      if (!result) throw new Error('Unexpected database query');
      return result;
    };
    const chain = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(consume())),
      then: (
        onFulfilled: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(consume()).then(onFulfilled, onRejected),
    };
    return chain;
  });
  return { select } as unknown as Database;
}
function declaredPolicyForFixture(skillId: string): SkillExecutionPolicy {
  const slug = skillId.split('@')[0];
  for (const directory of ['creative-first-release-v1', 'commerce-white-background-v1']) {
    const manifest = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          '../../packages/skills/content',
          directory,
          'skill-package/skill-package.json',
        ),
        'utf8',
      ),
    ) as {
      skill_profiles: Record<string, { slug: string; execution_policy?: unknown }>;
    };
    const row = Object.values(manifest.skill_profiles).find((item) => item.slug === slug);
    const policy = parseSkillExecutionPolicy(row?.execution_policy);
    if (policy) return policy;
  }
  throw new Error('Fixture Skill execution policy missing');
}
