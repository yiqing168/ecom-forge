import {
  inArray,
  skillCatalogReleases,
  skillPackages,
  skillPackageResources,
  skillPackageValidationReports,
  skillResourceSnapshots,
  skills,
  sql,
  type Database,
} from '@ecom-forge/db';
import { canonicalJson, canonicalSha256 } from '@ecom-forge/shared';
import {
  parseSkillCatalogReleaseManifest,
  parseSkillDefinition,
  resolveBuiltinSkill,
} from '@ecom-forge/skills';

import {
  transcriptSkillDependencySchema,
  type TranscriptSkillDependency,
} from './agent-transcript-skill-context.js';
import type { AgentReadQuery } from './agent-turn.types.js';
import {
  authorizeHistoricalBuiltinDependency,
  type TranscriptHistoryScope,
} from './agent-transcript-builtin-history.js';

/** Metadata authorization for bound history, not current execution or body materialization. */
export class AgentTranscriptSkillResources {
  constructor(
    private readonly database: Pick<Database, 'query' | 'select'>,
    private readonly read: AgentReadQuery = async (build) => build(),
  ) {}

  async authorize(raw: readonly unknown[], history?: TranscriptHistoryScope): Promise<boolean> {
    try {
      const dependencies = raw.map((entry) => transcriptSkillDependencySchema.parse(entry));
      if (
        canonicalJson(raw) !== canonicalJson(dependencies) ||
        new Set(dependencies.map(canonicalJson)).size !== dependencies.length
      )
        return false;
      const external: TranscriptSkillDependency[] = [];
      for (const dependency of dependencies) {
        const builtin = await resolveBuiltinSkill(dependency.skill_id);
        if (!builtin) {
          external.push(dependency);
          continue;
        }
        const resource = builtin.resources.get(dependency.resource_path);
        if (
          builtin.skillId !== dependency.skill_id ||
          builtin.definitionHash !== dependency.definition_hash ||
          builtin.packageRecordId !== dependency.package_record_id ||
          !resource ||
          resource.resource_snapshot_id !== dependency.resource_snapshot_id ||
          resource.package_resource_id !== dependency.package_resource_id ||
          resource.resource_path !== dependency.resource_path ||
          resource.resource_hash !== dependency.resource_hash
        )
          if (
            !history ||
            !(await authorizeHistoricalBuiltinDependency(
              this.database,
              this.read,
              history,
              dependency,
            ))
          )
            return false;
      }
      return external.length === 0 || (await this.authorizeExternal(external));
    } catch {
      return false;
    }
  }

  private async authorizeExternal(dependencies: TranscriptSkillDependency[]) {
    const ids = (key: keyof TranscriptSkillDependency) => [
      ...new Set(dependencies.map((entry) => entry[key])),
    ];
    const releaseRows = await this.read(() =>
      this.database.query.skillCatalogReleases.findMany({
        where: inArray(skillCatalogReleases.id, ids('catalog_release_id')),
        columns: {
          id: true,
          status: true,
          releaseDigest: true,
          manifestJson: true,
          publishedAt: true,
          rollbackOfReleaseId: true,
          releaseNo: true,
        },
      }),
    );
    const packageRows = await this.read(() =>
      this.database.query.skillPackages.findMany({
        where: inArray(skillPackages.id, ids('package_record_id')),
        columns: {
          id: true,
          status: true,
          packageDigest: true,
          approvedValidationReportId: true,
          riskStatus: true,
          riskReviewDueAt: true,
          riskBlockedAt: true,
          disabledAt: true,
        },
      }),
    );
    const reportIds = packageRows.flatMap((row) =>
      row.approvedValidationReportId ? [row.approvedValidationReportId] : [],
    );
    const reportRows = reportIds.length
      ? await this.read(() =>
          this.database.query.skillPackageValidationReports.findMany({
            where: inArray(skillPackageValidationReports.id, [...new Set(reportIds)]),
            columns: { id: true, status: true, packageRecordId: true, packageDigest: true },
          }),
        )
      : [];
    const skillRows = await this.read(() =>
      this.database.query.skills.findMany({
        where: inArray(skills.id, ids('skill_id')),
        columns: {
          id: true,
          status: true,
          packageRecordId: true,
          definitionHash: true,
          definitionJson: true,
        },
      }),
    );
    const snapshotRows = await this.read(() =>
      this.database.query.skillResourceSnapshots.findMany({
        where: inArray(skillResourceSnapshots.id, ids('resource_snapshot_id')),
        columns: {
          id: true,
          skillId: true,
          packageResourceId: true,
          resourcePath: true,
          contentHash: true,
        },
      }),
    );
    const resourceRows = await this.read(() =>
      this.database.query.skillPackageResources.findMany({
        where: inArray(skillPackageResources.id, ids('package_resource_id')),
        columns: {
          id: true,
          packageRecordId: true,
          skillId: true,
          contentHash: true,
          mediaType: true,
        },
      }),
    );
    const releases = new Map(releaseRows.map((row) => [row.id, row]));
    const packages = new Map(packageRows.map((row) => [row.id, row]));
    const reports = new Map(reportRows.map((row) => [row.id, row]));
    const definitions = new Map(skillRows.map((row) => [row.id, row]));
    const snapshots = new Map(snapshotRows.map((row) => [row.id, row]));
    const resources = new Map(resourceRows.map((row) => [row.id, row]));
    const [clock] = await this.read(() =>
      this.database
        .select({ now: sql<string>`clock_timestamp()::text` })
        .from(sql`(values (1)) as transcript_clock(n)`),
    );
    const now = clock ? Date.parse(clock.now) : NaN;
    if (!Number.isFinite(now)) return false;

    for (const dependency of dependencies) {
      const release = releases.get(dependency.catalog_release_id);
      const packageRow = packages.get(dependency.package_record_id);
      const skill = definitions.get(dependency.skill_id);
      const snapshot = snapshots.get(dependency.resource_snapshot_id);
      const resource = resources.get(dependency.package_resource_id);
      if (
        !release ||
        !['published', 'retired'].includes(release.status) ||
        !(release.publishedAt instanceof Date) ||
        !Number.isFinite(release.publishedAt.getTime()) ||
        release.releaseDigest !== dependency.catalog_version ||
        !packageRow ||
        packageRow.status !== 'approved' ||
        !packageRow.packageDigest ||
        !packageRow.approvedValidationReportId ||
        packageRow.disabledAt !== null ||
        packageRow.riskBlockedAt !== null ||
        !['clear', 'needs_review'].includes(packageRow.riskStatus) ||
        (packageRow.riskStatus === 'needs_review' &&
          (!(packageRow.riskReviewDueAt instanceof Date) ||
            !Number.isFinite(packageRow.riskReviewDueAt.getTime()) ||
            packageRow.riskReviewDueAt.getTime() <= now)) ||
        !skill ||
        skill.status !== 'published' ||
        skill.packageRecordId !== dependency.package_record_id ||
        skill.definitionHash !== dependency.definition_hash ||
        !snapshot ||
        snapshot.skillId !== dependency.skill_id ||
        snapshot.packageResourceId !== dependency.package_resource_id ||
        snapshot.resourcePath !== dependency.resource_path ||
        snapshot.contentHash !== dependency.resource_hash ||
        !resource ||
        resource.packageRecordId !== dependency.package_record_id ||
        (resource.skillId !== null && resource.skillId !== dependency.skill_id) ||
        resource.contentHash !== dependency.resource_hash ||
        resource.mediaType !== 'text/markdown'
      )
        return false;
      const definition = parseSkillDefinition(skill.definitionJson);
      if (
        `${definition.slug}@${definition.version}` !== dependency.skill_id ||
        canonicalSha256(definition) !== dependency.definition_hash
      )
        return false;
      const manifest = parseSkillCatalogReleaseManifest(release.manifestJson);
      const digest = canonicalSha256(
        release.rollbackOfReleaseId
          ? {
              rollback_of_release_id: release.rollbackOfReleaseId,
              release_no: release.releaseNo,
              manifest,
            }
          : manifest,
      );
      if (digest !== release.releaseDigest) return false;
      const entry = manifest.packages.find((item) => item.package_record_id === packageRow.id);
      const skillEntry = entry?.skills.find((item) => item.skill_id === dependency.skill_id);
      const resourceEntry = skillEntry?.resources.find(
        (item) => item.skill_resource_snapshot_id === dependency.resource_snapshot_id,
      );
      const report = reports.get(packageRow.approvedValidationReportId);
      if (
        entry?.package_digest !== packageRow.packageDigest ||
        entry?.validation_report_id !== packageRow.approvedValidationReportId ||
        skillEntry?.definition_hash !== dependency.definition_hash ||
        resourceEntry?.package_resource_id !== dependency.package_resource_id ||
        resourceEntry?.resource_path !== dependency.resource_path ||
        resourceEntry?.content_hash !== dependency.resource_hash ||
        !report ||
        report.status !== 'passed' ||
        report.packageRecordId !== dependency.package_record_id ||
        report.packageDigest !== packageRow.packageDigest
      )
        return false;
    }
    return true;
  }
}
