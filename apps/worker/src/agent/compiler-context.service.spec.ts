import { canonicalSha256 } from '@ecom-forge/shared';
import { attachmentSnapshotSchema, type AttachmentSnapshot } from '@ecom-forge/compiler';
import {
  getBuiltinSkillCatalog,
  resolveBuiltinSkill,
  validateSkillSelection,
  type AuxiliarySkillSelectionSnapshot,
  type SkillSelectionSnapshot,
} from '@ecom-forge/skills';
import { describe, expect, it, vi } from 'vitest';

import {
  CompilerContextService,
  inheritProductFactsFromParent,
  toCompilerBinding,
} from './compiler-context.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('CompilerContextService product fact inheritance', () => {
  it('inherits the exact frozen fact snapshot from a commerce parent', () => {
    const facts = productFacts();
    expect(
      inheritProductFactsFromParent(
        {
          userId: USER_ID,
          originDomain: 'commerce',
          paramsSnapshot: { product_facts_snapshot: facts },
        },
        USER_ID,
      ),
    ).toEqual(facts);
  });

  it('rejects cross-user, non-commerce, missing, and digest-drifted parent facts', () => {
    const facts = productFacts();
    const parent = {
      userId: USER_ID,
      originDomain: 'commerce',
      paramsSnapshot: { product_facts_snapshot: facts },
    };
    expect(
      inheritProductFactsFromParent(parent, '22222222-2222-4222-8222-222222222222'),
    ).toBeNull();
    expect(
      inheritProductFactsFromParent({ ...parent, originDomain: 'creative' }, USER_ID),
    ).toBeNull();
    expect(inheritProductFactsFromParent({ ...parent, paramsSnapshot: {} }, USER_ID)).toBeNull();
    expect(
      inheritProductFactsFromParent(
        {
          ...parent,
          paramsSnapshot: {
            product_facts_snapshot: {
              ...facts,
              facts: { ...facts.facts, product_name: 'Tampered product' },
            },
          },
        },
        USER_ID,
      ),
    ).toBeNull();
  });
});

describe('CompilerContextService binding normalization', () => {
  it('preserves trusted session-candidate lineage for strict compiler validation', () => {
    const candidate = {
      ...imageBinding('session-output-2'),
      candidate_kind: 'latest_output' as const,
      candidate_position: 2,
      lineage_source_binding_keys: ['session-source-1'],
    } as AttachmentSnapshot & {
      candidate_kind: 'latest_output';
      candidate_position: number;
      lineage_source_binding_keys: string[];
    };

    const normalized = toCompilerBinding(candidate);

    expect(attachmentSnapshotSchema.safeParse(normalized).success).toBe(true);
    expect(normalized).toEqual({
      ...imageBinding('session-output-2'),
      candidate_kind: 'latest_output',
      candidate_position: 2,
      lineage_source_binding_keys: ['session-source-1'],
    });
  });
});

describe('CompilerContextService built-in Skill resolution', () => {
  it('builds current built-in content from a stale ID without external catalog rows', async () => {
    const selection = await staleBuiltinSelection();
    const current = await resolveBuiltinSkill(selection.primary_skill_id);
    const database = {
      query: { agentTurnConfirmations: { findFirst: vi.fn().mockResolvedValue(undefined) } },
      select: () => ({ from: () => Promise.resolve([]) }),
    } as never;
    const service = new CompilerContextService(
      database,
      {
        agentExecutionPolicyVersion: 'test-policy-v1',
        compilerQuoteTtlSeconds: 300,
        storageMaxImagePixels: 2_000_000,
      } as never,
      'test-capabilities-v1',
    );

    const context = await service.build({
      selection,
      attachments: [],
      userId: USER_ID,
      sessionId: '22222222-2222-4222-8222-222222222222',
      turnId: '33333333-3333-4333-8333-333333333333',
      continuationNo: 1,
      selectionHash: canonicalSha256(selection),
      executionAuthorization: { schema_version: 1 },
      executionAuthorizationHash: canonicalSha256({ schema_version: 1 }),
      message: '重绘这张图',
    } as never);

    expect(current?.skillId).toBe('creative-scene-reimagining@1.3.1');
    expect(context.skill.primary_skill_id).toBe('creative-scene-reimagining@0.0.1');
    expect(context.skill.definition_digest).toBe(current?.definitionHash);
    expect(context.skill.package_digest).toBe(current?.packageDigest);
    expect(context.policies.max_image_pixels).toBe(2_000_000);
  });

  it('keeps external Skills strict when their catalog closure is absent', async () => {
    const database = {
      query: {
        skills: { findFirst: () => Promise.resolve(undefined) },
        skillPackages: { findFirst: () => Promise.resolve(undefined) },
        skillCatalogReleases: { findFirst: () => Promise.resolve(undefined) },
        skillCatalogState: { findFirst: () => Promise.resolve(undefined) },
      },
      select: () => ({ from: () => Promise.resolve([]) }),
    } as never;
    const service = new CompilerContextService(
      database,
      {
        agentExecutionPolicyVersion: 'test-policy-v1',
        compilerQuoteTtlSeconds: 300,
      } as never,
      'test-capabilities-v1',
    );
    const selection = {
      ...(await staleBuiltinSelection()),
      primary_skill_id: 'external-scene@1.0.0',
    };

    await expect(
      service.build({
        selection,
        attachments: [],
        userId: USER_ID,
        sessionId: '22222222-2222-4222-8222-222222222222',
        turnId: '33333333-3333-4333-8333-333333333333',
        continuationNo: 1,
        selectionHash: canonicalSha256(selection),
        executionAuthorization: { schema_version: 1 },
        executionAuthorizationHash: canonicalSha256({ schema_version: 1 }),
        message: '生成图片',
      } as never),
    ).rejects.toThrow('SKILL_VERSION_DRIFT');
  });
});

function productFacts() {
  const snapshot = {
    schema_version: 1 as const,
    product_id: '33333333-3333-4333-8333-333333333333',
    fact_set_id: '44444444-4444-4444-8444-444444444444',
    fact_set_version: 1,
    source_asset_id: '55555555-5555-4555-8555-555555555555',
    source_version: 'a'.repeat(64),
    facts: {
      product_name: 'Example bottle',
      primary_colors: ['blue'],
      logos: ['EXAMPLE'],
      visible_text: ['500 ml'],
      materials: ['glass'],
      must_preserve: ['bottle shape'],
      unknown_fields: [],
    },
  };
  return { ...snapshot, snapshot_digest: canonicalSha256(snapshot) };
}

function imageBinding(bindingKey: string): AttachmentSnapshot {
  return {
    binding_key: bindingKey,
    kind: 'artifact',
    object_id: '55555555-5555-4555-8555-555555555555',
    object_version: 'a'.repeat(64),
    content_hash: 'a'.repeat(64),
    owner_user_id: USER_ID,
    readable: true,
    mutable: true,
    producer_mode: 'chat',
    producer_session_id: '22222222-2222-4222-8222-222222222222',
    mutation_owner: 'chat_session',
    source_action: 'edit',
    media_type: 'image',
    lifecycle: 'active',
    visibility: 'private',
    role: 'edit_source',
    position: 1,
    publication_revision: 1,
  };
}

async function staleBuiltinSelection(): Promise<SkillSelectionSnapshot> {
  const primary = await resolveBuiltinSkill('creative-scene-reimagining@1.3.1');
  if (!primary) throw new Error('BUILTIN_TEST_SKILL_MISSING');
  const catalog = await getBuiltinSkillCatalog();
  const dependencies = new Map<string, AuxiliarySkillSelectionSnapshot>();
  for (const dependency of primary.definition.dependencies) {
    const auxiliary = await resolveBuiltinSkill(dependency.skill_id);
    if (!auxiliary) throw new Error('BUILTIN_TEST_DEPENDENCY_MISSING');
    const planning = auxiliary.resources.get('SKILL.md');
    if (!planning) throw new Error('BUILTIN_TEST_RESOURCE_MISSING');
    dependencies.set(dependency.skill_id, {
      skill_id: auxiliary.skillId,
      name: auxiliary.definition.display_name,
      definition_hash: auxiliary.definitionHash,
      package_record_id: auxiliary.packageRecordId,
      planning_resource: planning,
      reference_resources: auxiliary.definition.references.map((reference) => {
        const resource = auxiliary.resources.get(reference.path);
        if (!resource) throw new Error('BUILTIN_TEST_RESOURCE_MISSING');
        return resource;
      }),
    });
  }
  const planning = primary.resources.get('SKILL.md');
  if (!planning) throw new Error('BUILTIN_TEST_RESOURCE_MISSING');
  const resolved = validateSkillSelection({
    selection: { primary_skill_id: primary.skillId, preset_selections: [] },
    definition: primary.definition,
    definitionHash: primary.definitionHash,
    packageRecordId: primary.packageRecordId,
    planningResource: planning,
    catalogReleaseId: catalog.catalogReleaseId,
    catalogVersion: catalog.catalogVersion,
    dependencySnapshots: dependencies,
    resourceSnapshots: primary.resources,
  });
  return { ...resolved.snapshot, primary_skill_id: 'creative-scene-reimagining@0.0.1' };
}
