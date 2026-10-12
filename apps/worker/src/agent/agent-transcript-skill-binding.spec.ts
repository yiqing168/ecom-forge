import { prepareAgentTranscriptItem } from '@ecom-forge/agent';
import type { Database } from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import {
  getBuiltinSkillCatalog,
  parseSkillDefinition,
  validateSkillSelection,
  type SkillSelectionSnapshot,
} from '@ecom-forge/skills';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AgentTranscriptCoreSkillBinding } from './agent-transcript-skill-binding.js';
import {
  prepareTranscriptCoreSkillContext,
  transcriptCoreSkillContextSchema,
  transcriptCoreSkillDependencies,
  transcriptSkillDependencySchema,
} from './agent-transcript-skill-context.js';
import { AgentTranscriptSkillResources } from './agent-transcript-skill-resources.js';

const uuid = (id: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${id.toString(16).padStart(12, '0')}`;
const userId = uuid(1),
  sessionId = uuid(2),
  turnId = uuid(3);

function fixture(input?: SkillSelectionSnapshot) {
  const resource = {
    resource_snapshot_id: uuid(4),
    package_resource_id: uuid(5),
    resource_path: 'SKILL.md',
    resource_hash: 'a'.repeat(64),
  };
  const definition = parseSkillDefinition({
    schema_version: 1,
    slug: 'transcript-fixture',
    version: '1.0.0',
    display_name: 'Test knowledge',
    description: 'Test fixture',
    kind: 'primary',
    visibility: 'public',
    domain: 'creative',
    category: 'creative',
    stage: '1a',
    planning_view: { path: 'SKILL.md', content_hash: resource.resource_hash },
  });
  const selection: SkillSelectionSnapshot = input ?? {
    primary_skill_id: 'transcript-fixture@1.0.0',
    primary_name: definition.display_name,
    primary_definition_hash: canonicalSha256(definition),
    primary_package_record_id: uuid(6),
    primary_planning_resource: resource,
    primary_reference_resources: [],
    required_capabilities: [],
    default_output_count: 1,
    catalog_release_id: uuid(7),
    catalog_version: 'b'.repeat(64),
    preset_selections: [],
    required_auxiliary: [],
    optional_auxiliary: [],
  };
  const manifest = {
    schema_version: 1,
    packages: [
      {
        package_record_id: selection.primary_package_record_id,
        validation_report_id: uuid(8),
        package_digest: 'c'.repeat(64),
        skills: [
          {
            skill_id: selection.primary_skill_id,
            definition_hash: selection.primary_definition_hash,
            resources: [
              {
                skill_resource_snapshot_id: resource.resource_snapshot_id,
                package_resource_id: resource.package_resource_id,
                resource_path: resource.resource_path,
                content_hash: resource.resource_hash,
              },
            ],
          },
        ],
      },
    ],
  };
  if (!input) selection.catalog_version = canonicalSha256(manifest);
  const context = prepareTranscriptCoreSkillContext(selection);
  const dependencies = transcriptCoreSkillDependencies(context);
  const item = prepareAgentTranscriptItem(
    {
      id: uuid(9),
      user_id: userId,
      session_id: sessionId,
      turn_id: turnId,
      continuation_no: 1,
      sequence_no: '2',
      schema_version: 1,
      item_type: 'host_context',
      source_key: `turn:${turnId}:continuation:1:core-skill`,
      source_message_id: null,
      source_trace_step_id: null,
      import_attempt_id: null,
      reply_to_item_id: null,
      call_ordinal: null,
      payload_json: {
        schema_version: 1,
        type: 'host_context',
        name: 'core_skill_knowledge@1',
        content: { type: 'inline', value: context },
      },
      resource_dependencies_json: dependencies,
      created_at: '2026-09-08T00:00:00.000Z',
    },
    {
      userMessage: { schema: z.never() },
      legacyMessage: { schema: z.never() },
      calls: [],
      hostContexts: [
        { name: 'core_skill_knowledge@1', content: { schema: transcriptCoreSkillContextSchema } },
      ],
      resourceDependencySchema: transcriptSkillDependencySchema,
    },
  ).item;
  const turn = {
    id: turnId,
    userId,
    sessionId,
    primarySkillId: selection.primary_skill_id,
    continuationNo: 1,
    skillSelectionSnapshotJson: selection,
    skillSelectionSnapshotHash: canonicalSha256(selection),
  };
  const release = {
    id: selection.catalog_release_id,
    status: 'published',
    releaseDigest: selection.catalog_version,
    manifestJson: manifest,
    publishedAt: new Date('2026-09-07T00:00:00.000Z'),
    rollbackOfReleaseId: null as string | null,
    releaseNo: 2,
  };
  const packageRow = {
    id: selection.primary_package_record_id,
    status: 'approved',
    packageDigest: 'c'.repeat(64),
    approvedValidationReportId: uuid(8),
    riskStatus: 'clear',
    riskReviewDueAt: null as Date | null,
    riskBlockedAt: null as Date | null,
    disabledAt: null as Date | null,
  };
  const report = {
    id: uuid(8),
    status: 'passed',
    packageRecordId: selection.primary_package_record_id,
    packageDigest: packageRow.packageDigest,
  };
  const skill = {
    id: selection.primary_skill_id,
    status: 'published',
    packageRecordId: selection.primary_package_record_id,
    definitionHash: selection.primary_definition_hash,
    definitionJson: definition,
  };
  const snapshot = {
    id: resource.resource_snapshot_id,
    skillId: selection.primary_skill_id,
    packageResourceId: resource.package_resource_id,
    resourcePath: resource.resource_path,
    contentHash: resource.resource_hash,
  };
  const packageResource = {
    id: resource.package_resource_id,
    skillId: selection.primary_skill_id,
    packageRecordId: selection.primary_package_record_id,
    contentHash: resource.resource_hash,
    mediaType: 'text/markdown',
  };
  const user = { id: userId, riskStatus: 'normal' };
  const clock = [{ now: '2026-09-08T00:00:00.000Z' }];
  const database = {
    query: {
      agentTurns: { findFirst: vi.fn().mockResolvedValue(turn) },
      users: { findFirst: vi.fn().mockResolvedValue(user) },
      skillCatalogReleases: { findMany: vi.fn().mockResolvedValue([release]) },
      skillPackages: { findMany: vi.fn().mockResolvedValue([packageRow]) },
      skillPackageValidationReports: { findMany: vi.fn().mockResolvedValue([report]) },
      skills: { findMany: vi.fn().mockResolvedValue([skill]) },
      skillResourceSnapshots: { findMany: vi.fn().mockResolvedValue([snapshot]) },
      skillPackageResources: { findMany: vi.fn().mockResolvedValue([packageResource]) },
    },
    select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue(clock) }),
  };
  const db = database as unknown as Pick<Database, 'query' | 'select'>;
  return {
    item,
    selection,
    context,
    dependencies,
    turn,
    user,
    release,
    packageRow,
    report,
    skill,
    snapshot,
    packageResource,
    clock,
    database,
    binding: new AgentTranscriptCoreSkillBinding(db),
    resources: new AgentTranscriptSkillResources(db),
  };
}

describe('core Skill transcript binding', () => {
  it('binds the real owned selection without reading any Skill body', async () => {
    const test = fixture();
    expect(await test.binding.verifySource(test.item)).toBe(true);
    expect(await test.binding.authorizeDependencies(test.item)).toBe(true);
    expect(test.database.query.skillResourceSnapshots.findMany.mock.calls[0]![0]).toMatchObject({
      columns: {
        id: true,
        skillId: true,
        packageResourceId: true,
        resourcePath: true,
        contentHash: true,
      },
    });
    const query = test.database.query.skillResourceSnapshots.findMany.mock.calls[0]![0] as {
      columns: Record<string, boolean>;
    };
    expect(query.columns).not.toHaveProperty('contentText');
  });

  it.each(['userId', 'sessionId', 'id', 'primarySkillId', 'skillSelectionSnapshotHash'] as const)(
    'rejects source drift at %s',
    async (key) => {
      const test = fixture();
      test.turn[key] = uuid(100);
      expect(await test.binding.verifySource(test.item)).toBe(false);
      expect(await test.binding.authorizeDependencies(test.item)).toBe(false);
      expect(test.database.query.skillResourceSnapshots.findMany).not.toHaveBeenCalled();
    },
  );

  it('does not rewrite a historical selection when a later continuation is current', async () => {
    const test = fixture();
    test.turn.continuationNo = 3;
    expect(await test.binding.verifySource(test.item)).toBe(true);
    test.turn.continuationNo = 0;
    expect(await test.binding.verifySource(test.item)).toBe(false);
  });

  it('rejects a changed selection even if its stored digest was not updated', async () => {
    const test = fixture();
    test.selection.primary_name = 'Other';
    expect(await test.binding.verifySource(test.item)).toBe(false);
  });

  it.each([
    { source_key: 'other' },
    { source_message_id: uuid(100) },
    { source_trace_step_id: uuid(100) },
    { import_attempt_id: uuid(100) },
    { item_type: 'legacy_message' as const },
    { turn_id: null },
  ])('rejects forged host provenance %j', async (patch) => {
    const test = fixture();
    expect(await test.binding.verifySource({ ...test.item, ...patch })).toBe(false);
  });

  it('requires the complete dependency set and refuses duplicate dependencies', async () => {
    const test = fixture();
    for (const dependencies of [[], [...test.dependencies, ...test.dependencies]]) {
      expect(
        await test.binding.authorizeDependencies({
          ...test.item,
          resource_dependencies_json: dependencies,
        }),
      ).toBe(false);
    }
  });

  it('rechecks user state before exposing global knowledge', async () => {
    const test = fixture();
    test.user.riskStatus = 'frozen';
    expect(await test.binding.authorizeDependencies(test.item)).toBe(false);
    expect(test.database.query.skillResourceSnapshots.findMany).not.toHaveBeenCalled();
  });

  it('preserves primary/Preset/required order and does not preload optional knowledge', () => {
    const test = fixture();
    const preset = {
      ...test.selection.primary_planning_resource,
      resource_snapshot_id: uuid(30),
      resource_path: 'presets/soft.md',
      slot: 'lighting',
      preset_id: 'soft@1.0.0',
      name: 'Soft light',
    };
    test.selection.preset_selections = [preset];
    test.selection.required_auxiliary = [
      {
        skill_id: 'auxiliary@1.0.0',
        name: 'Required knowledge',
        definition_hash: 'd'.repeat(64),
        package_record_id: uuid(31),
        planning_resource: {
          ...test.selection.primary_planning_resource,
          resource_snapshot_id: uuid(32),
        },
        reference_resources: [],
      },
    ];
    test.selection.optional_auxiliary = [
      { ...test.selection.required_auxiliary[0]!, skill_id: 'optional@1.0.0' },
    ];
    const context = prepareTranscriptCoreSkillContext(test.selection);
    expect(context.resources.map((entry) => entry.name)).toEqual([
      'Test knowledge',
      'Soft light',
      'Required knowledge',
    ]);
    expect(context.resources.some((entry) => entry.skill_id.startsWith('optional'))).toBe(false);
    test.selection.preset_selections[0]!.resource_path = '../secret.md';
    expect(() => prepareTranscriptCoreSkillContext(test.selection)).toThrow();
  });
});

describe('live historical Skill resource closure', () => {
  it('keeps historical reads valid after normal catalog retirement', async () => {
    const test = fixture();
    test.release.status = 'retired';
    expect(await test.binding.authorizeDependencies(test.item)).toBe(true);
  });

  it('validates the existing rollback-release digest algorithm', async () => {
    const test = fixture();
    test.release.rollbackOfReleaseId = uuid(80);
    test.release.releaseDigest = canonicalSha256({
      rollback_of_release_id: test.release.rollbackOfReleaseId,
      release_no: test.release.releaseNo,
      manifest: test.release.manifestJson,
    });
    expect(
      await test.resources.authorize(
        test.dependencies.map((entry) => ({
          ...entry,
          catalog_version: test.release.releaseDigest,
        })),
      ),
    ).toBe(true);
    test.release.releaseNo++;
    expect(
      await test.resources.authorize(
        test.dependencies.map((entry) => ({
          ...entry,
          catalog_version: test.release.releaseDigest,
        })),
      ),
    ).toBe(false);
  });

  it.each([
    [
      'disabled',
      (test: ReturnType<typeof fixture>) => {
        test.packageRow.status = 'disabled';
      },
    ],
    [
      'critical',
      (test: ReturnType<typeof fixture>) => {
        test.packageRow.riskStatus = 'critical';
      },
    ],
    [
      'blocked',
      (test: ReturnType<typeof fixture>) => {
        test.packageRow.riskBlockedAt = new Date();
      },
    ],
    [
      'disabled timestamp',
      (test: ReturnType<typeof fixture>) => {
        test.packageRow.disabledAt = new Date();
      },
    ],
    [
      'release draft',
      (test: ReturnType<typeof fixture>) => {
        test.release.status = 'draft';
      },
    ],
    [
      'release digest',
      (test: ReturnType<typeof fixture>) => {
        test.release.releaseDigest = 'e'.repeat(64);
      },
    ],
    [
      'manifest content',
      (test: ReturnType<typeof fixture>) => {
        test.release.manifestJson.packages[0]!.package_digest = 'e'.repeat(64);
      },
    ],
    [
      'package digest',
      (test: ReturnType<typeof fixture>) => {
        test.packageRow.packageDigest = 'e'.repeat(64);
      },
    ],
    [
      'approval report',
      (test: ReturnType<typeof fixture>) => {
        test.report.status = 'failed';
      },
    ],
    [
      'report package',
      (test: ReturnType<typeof fixture>) => {
        test.report.packageRecordId = uuid(100);
      },
    ],
    [
      'Skill status',
      (test: ReturnType<typeof fixture>) => {
        test.skill.status = 'disabled';
      },
    ],
    [
      'Skill definition',
      (test: ReturnType<typeof fixture>) => {
        test.skill.definitionJson.description = 'Changed';
      },
    ],
    [
      'snapshot hash',
      (test: ReturnType<typeof fixture>) => {
        test.snapshot.contentHash = 'e'.repeat(64);
      },
    ],
    [
      'snapshot path',
      (test: ReturnType<typeof fixture>) => {
        test.snapshot.resourcePath = 'references/other.md';
      },
    ],
    [
      'snapshot Skill',
      (test: ReturnType<typeof fixture>) => {
        test.snapshot.skillId = 'other@1.0.0';
      },
    ],
    [
      'resource package',
      (test: ReturnType<typeof fixture>) => {
        test.packageResource.packageRecordId = uuid(100);
      },
    ],
    [
      'resource MIME',
      (test: ReturnType<typeof fixture>) => {
        test.packageResource.mediaType = 'text/html';
      },
    ],
    [
      'missing database time',
      (test: ReturnType<typeof fixture>) => {
        test.clock.length = 0;
      },
    ],
  ] as const)('rejects %s on a fresh authorization pass', async (_label, mutate) => {
    const test = fixture();
    expect(await test.binding.authorizeDependencies(test.item)).toBe(true);
    mutate(test);
    expect(await test.binding.authorizeDependencies(test.item)).toBe(false);
  });

  it('uses database time at the review deadline, without requiring the sweeper', async () => {
    const test = fixture();
    test.packageRow.riskStatus = 'needs_review';
    test.packageRow.riskReviewDueAt = new Date('2026-09-08T00:00:00.001Z');
    expect(await test.binding.authorizeDependencies(test.item)).toBe(true);
    test.clock[0]!.now = '2026-09-08T00:00:00.001Z';
    expect(await test.binding.authorizeDependencies(test.item)).toBe(false);
    test.packageRow.riskReviewDueAt = null;
    expect(await test.binding.authorizeDependencies(test.item)).toBe(false);
  });

  it('fails closed on storage exceptions and missing referenced rows', async () => {
    const test = fixture();
    test.database.query.skillResourceSnapshots.findMany.mockRejectedValueOnce(new Error('offline'));
    expect(await test.binding.authorizeDependencies(test.item)).toBe(false);
    test.database.query.skillPackageValidationReports.findMany.mockResolvedValue([]);
    expect(await test.binding.authorizeDependencies(test.item)).toBe(false);
  });

  it('uses real built-in catalog identities and never falls back to external rows on drift', async () => {
    const catalog = await getBuiltinSkillCatalog();
    const builtin = catalog.skills.find(
      (entry) => entry.definition.kind === 'primary' && entry.definition.preset_slots.length === 0,
    )!;
    expect(builtin).toBeDefined();
    const selection = validateSkillSelection({
      selection: { primary_skill_id: builtin.skillId, preset_selections: [] },
      definition: builtin.definition,
      definitionHash: builtin.definitionHash,
      packageRecordId: builtin.packageRecordId,
      planningResource: builtin.resources.get('SKILL.md')!,
      catalogReleaseId: builtin.catalogReleaseId,
      catalogVersion: builtin.catalogVersion,
      dependencySnapshots: new Map(
        builtin.definition.dependencies.map((dependency) => {
          const auxiliary = catalog.skills.find((entry) => entry.skillId === dependency.skill_id)!;
          return [
            dependency.skill_id,
            {
              skill_id: auxiliary.skillId,
              name: auxiliary.definition.display_name,
              definition_hash: auxiliary.definitionHash,
              package_record_id: auxiliary.packageRecordId,
              planning_resource: auxiliary.resources.get('SKILL.md')!,
              reference_resources: auxiliary.definition.references.map((reference) =>
                auxiliary.resources.get(reference.path)!,
              ),
            },
          ];
        }),
      ),
      resourceSnapshots: builtin.resources,
    }).snapshot;
    const test = fixture(selection);
    expect(await test.binding.authorizeDependencies(test.item)).toBe(true);
    expect(
      await test.resources.authorize(
        test.dependencies.map((entry) => ({
          ...entry,
          catalog_version: 'f'.repeat(64),
          catalog_release_id: uuid(101),
        })),
      ),
    ).toBe(true);
    for (const patch of [
      { resource_hash: 'f'.repeat(64) },
      { definition_hash: 'f'.repeat(64) },
      { package_record_id: uuid(101) },
      { skill_id: `${builtin.definition.slug}@9999.0.0` },
    ]) {
      expect(
        await test.resources.authorize(test.dependencies.map((entry) => ({ ...entry, ...patch }))),
      ).toBe(false);
    }
    expect(test.database.query.skillCatalogReleases.findMany).not.toHaveBeenCalled();
    expect(test.database.query.skillResourceSnapshots.findMany).not.toHaveBeenCalled();
  });
});
