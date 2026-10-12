import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  desc,
  eq,
  inArray,
  skillCatalogReleases,
  skillCatalogState,
  skillPackageValidationReports,
  skillPackages,
  skillResourceSnapshots,
  skills,
  sql,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';
import {
  parseSkillCatalogReleaseManifest,
  parseSkillDefinition,
  type SkillCatalogReleaseManifest,
} from '@ecom-forge/skills';

import type { AppEnvironment } from '../../config/app-config.js';
import {
  isAuthorizedSkillPackageActor,
  skillPackageActorRef,
  skillPackageAuditActor,
  type SkillPackageActor,
} from './skill-package-actor.js';

export class SkillCatalogReleaseError extends Error {
  constructor(
    readonly code:
      | 'SKILL_CATALOG_RELEASE_FORBIDDEN'
      | 'SKILL_CATALOG_RELEASE_INVALID'
      | 'SKILL_CATALOG_RELEASE_CONFLICT',
  ) {
    super(code);
    this.name = 'SkillCatalogReleaseError';
  }
}

interface ReleaseActorInput {
  actor: SkillPackageActor;
  reason: string;
}

type ReleaseReadContext = Pick<Database, 'query' | 'select'>;

function assertActor(input: ReleaseActorInput, appEnv: AppEnvironment): void {
  if (!isAuthorizedSkillPackageActor(input.actor, appEnv)) {
    throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_FORBIDDEN');
  }
  if (!input.reason.trim()) throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
}

export class SkillCatalogReleaseService {
  constructor(
    private readonly database: Database,
    private readonly appEnv: AppEnvironment,
  ) {}

  async createDraft(input: ReleaseActorInput & { packageRecordIds: string[] }): Promise<{
    releaseId: string;
    releaseNo: number;
    releaseDigest: string;
    reused: boolean;
  }> {
    assertActor(input, this.appEnv);
    const packageRecordIds = [...new Set(input.packageRecordIds)].sort();
    if (
      packageRecordIds.length === 0 ||
      packageRecordIds.length !== input.packageRecordIds.length
    ) {
      throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
    }
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-catalog-release', 'global')})`,
      );
      const manifest = await this.buildManifest(transaction, packageRecordIds);
      const releaseDigest = canonicalSha256(manifest);
      const existing = await transaction.query.skillCatalogReleases.findFirst({
        where: eq(skillCatalogReleases.releaseDigest, releaseDigest),
      });
      if (existing) {
        return {
          releaseId: existing.id,
          releaseNo: existing.releaseNo,
          releaseDigest,
          reused: true,
        };
      }
      const [latest] = await transaction
        .select({ releaseNo: skillCatalogReleases.releaseNo })
        .from(skillCatalogReleases)
        .orderBy(desc(skillCatalogReleases.releaseNo))
        .limit(1);
      const state = await transaction.query.skillCatalogState.findFirst({
        where: eq(skillCatalogState.id, 'global'),
      });
      const releaseId = randomUUID();
      const releaseNo = (latest?.releaseNo ?? 0) + 1;
      await transaction.insert(skillCatalogReleases).values({
        id: releaseId,
        releaseNo,
        status: 'draft',
        baseReleaseId: state?.activeReleaseId,
        releaseDigest,
        manifestJson: manifest,
        reason: input.reason,
        createdBy: skillPackageActorRef(input.actor),
      });
      await transaction.insert(adminAuditLogs).values({
        ...skillPackageAuditActor(input.actor),
        action: 'skill_catalog_release.create_draft',
        targetType: 'skill_catalog_release',
        targetId: releaseId,
        afterJson: {
          release_no: releaseNo,
          release_digest: releaseDigest,
          package_count: manifest.packages.length,
        },
        reason: input.reason,
        result: 'succeeded',
      });
      return { releaseId, releaseNo, releaseDigest, reused: false };
    });
  }

  async publish(
    input: ReleaseActorInput & {
      releaseId: string;
      expectedReleaseRevision: number;
      expectedCatalogRevision: number;
    },
  ): Promise<{ releaseId: string; catalogRevision: number; reused: boolean }> {
    assertActor(input, this.appEnv);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-catalog-publish', 'global')})`,
      );
      const release = await transaction.query.skillCatalogReleases.findFirst({
        where: eq(skillCatalogReleases.id, input.releaseId),
      });
      if (!release) throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
      const state = await transaction.query.skillCatalogState.findFirst({
        where: eq(skillCatalogState.id, 'global'),
      });
      const catalogRevision = state?.revision ?? 0;
      if (
        release.status !== 'draft' ||
        release.revision !== input.expectedReleaseRevision ||
        catalogRevision !== input.expectedCatalogRevision
      ) {
        throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_CONFLICT');
      }
      const manifest = parseSkillCatalogReleaseManifest(release.manifestJson);
      await this.assertManifestCurrent(transaction, manifest);
      const now = new Date();
      if (state?.activeReleaseId) {
        await transaction
          .update(skillCatalogReleases)
          .set({
            status: 'retired',
            revision: sql`${skillCatalogReleases.revision} + 1`,
            retiredAt: now,
          })
          .where(
            and(
              eq(skillCatalogReleases.id, state.activeReleaseId),
              eq(skillCatalogReleases.status, 'published'),
            ),
          );
      }
      const [published] = await transaction
        .update(skillCatalogReleases)
        .set({
          status: 'published',
          revision: release.revision + 1,
          approvedBy: skillPackageActorRef(input.actor),
          publishedAt: now,
        })
        .where(
          and(
            eq(skillCatalogReleases.id, release.id),
            eq(skillCatalogReleases.status, 'draft'),
            eq(skillCatalogReleases.revision, release.revision),
          ),
        )
        .returning({ id: skillCatalogReleases.id });
      if (!published) throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_CONFLICT');
      const nextCatalogRevision = catalogRevision + 1;
      if (state) {
        const [updated] = await transaction
          .update(skillCatalogState)
          .set({ activeReleaseId: release.id, revision: nextCatalogRevision })
          .where(
            and(
              eq(skillCatalogState.id, 'global'),
              eq(skillCatalogState.revision, input.expectedCatalogRevision),
            ),
          )
          .returning({ id: skillCatalogState.id });
        if (!updated) throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_CONFLICT');
      } else {
        if (input.expectedCatalogRevision !== 0) {
          throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_CONFLICT');
        }
        await transaction.insert(skillCatalogState).values({
          id: 'global',
          activeReleaseId: release.id,
          revision: nextCatalogRevision,
        });
      }
      const skillIds = manifest.packages.flatMap((item) =>
        item.skills.map((skill) => skill.skill_id),
      );
      await transaction
        .update(skills)
        .set({ status: 'published', publishedAt: now })
        .where(inArray(skills.id, skillIds));
      await transaction.insert(adminAuditLogs).values({
        ...skillPackageAuditActor(input.actor),
        action: 'skill_catalog_release.publish',
        targetType: 'skill_catalog_release',
        targetId: release.id,
        afterJson: {
          release_no: release.releaseNo,
          release_digest: release.releaseDigest,
          catalog_revision: nextCatalogRevision,
        },
        reason: input.reason,
        result: 'succeeded',
      });
      return { releaseId: release.id, catalogRevision: nextCatalogRevision, reused: false };
    });
  }

  async createRollbackDraft(input: ReleaseActorInput & { targetReleaseId: string }) {
    assertActor(input, this.appEnv);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-catalog-release', 'global')})`,
      );
      const target = await transaction.query.skillCatalogReleases.findFirst({
        where: eq(skillCatalogReleases.id, input.targetReleaseId),
      });
      if (!target || !['published', 'retired'].includes(target.status)) {
        throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
      }
      const manifest = parseSkillCatalogReleaseManifest(target.manifestJson);
      await this.assertManifestCurrent(transaction, manifest);
      const [latest] = await transaction
        .select({ releaseNo: skillCatalogReleases.releaseNo })
        .from(skillCatalogReleases)
        .orderBy(desc(skillCatalogReleases.releaseNo))
        .limit(1);
      const state = await transaction.query.skillCatalogState.findFirst({
        where: eq(skillCatalogState.id, 'global'),
      });
      const releaseId = randomUUID();
      const releaseNo = (latest?.releaseNo ?? 0) + 1;
      const releaseDigest = canonicalSha256({
        rollback_of_release_id: target.id,
        release_no: releaseNo,
        manifest,
      });
      await transaction.insert(skillCatalogReleases).values({
        id: releaseId,
        releaseNo,
        status: 'draft',
        baseReleaseId: state?.activeReleaseId,
        rollbackOfReleaseId: target.id,
        releaseDigest,
        manifestJson: manifest,
        reason: input.reason,
        createdBy: skillPackageActorRef(input.actor),
      });
      await transaction.insert(adminAuditLogs).values({
        ...skillPackageAuditActor(input.actor),
        action: 'skill_catalog_release.create_rollback',
        targetType: 'skill_catalog_release',
        targetId: releaseId,
        afterJson: {
          release_no: releaseNo,
          release_digest: releaseDigest,
          rollback_of_release_id: target.id,
        },
        reason: input.reason,
        result: 'succeeded',
      });
      return { releaseId, releaseNo, releaseDigest, rollbackOfReleaseId: target.id };
    });
  }

  private async buildManifest(
    database: ReleaseReadContext,
    packageRecordIds: string[],
  ): Promise<SkillCatalogReleaseManifest> {
    const packages = await database
      .select()
      .from(skillPackages)
      .where(inArray(skillPackages.id, packageRecordIds));
    if (packages.length !== packageRecordIds.length) {
      throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
    }
    const entries: SkillCatalogReleaseManifest['packages'] = [];
    const allSkillIds = new Set<string>();
    for (const packageRecord of [...packages].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      if (
        packageRecord.status !== 'approved' ||
        packageRecord.riskStatus !== 'clear' ||
        packageRecord.riskReviewDueAt ||
        packageRecord.riskBlockedAt ||
        packageRecord.disabledAt ||
        !packageRecord.packageDigest ||
        !packageRecord.approvedValidationReportId ||
        !packageRecord.latestValidationReportId
      ) {
        throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
      }
      const report = await database.query.skillPackageValidationReports.findFirst({
        where: eq(skillPackageValidationReports.id, packageRecord.approvedValidationReportId),
      });
      const latestReport = await database.query.skillPackageValidationReports.findFirst({
        where: eq(skillPackageValidationReports.id, packageRecord.latestValidationReportId),
      });
      if (
        !report ||
        report.packageRecordId !== packageRecord.id ||
        report.status !== 'passed' ||
        report.packageDigest !== packageRecord.packageDigest ||
        !latestReport ||
        latestReport.packageRecordId !== packageRecord.id ||
        latestReport.status !== 'passed' ||
        latestReport.packageDigest !== packageRecord.packageDigest
      ) {
        throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
      }
      const skillRows = await database.query.skills.findMany({
        where: eq(skills.packageRecordId, packageRecord.id),
      });
      if (skillRows.length === 0)
        throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
      const skillEntries = [];
      for (const row of [...skillRows].sort((left, right) => left.id.localeCompare(right.id))) {
        if (!row.definitionHash || !row.skillDigest || allSkillIds.has(row.id)) {
          throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
        }
        const definition = parseSkillDefinition(row.definitionJson);
        if (canonicalSha256(definition) !== row.definitionHash) {
          throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
        }
        allSkillIds.add(row.id);
        const snapshots = await database.query.skillResourceSnapshots.findMany({
          where: eq(skillResourceSnapshots.skillId, row.id),
        });
        if (
          snapshots.length === 0 ||
          snapshots.some((snapshot) => !snapshot.packageResourceId || !snapshot.contentText)
        ) {
          throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
        }
        skillEntries.push({
          skill_id: row.id,
          definition_hash: row.definitionHash,
          resources: snapshots
            .map((snapshot) => ({
              skill_resource_snapshot_id: snapshot.id,
              package_resource_id: snapshot.packageResourceId!,
              resource_path: snapshot.resourcePath,
              content_hash: snapshot.contentHash,
            }))
            .sort((left, right) => left.resource_path.localeCompare(right.resource_path)),
        });
      }
      entries.push({
        package_record_id: packageRecord.id,
        validation_report_id: report.id,
        package_digest: packageRecord.packageDigest,
        skills: skillEntries,
      });
    }
    const manifest = parseSkillCatalogReleaseManifest({ schema_version: 1, packages: entries });
    const definitions = await database
      .select({ id: skills.id, definitionJson: skills.definitionJson })
      .from(skills)
      .where(inArray(skills.id, [...allSkillIds]));
    for (const row of definitions) {
      const definition = parseSkillDefinition(row.definitionJson);
      if (definition.dependencies.some((dependency) => !allSkillIds.has(dependency.skill_id))) {
        throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
      }
    }
    return manifest;
  }

  private async assertManifestCurrent(
    database: ReleaseReadContext,
    manifest: SkillCatalogReleaseManifest,
  ) {
    const rebuilt = await this.buildManifest(
      database,
      manifest.packages.map((item) => item.package_record_id),
    );
    if (canonicalSha256(rebuilt) !== canonicalSha256(manifest)) {
      throw new SkillCatalogReleaseError('SKILL_CATALOG_RELEASE_INVALID');
    }
  }
}
