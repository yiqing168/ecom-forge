import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  eq,
  skillPackageResources,
  skillPackages,
  skillPackageValidationReports,
  sql,
  type Database,
} from '@ecom-forge/db';
import { createQueueIntentInTransaction } from '@ecom-forge/queue';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';
import {
  parseSkillPackageManifest,
  skillPackageDigest,
  type SkillPackageManifest,
} from '@ecom-forge/skills';
import type { AppEnvironment } from '../../config/app-config.js';
import {
  isAuthorizedSkillPackageActor,
  skillPackageActorRef,
  skillPackageAuditActor,
  type SkillPackageActor,
} from './skill-package-actor.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VALIDATOR_CONTRACT_VERSION = 'skill-package-validator@1';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type { SkillPackageActor } from './skill-package-actor.js';

export interface QuarantinedResourceInput {
  path: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  storageKey: string;
  skillId?: string;
  rightsMetadata: Record<string, unknown>;
}

export interface InstallSkillPackageInput {
  manifest: unknown;
  archiveSha256: string;
  quarantineStorageKey: string;
  uploadExpiresAt: Date;
  resources: QuarantinedResourceInput[];
  platformEvalSuiteDigest: string;
  actor: SkillPackageActor;
}

export interface CompleteSkillPackageUploadInput extends InstallSkillPackageInput {
  packageRecordId: string;
  expectedRevision: number;
}

export class SkillPackageInstallError extends Error {
  constructor(
    readonly code:
      | 'SKILL_PACKAGE_INSTALL_FORBIDDEN'
      | 'SKILL_PACKAGE_ARCHIVE_INVALID'
      | 'SKILL_PACKAGE_RESOURCE_INVALID'
      | 'SKILL_PACKAGE_IDENTITY_CONFLICT',
  ) {
    super(code);
    this.name = 'SkillPackageInstallError';
  }
}

function assertActor(actor: SkillPackageActor, appEnv: AppEnvironment): void {
  if (!isAuthorizedSkillPackageActor(actor, appEnv)) {
    throw new SkillPackageInstallError('SKILL_PACKAGE_INSTALL_FORBIDDEN');
  }
}

function validateResourceInventory(
  manifest: SkillPackageManifest,
  resources: QuarantinedResourceInput[],
): void {
  if (resources.length !== manifest.resources.length) {
    throw new SkillPackageInstallError('SKILL_PACKAGE_RESOURCE_INVALID');
  }
  const inputByPath = new Map(resources.map((resource) => [resource.path, resource]));
  if (inputByPath.size !== resources.length) {
    throw new SkillPackageInstallError('SKILL_PACKAGE_RESOURCE_INVALID');
  }
  for (const expected of manifest.resources) {
    const actual = inputByPath.get(expected.path);
    if (
      !actual ||
      actual.mediaType !== expected.media_type ||
      actual.byteSize !== expected.byte_size ||
      actual.contentHash !== expected.content_hash ||
      !actual.storageKey.trim() ||
      Object.keys(actual.rightsMetadata).length === 0
    ) {
      throw new SkillPackageInstallError('SKILL_PACKAGE_RESOURCE_INVALID');
    }
  }
}

export class SkillPackageInstallService {
  constructor(
    private readonly database: Database,
    private readonly appEnv: AppEnvironment,
  ) {}

  async install(rawInput: InstallSkillPackageInput): Promise<{
    packageRecordId: string;
    validationReportId: string;
    queueIntentId: string;
    packageDigest: string;
    reused: boolean;
  }> {
    assertActor(rawInput.actor, this.appEnv);
    if (
      !SHA256_PATTERN.test(rawInput.archiveSha256) ||
      !SHA256_PATTERN.test(rawInput.platformEvalSuiteDigest) ||
      !rawInput.quarantineStorageKey.trim() ||
      rawInput.uploadExpiresAt.getTime() <= Date.now()
    ) {
      throw new SkillPackageInstallError('SKILL_PACKAGE_ARCHIVE_INVALID');
    }
    const manifest = parseSkillPackageManifest(rawInput.manifest);
    validateResourceInventory(manifest, rawInput.resources);
    const packageDigest = skillPackageDigest(manifest);
    const identity = `${manifest.package_id}@${manifest.package_version}`;

    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-package-install', identity)})`,
      );
      const existing = await transaction.query.skillPackages.findFirst({
        where: and(
          eq(skillPackages.packageId, manifest.package_id),
          eq(skillPackages.packageVersion, manifest.package_version),
        ),
      });
      if (existing) {
        if (existing.packageDigest !== packageDigest) {
          throw new SkillPackageInstallError('SKILL_PACKAGE_IDENTITY_CONFLICT');
        }
        const report = existing.latestValidationReportId
          ? await transaction.query.skillPackageValidationReports.findFirst({
              where: eq(skillPackageValidationReports.id, existing.latestValidationReportId),
            })
          : undefined;
        if (!report?.queueIntentId) {
          throw new SkillPackageInstallError('SKILL_PACKAGE_IDENTITY_CONFLICT');
        }
        return {
          packageRecordId: existing.id,
          validationReportId: report.id,
          queueIntentId: report.queueIntentId,
          packageDigest,
          reused: true,
        };
      }

      const packageRecordId = randomUUID();
      const validationReportId = randomUUID();
      await transaction.insert(skillPackages).values({
        id: packageRecordId,
        packageId: manifest.package_id,
        packageVersion: manifest.package_version,
        packageDigest,
        archiveSha256: rawInput.archiveSha256,
        manifestJson: manifest,
        status: 'validating',
        riskStatus: 'clear',
        sourceType: manifest.source_provenance.type,
        sourceLocatorDigest: manifest.source_provenance.summary_digest,
        licenseSummaryJson: manifest.license_summary,
        quarantineStorageKey: rawInput.quarantineStorageKey,
        uploadExpiresAt: rawInput.uploadExpiresAt,
        uploadedBy: skillPackageActorRef(rawInput.actor),
      });
      await transaction.insert(skillPackageResources).values(
        rawInput.resources.map((resource) => ({
          packageRecordId,
          resourcePath: resource.path,
          resourceType: manifest.skills.some((skill) => skill.definition_path === resource.path)
            ? 'skill_definition'
            : manifest.eval_datasets.includes(resource.path)
              ? 'eval_dataset'
              : manifest.assets.includes(resource.path)
                ? 'asset'
                : 'skill_resource',
          mediaType: resource.mediaType,
          byteSize: resource.byteSize,
          contentHash: resource.contentHash,
          storageKey: resource.storageKey,
          skillId: resource.skillId,
          rightsMetadataJson: resource.rightsMetadata,
        })),
      );
      await transaction.insert(skillPackageValidationReports).values({
        id: validationReportId,
        packageRecordId,
        packageRevision: 1,
        packageDigest,
        attemptNo: 1,
        status: 'queued',
        validatorContractVersion: VALIDATOR_CONTRACT_VERSION,
        platformEvalSuiteDigest: rawInput.platformEvalSuiteDigest,
      });
      const queueIntent = await createQueueIntentInTransaction(transaction, {
        queueName: 'evaluation',
        jobId: `skill-package_validate_${validationReportId}`,
        aggregateType: 'skill_package_validation_report',
        aggregateId: validationReportId,
        payloadVersion: 2,
        payload: {
          schema_version: 2,
          trace_id: randomUUID(),
          job_type: 'skill-package.validate',
          package_record_id: packageRecordId,
          validation_report_id: validationReportId,
          attempt_no: 1,
          package_digest: packageDigest,
          validator_contract_version: VALIDATOR_CONTRACT_VERSION,
          platform_eval_suite_digest: rawInput.platformEvalSuiteDigest,
        },
      });
      await transaction
        .update(skillPackageValidationReports)
        .set({ queueIntentId: queueIntent.id })
        .where(eq(skillPackageValidationReports.id, validationReportId));
      await transaction
        .update(skillPackages)
        .set({ latestValidationReportId: validationReportId })
        .where(eq(skillPackages.id, packageRecordId));
      await transaction.insert(adminAuditLogs).values({
        ...skillPackageAuditActor(rawInput.actor),
        action: 'skill_package.install',
        targetType: 'skill_package',
        targetId: packageRecordId,
        afterJson: {
          package_digest: packageDigest,
          validation_report_id: validationReportId,
          resource_count: rawInput.resources.length,
        },
        reason: 'local/test controlled Skill package installation',
        idempotencyKeyHash: canonicalSha256({ identity, packageDigest }),
        result: 'succeeded',
      });
      return {
        packageRecordId,
        validationReportId,
        queueIntentId: queueIntent.id,
        packageDigest,
        reused: false,
      };
    });
  }

  async completeUpload(input: CompleteSkillPackageUploadInput): Promise<{
    packageRecordId: string;
    packageDigest: string;
    revision: number;
    status: 'uploaded';
  }> {
    return this.database.transaction((transaction) =>
      this.completeUploadInTransaction(transaction, input),
    );
  }

  async completeUploadInTransaction(
    transaction: Transaction,
    input: CompleteSkillPackageUploadInput,
  ): Promise<{
    packageRecordId: string;
    packageDigest: string;
    revision: number;
    status: 'uploaded';
  }> {
    assertActor(input.actor, this.appEnv);
    if (
      input.expectedRevision < 1 ||
      !SHA256_PATTERN.test(input.archiveSha256) ||
      !input.quarantineStorageKey.trim()
    ) {
      throw new SkillPackageInstallError('SKILL_PACKAGE_ARCHIVE_INVALID');
    }
    const manifest = parseSkillPackageManifest(input.manifest);
    validateResourceInventory(manifest, input.resources);
    const packageDigest = skillPackageDigest(manifest);
    const identity = `${manifest.package_id}@${manifest.package_version}`;

    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-package-upload', input.packageRecordId)})`,
    );
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-package-install', identity)})`,
    );
    const packageRecord = await transaction.query.skillPackages.findFirst({
      where: eq(skillPackages.id, input.packageRecordId),
    });
    if (
      !packageRecord ||
      packageRecord.status !== 'quarantined' ||
      packageRecord.revision !== input.expectedRevision ||
      packageRecord.uploadExpiresAt.getTime() <= Date.now() ||
      packageRecord.quarantineStorageKey !== input.quarantineStorageKey ||
      (packageRecord.archiveSha256 && packageRecord.archiveSha256 !== input.archiveSha256)
    ) {
      throw new SkillPackageInstallError('SKILL_PACKAGE_IDENTITY_CONFLICT');
    }
    const identityConflict = await transaction.query.skillPackages.findFirst({
      where: and(
        eq(skillPackages.packageId, manifest.package_id),
        eq(skillPackages.packageVersion, manifest.package_version),
      ),
      columns: { id: true },
    });
    if (identityConflict && identityConflict.id !== packageRecord.id) {
      throw new SkillPackageInstallError('SKILL_PACKAGE_IDENTITY_CONFLICT');
    }
    const [updated] = await transaction
      .update(skillPackages)
      .set({
        packageId: manifest.package_id,
        packageVersion: manifest.package_version,
        packageDigest,
        archiveSha256: input.archiveSha256,
        manifestJson: manifest,
        status: 'uploaded',
        revision: packageRecord.revision + 1,
        sourceType: manifest.source_provenance.type,
        sourceLocatorDigest: manifest.source_provenance.summary_digest,
        licenseSummaryJson: manifest.license_summary,
        uploadedBy: skillPackageActorRef(input.actor),
      })
      .where(
        and(
          eq(skillPackages.id, packageRecord.id),
          eq(skillPackages.status, 'quarantined'),
          eq(skillPackages.revision, packageRecord.revision),
        ),
      )
      .returning({ revision: skillPackages.revision });
    if (!updated) throw new SkillPackageInstallError('SKILL_PACKAGE_IDENTITY_CONFLICT');
    await transaction.insert(skillPackageResources).values(
      input.resources.map((resource) => ({
        packageRecordId: packageRecord.id,
        resourcePath: resource.path,
        resourceType: manifest.skills.some((skill) => skill.definition_path === resource.path)
          ? 'skill_definition'
          : manifest.eval_datasets.includes(resource.path)
            ? 'eval_dataset'
            : manifest.assets.includes(resource.path)
              ? 'asset'
              : 'skill_resource',
        mediaType: resource.mediaType,
        byteSize: resource.byteSize,
        contentHash: resource.contentHash,
        storageKey: resource.storageKey,
        skillId: resource.skillId,
        rightsMetadataJson: resource.rightsMetadata,
      })),
    );
    await transaction.insert(adminAuditLogs).values({
      ...skillPackageAuditActor(input.actor),
      action: 'skill_package.upload_completed',
      targetType: 'skill_package',
      targetId: packageRecord.id,
      afterJson: {
        package_digest: packageDigest,
        archive_sha256: input.archiveSha256,
        resource_count: input.resources.length,
        revision: updated.revision,
      },
      reason: 'Complete and verify quarantined Skill package upload',
      result: 'succeeded',
    });
    return {
      packageRecordId: packageRecord.id,
      packageDigest,
      revision: updated.revision,
      status: 'uploaded',
    };
  }
}
