import { createHash, randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  createDatabaseClient,
  eq,
  inArray,
  queueDispatchIntents,
  skillCatalogReleases,
  skillCatalogState,
  skillPackageResources,
  skillPackages,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
} from '@ecom-forge/db';
import { canonicalSha256, utf8Sha256 } from '@ecom-forge/shared';
import type { SkillPackageManifest } from '@ecom-forge/skills';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  MemorySkillPackageContentReader,
  SkillPackageApprovalService,
} from '../src/modules/skill-package/skill-package-approval.service.js';
import { SkillCatalogReleaseService } from '../src/modules/skill-package/skill-catalog-release.service.js';
import {
  SkillPackageInstallError,
  SkillPackageInstallService,
  type QuarantinedResourceInput,
} from '../src/modules/skill-package/skill-package-install.service.js';
import { SkillCatalogService } from '../src/modules/agent/skill-catalog.service.js';

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://ecom_forge:ecom_forge_dev@127.0.0.1:5432/ecom_forge_test';
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').toLowerCase();
if (!/_test(?:_|$)/.test(databaseName)) {
  throw new Error('S08 Skill package tests require a database name containing _test');
}

const resource = createDatabaseClient({ databaseUrl, maxConnections: 20 });
const trackedPackages = new Set<string>();
const trackedReleases = new Set<string>();

function fixture(suffix = randomUUID()) {
  const packageId = `s08-package-${suffix.slice(0, 8)}`;
  const skillSlug = `s08-skill-${suffix.slice(0, 8)}`;
  const skillId = `${skillSlug}@1.0.0`;
  const definitionPath = `skill-package/skills/${skillSlug}/SKILL.md`;
  const evaluationPath = `skill-package/evals/${skillSlug}.jsonl`;
  const content = `---
schema_version: 1
slug: ${skillSlug}
version: 1.0.0
display_name: S08 Package Fixture
description: A deterministic primary Skill used for package lifecycle integration tests.
kind: primary
category: test
domain: creative
stage: 1A
required_inputs: []
required_capabilities: []
preset_slots: []
references: []
---
Create a concise and safe image direction from the user's request.
`;
  const evaluation = `${[
    ['success', 'plan'],
    ['missing_fact', 'clarify'],
    ['skill_mismatch', 'suggest_switch'],
    ['material_role_drift', 'block'],
    ['prompt_injection', 'block'],
  ]
    .map(([category, decision]) =>
      JSON.stringify({
        case_id: `${skillSlug}-${category?.replaceAll('_', '-')}`,
        category,
        request: `Fixture ${category} request`,
        context: {},
        expected: { decision, required_checks: ['fact-check'], forbidden: [] },
      }),
    )
    .join('\n')}\n`;
  const contentHash = utf8Sha256(content);
  const evaluationHash = utf8Sha256(evaluation);
  const manifest: SkillPackageManifest = {
    schema_version: 1 as const,
    package_id: packageId,
    package_version: '1.0.0',
    min_runtime_version: '1.0.0',
    skills: [{ skill_id: skillId, definition_path: definitionPath, definition_hash: contentHash }],
    skill_profiles: {
      [skillId]: {
        slug: skillSlug,
        version: '1.0.0',
        display_name: 'S08 Package Fixture',
        kind: 'primary',
        category: 'test',
        domain: 'creative',
        stage: '1A',
        sort_order: 0,
        required_inputs: [],
        required_facts: [],
        required_capabilities: [],
        default_output_count: 1,
        catalog: { visibility: 'public' },
        preset_slots: [],
        dependencies: [],
        references: [],
      },
    },
    resources: [
      {
        path: definitionPath,
        purpose: 'skill definition',
        media_type: 'text/markdown' as const,
        byte_size: Buffer.byteLength(content),
        content_hash: contentHash,
      },
      {
        path: evaluationPath,
        purpose: 'golden evaluation dataset',
        media_type: 'application/jsonl' as const,
        byte_size: Buffer.byteLength(evaluation),
        content_hash: evaluationHash,
      },
    ],
    eval_datasets: [evaluationPath],
    assets: [],
    source_provenance: {
      type: 'first_party' as const,
      summary_digest: canonicalSha256({ source: packageId }),
    },
    license_summary: [
      { path: definitionPath, license: 'Proprietary', rights_holder: 'ecom-forge' },
      { path: evaluationPath, license: 'Proprietary', rights_holder: 'ecom-forge' },
    ],
  };
  const storageKey = `s08-test/${packageId}/${definitionPath}`;
  const evaluationStorageKey = `s08-test/${packageId}/${evaluationPath}`;
  const resources: QuarantinedResourceInput[] = [
    {
      path: definitionPath,
      mediaType: 'text/markdown',
      byteSize: Buffer.byteLength(content),
      contentHash,
      storageKey,
      skillId,
      rightsMetadata: { source: 'first_party' },
    },
    {
      path: evaluationPath,
      mediaType: 'application/jsonl',
      byteSize: Buffer.byteLength(evaluation),
      contentHash: evaluationHash,
      storageKey: evaluationStorageKey,
      rightsMetadata: { source: 'first_party' },
    },
  ];
  return {
    skillId,
    content,
    manifest,
    archiveSha256: canonicalSha256({ archive: packageId }),
    quarantineStorageKey: `s08-test/${packageId}.skillpkg`,
    uploadExpiresAt: new Date(Date.now() + 60_000),
    platformEvalSuiteDigest: canonicalSha256({ eval_suite: 1 }),
    resources,
    storage: new Map([
      [storageKey, Buffer.from(content, 'utf8')],
      [evaluationStorageKey, Buffer.from(evaluation, 'utf8')],
    ]),
    actor: { actorType: 'bootstrap_cli' as const },
  };
}

async function cleanup(): Promise<void> {
  if (trackedReleases.size > 0) {
    await resource.db
      .update(skillCatalogState)
      .set({ activeReleaseId: null })
      .where(inArray(skillCatalogState.activeReleaseId, [...trackedReleases]));
    await resource.db
      .delete(adminAuditLogs)
      .where(inArray(adminAuditLogs.targetId, [...trackedReleases]));
    await resource.db
      .delete(skillCatalogReleases)
      .where(inArray(skillCatalogReleases.id, [...trackedReleases]));
    trackedReleases.clear();
  }
  for (const packageRecordId of trackedPackages) {
    const reports = await resource.db.query.skillPackageValidationReports.findMany({
      where: eq(skillPackageValidationReports.packageRecordId, packageRecordId),
      columns: { id: true, queueIntentId: true },
    });
    await resource.db.delete(adminAuditLogs).where(eq(adminAuditLogs.targetId, packageRecordId));
    for (const report of reports) {
      await resource.db.delete(adminAuditLogs).where(eq(adminAuditLogs.targetId, report.id));
    }
    await resource.db
      .update(skillPackages)
      .set({ latestValidationReportId: null, approvedValidationReportId: null })
      .where(eq(skillPackages.id, packageRecordId));
    await resource.db
      .update(skillPackageValidationReports)
      .set({ queueIntentId: null })
      .where(eq(skillPackageValidationReports.packageRecordId, packageRecordId));
    await resource.db
      .delete(skillPackageValidationReports)
      .where(eq(skillPackageValidationReports.packageRecordId, packageRecordId));
    for (const report of reports) {
      if (report.queueIntentId) {
        await resource.db
          .delete(queueDispatchIntents)
          .where(eq(queueDispatchIntents.id, report.queueIntentId));
      }
    }
    const packageSkills = await resource.db.query.skills.findMany({
      where: eq(skills.packageRecordId, packageRecordId),
      columns: { id: true },
    });
    if (packageSkills.length > 0) {
      const skillIds = packageSkills.map((skill) => skill.id);
      await resource.db
        .delete(skillResourceSnapshots)
        .where(inArray(skillResourceSnapshots.skillId, skillIds));
      await resource.db.delete(skills).where(inArray(skills.id, skillIds));
    }
    await resource.db
      .delete(skillPackageResources)
      .where(eq(skillPackageResources.packageRecordId, packageRecordId));
    await resource.db.delete(skillPackages).where(eq(skillPackages.id, packageRecordId));
  }
  trackedPackages.clear();
}

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await resource.client.end();
});

describe('S08 Skill package install integration', () => {
  it('creates exactly one package, report and v2 intent under concurrent installs', async () => {
    const service = new SkillPackageInstallService(resource.db, 'test');
    const input = fixture();
    const results = await Promise.all([service.install(input), service.install(input)]);
    const first = results[0];
    trackedPackages.add(first.packageRecordId);
    expect(results.map((item) => item.packageRecordId)).toEqual([
      first.packageRecordId,
      first.packageRecordId,
    ]);
    expect(results.map((item) => item.reused).sort()).toEqual([false, true]);
    const [packages, reports, intents, audits] = await Promise.all([
      resource.db.query.skillPackages.findMany({
        where: eq(skillPackages.id, first.packageRecordId),
      }),
      resource.db.query.skillPackageValidationReports.findMany({
        where: eq(skillPackageValidationReports.packageRecordId, first.packageRecordId),
      }),
      resource.db.query.queueDispatchIntents.findMany({
        where: eq(queueDispatchIntents.aggregateId, first.validationReportId),
      }),
      resource.db.query.adminAuditLogs.findMany({
        where: eq(adminAuditLogs.targetId, first.packageRecordId),
      }),
    ]);
    expect(packages).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(intents).toHaveLength(1);
    const intent = intents[0];
    expect(intent).toMatchObject({ queueName: 'evaluation', payloadVersion: 2 });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(intent?.payload)).not.toContain('storage');
    expect(JSON.stringify(audits[0])).not.toContain(input.quarantineStorageKey);
  });

  it('rejects identity conflicts and non-local installation', async () => {
    const service = new SkillPackageInstallService(resource.db, 'test');
    const input = fixture();
    const installed = await service.install(input);
    trackedPackages.add(installed.packageRecordId);
    const changed = fixture();
    changed.manifest.package_id = input.manifest.package_id;
    changed.manifest.package_version = input.manifest.package_version;
    await expect(service.install(changed)).rejects.toMatchObject({
      code: 'SKILL_PACKAGE_IDENTITY_CONFLICT',
    });
    await expect(
      new SkillPackageInstallService(resource.db, 'production').install(fixture()),
    ).rejects.toBeInstanceOf(SkillPackageInstallError);
  });

  it('keeps image assets quarantined until metadata-stripping publication exists', async () => {
    const input = fixture();
    const imagePath = 'skill-package/assets/cover.png';
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const imageHash = createHash('sha256').update(image).digest('hex');
    const imageStorageKey = `s08-test/${input.manifest.package_id}/${imagePath}`;
    input.manifest.resources.push({
      path: imagePath,
      purpose: 'catalog cover',
      media_type: 'image/png',
      byte_size: image.byteLength,
      content_hash: imageHash,
    });
    input.manifest.assets.push(imagePath);
    input.manifest.license_summary.push({
      path: imagePath,
      license: 'Proprietary',
      rights_holder: 'ecom-forge',
    });
    input.resources.push({
      path: imagePath,
      mediaType: 'image/png',
      byteSize: image.byteLength,
      contentHash: imageHash,
      storageKey: imageStorageKey,
      rightsMetadata: { source: 'first_party' },
    });
    input.storage.set(imageStorageKey, image);

    const installed = await new SkillPackageInstallService(resource.db, 'test').install(input);
    trackedPackages.add(installed.packageRecordId);
    await resource.db
      .update(skillPackageValidationReports)
      .set({
        status: 'passed',
        reportJson: { schema_version: 1, result: 'passed' },
        reportDigest: canonicalSha256({ result: 'passed', package: installed.packageDigest }),
        completedAt: new Date(),
      })
      .where(eq(skillPackageValidationReports.id, installed.validationReportId));
    await resource.db
      .update(skillPackages)
      .set({ status: 'ready_for_review' })
      .where(eq(skillPackages.id, installed.packageRecordId));

    await expect(
      new SkillPackageApprovalService(
        resource.db,
        'test',
        new MemorySkillPackageContentReader(input.storage),
      ).approve({
        packageRecordId: installed.packageRecordId,
        validationReportId: installed.validationReportId,
        expectedPackageRevision: 1,
        reason: 'S08 image publication boundary',
        actor: input.actor,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_PACKAGE_APPROVAL_INVALID' });
    await expect(
      resource.db.query.skills.findMany({
        where: eq(skills.packageRecordId, installed.packageRecordId),
      }),
    ).resolves.toHaveLength(0);
  });

  it('approves immutable snapshots, publishes one concurrent winner, and rolls back with a new release', async () => {
    const input = fixture();
    const installed = await new SkillPackageInstallService(resource.db, 'test').install(input);
    trackedPackages.add(installed.packageRecordId);
    const reportDigest = canonicalSha256({ result: 'passed', package: installed.packageDigest });
    await resource.db
      .update(skillPackageValidationReports)
      .set({
        status: 'passed',
        reportJson: {
          schema_version: 1,
          result: 'passed',
          severity: 'clear',
          rule_id: 'SKILL_PACKAGE_VALID',
          summary: { skill_count: 1 },
        },
        reportDigest,
        completedAt: new Date(),
      })
      .where(eq(skillPackageValidationReports.id, installed.validationReportId));
    await resource.db
      .update(skillPackages)
      .set({ status: 'ready_for_review' })
      .where(eq(skillPackages.id, installed.packageRecordId));

    const approval = new SkillPackageApprovalService(
      resource.db,
      'test',
      new MemorySkillPackageContentReader(input.storage),
    );
    const approvals = await Promise.all([
      approval.approve({
        packageRecordId: installed.packageRecordId,
        validationReportId: installed.validationReportId,
        expectedPackageRevision: 1,
        reason: 'S08 lifecycle integration',
        actor: input.actor,
      }),
      approval.approve({
        packageRecordId: installed.packageRecordId,
        validationReportId: installed.validationReportId,
        expectedPackageRevision: 1,
        reason: 'S08 lifecycle integration',
        actor: input.actor,
      }),
    ]);
    expect(approvals.map((result) => result.reused).sort()).toEqual([false, true]);
    const snapshots = await resource.db.query.skillResourceSnapshots.findMany({
      where: eq(skillResourceSnapshots.skillId, input.skillId),
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ resourcePath: 'SKILL.md', contentText: input.content });

    const previousState = await resource.db.query.skillCatalogState.findFirst({
      where: eq(skillCatalogState.id, 'global'),
    });
    const previousRelease = previousState?.activeReleaseId
      ? await resource.db.query.skillCatalogReleases.findFirst({
          where: eq(skillCatalogReleases.id, previousState.activeReleaseId),
        })
      : undefined;
    const releases = new SkillCatalogReleaseService(resource.db, 'test');
    try {
      const draft = await releases.createDraft({
        packageRecordIds: [installed.packageRecordId],
        reason: 'S08 lifecycle integration',
        actor: input.actor,
      });
      trackedReleases.add(draft.releaseId);
      const expectedCatalogRevision = previousState?.revision ?? 0;
      const publishResults = await Promise.allSettled([
        releases.publish({
          releaseId: draft.releaseId,
          expectedReleaseRevision: 1,
          expectedCatalogRevision,
          reason: 'S08 lifecycle integration',
          actor: input.actor,
        }),
        releases.publish({
          releaseId: draft.releaseId,
          expectedReleaseRevision: 1,
          expectedCatalogRevision,
          reason: 'S08 lifecycle integration',
          actor: input.actor,
        }),
      ]);
      expect(publishResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(publishResults.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const catalog = await new SkillCatalogService(resource.db).list();
      expect(catalog.items.map((item) => item.primary_skill_id)).toContain(input.skillId);

      const rollback = await releases.createRollbackDraft({
        targetReleaseId: draft.releaseId,
        reason: 'S08 rollback integration',
        actor: input.actor,
      });
      trackedReleases.add(rollback.releaseId);
      expect(rollback.releaseNo).toBeGreaterThan(draft.releaseNo);
      await expect(
        releases.publish({
          releaseId: rollback.releaseId,
          expectedReleaseRevision: 1,
          expectedCatalogRevision: expectedCatalogRevision + 1,
          reason: 'S08 rollback integration',
          actor: input.actor,
        }),
      ).resolves.toMatchObject({ catalogRevision: expectedCatalogRevision + 2 });
      const original = await resource.db.query.skillCatalogReleases.findFirst({
        where: eq(skillCatalogReleases.id, draft.releaseId),
      });
      expect(original?.status).toBe('retired');
    } finally {
      if (previousState) {
        await resource.db
          .update(skillCatalogState)
          .set({
            activeReleaseId: previousState.activeReleaseId,
            revision: previousState.revision,
            updatedAt: previousState.updatedAt,
          })
          .where(eq(skillCatalogState.id, 'global'));
      } else {
        await resource.db.delete(skillCatalogState).where(eq(skillCatalogState.id, 'global'));
      }
      if (previousRelease) {
        await resource.db
          .update(skillCatalogReleases)
          .set({
            status: previousRelease.status,
            revision: previousRelease.revision,
            publishedAt: previousRelease.publishedAt,
            retiredAt: previousRelease.retiredAt,
          })
          .where(eq(skillCatalogReleases.id, previousRelease.id));
      }
    }
  });
});
