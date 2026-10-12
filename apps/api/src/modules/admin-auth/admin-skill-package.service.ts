import { createHash, randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  desc,
  eq,
  lt,
  or,
  skillCatalogReleases,
  skillPackages,
  skillPackageValidationReports,
  skills,
  sql,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';
import {
  LocalPrivateStorage,
  StorageCapabilityCodec,
  storageObjectKeyDigest,
} from '@ecom-forge/storage';
import { readIsolatedSkillPackageBuffer, SKILL_PACKAGE_ARCHIVE_LIMITS } from '@ecom-forge/skills';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { AppConfig } from '../../config/app-config.js';
import {
  SkillPackageApprovalError,
  SkillPackageApprovalService,
} from '../skill-package/skill-package-approval.service.js';
import {
  SkillPackageInstallError,
  SkillPackageInstallService,
  type QuarantinedResourceInput,
} from '../skill-package/skill-package-install.service.js';
import type { SkillPackageActor } from '../skill-package/skill-package-actor.js';
import {
  SkillPackageRevalidationError,
  SkillPackageRevalidationService,
} from '../skill-package/skill-package-revalidation.service.js';
import {
  SignedCursorCodec,
  SignedCursorError,
  type CursorPosition,
} from '../../shared/http/signed-cursor.js';
import { HmacKeyring } from '../auth/security/hmac-keyring.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminRequest, AdminSessionContext } from './admin-http.js';
import { AdminIdempotencyRepository } from './admin-idempotency.repository.js';

const uploadIntentSnapshot = z.strictObject({
  schema_version: z.literal(1),
  file_name_digest: z.string().regex(/^[a-f0-9]{64}$/),
  declared_size_bytes: z.number().int().positive(),
});
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function actor(context: AdminSessionContext): SkillPackageActor {
  return {
    actorType: 'admin_session',
    actorAdminId: context.principalId,
    adminSessionId: context.id,
    permissionSnapshot: { permissions: context.permissions },
  };
}

function requestId(request: AdminRequest): string {
  const value = request.headers['x-request-id'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `admin-skill:${randomUUID()}`;
}

@Injectable()
export class AdminSkillPackageService {
  private readonly cursor: SignedCursorCodec;
  private readonly idempotency: AdminIdempotencyRepository;
  private readonly idempotencyHash: HmacKeyring;
  private readonly capability: StorageCapabilityCodec;
  private readonly storage: LocalPrivateStorage;
  private readonly installer: SkillPackageInstallService;
  private readonly revalidation: SkillPackageRevalidationService;
  private readonly approval: SkillPackageApprovalService;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {
    this.cursor = new SignedCursorCodec(config.resourceCursorSecret);
    this.idempotency = new AdminIdempotencyRepository(database, config.admin.idempotencyHashKeys);
    this.idempotencyHash = new HmacKeyring(config.admin.idempotencyHashKeys);
    this.capability = new StorageCapabilityCodec(config.storage.capabilitySecret);
    this.storage = new LocalPrivateStorage(config.localUploadRoot);
    this.installer = new SkillPackageInstallService(database, config.appEnv);
    this.revalidation = new SkillPackageRevalidationService(database, config.appEnv);
    this.approval = new SkillPackageApprovalService(database, config.appEnv, this.storage);
  }

  async createUploadIntent(
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      fileName: string;
      declaredSizeBytes: number;
      declaredArchiveSha256: string;
      sourceType: 'first_party' | 'legacy_owned' | 'admin_upload';
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    if (
      input.declaredSizeBytes > SKILL_PACKAGE_ARCHIVE_LIMITS.compressedBytes ||
      !input.fileName.toLowerCase().endsWith('.skillpkg')
    ) {
      adminAuthError('ADMIN_SKILL_PACKAGE_UPLOAD_INVALID', 422);
    }
    const stable = await this.idempotency.execute({
      context,
      operation: 'skill_package.upload_intent',
      idempotencyKey: input.idempotencyKey,
      request: input,
      responseStatus: 201,
      write: async (transaction) => {
        const packageRecordId = randomUUID();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1_000);
        const quarantineStorageKey = `skill-quarantine/${packageRecordId}/archive.skillpkg`;
        await transaction.insert(skillPackages).values({
          id: packageRecordId,
          archiveSha256: input.declaredArchiveSha256,
          manifestJson: {
            schema_version: 1,
            file_name_digest: canonicalSha256(input.fileName.normalize('NFC')),
            declared_size_bytes: input.declaredSizeBytes,
          },
          status: 'quarantined',
          sourceType: input.sourceType,
          quarantineStorageKey,
          uploadExpiresAt: expiresAt,
          uploadedBy: context.principalId,
        });
        await this.audit(transaction, context, request, {
          action: 'skill_package.upload_intent_created',
          targetId: packageRecordId,
          reason: 'Create quarantined Skill package upload intent',
          idempotencyKey: input.idempotencyKey,
          after: {
            source_type: input.sourceType,
            declared_size_bytes: input.declaredSizeBytes,
            declared_archive_sha256: input.declaredArchiveSha256,
          },
        });
        return {
          package_record_id: packageRecordId,
          status: 'quarantined',
          expires_at: expiresAt,
          max_size_bytes: input.declaredSizeBytes,
        };
      },
    });
    const packageRecordId = String(stable.package_record_id);
    const packageRecord = await this.database.query.skillPackages.findFirst({
      where: eq(skillPackages.id, packageRecordId),
    });
    if (
      !packageRecord ||
      packageRecord.status !== 'quarantined' ||
      packageRecord.uploadExpiresAt.getTime() <= Date.now()
    ) {
      return {
        package_record_id: packageRecordId,
        status: packageRecord?.status ?? 'unavailable',
      };
    }
    const snapshot = uploadIntentSnapshot.parse(packageRecord.manifestJson);
    const expiresAt = Math.min(
      Math.floor(packageRecord.uploadExpiresAt.getTime() / 1_000),
      Math.floor(Date.now() / 1_000) + 5 * 60,
    );
    const token = this.capability.issue({
      version: 1,
      purpose: 'upload',
      userId: context.principalId,
      resourceType: 'upload',
      resourceId: packageRecord.id,
      variant: 'content',
      objectKeyDigest: storageObjectKeyDigest(packageRecord.quarantineStorageKey),
      expiresAt,
      maxBytes: snapshot.declared_size_bytes,
    });
    return {
      ...stable,
      upload_url: `/api/v1/admin/skill-packages/uploads/${packageRecord.id}/content?capability=${encodeURIComponent(token)}`,
      required_headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(snapshot.declared_size_bytes),
      },
    };
  }

  async uploadContent(input: {
    packageRecordId: string;
    capability: string;
    contentType: string;
    body: Buffer;
  }): Promise<void> {
    const packageRecord = await this.database.query.skillPackages.findFirst({
      where: eq(skillPackages.id, input.packageRecordId),
    });
    if (!packageRecord || packageRecord.status !== 'quarantined' || !packageRecord.uploadedBy) {
      adminAuthError('ADMIN_SKILL_PACKAGE_UPLOAD_INVALID', 404);
    }
    const snapshot = uploadIntentSnapshot.parse(packageRecord.manifestJson);
    if (
      input.contentType !== 'application/octet-stream' ||
      input.body.byteLength !== snapshot.declared_size_bytes
    ) {
      adminAuthError('ADMIN_SKILL_PACKAGE_UPLOAD_INVALID', 422);
    }
    this.capability.verify(input.capability, {
      version: 1,
      purpose: 'upload',
      userId: packageRecord.uploadedBy,
      resourceType: 'upload',
      resourceId: packageRecord.id,
      variant: 'content',
      objectKeyDigest: storageObjectKeyDigest(packageRecord.quarantineStorageKey),
      maxBytes: snapshot.declared_size_bytes,
    });
    await this.storage.initialize();
    await this.writeOrVerify(packageRecord.quarantineStorageKey, input.body);
  }

  async complete(
    context: AdminSessionContext,
    input: { packageRecordId: string; expectedRevision: number; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    const packageRecord = await this.database.query.skillPackages.findFirst({
      where: eq(skillPackages.id, input.packageRecordId),
    });
    if (!packageRecord) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const snapshot = uploadIntentSnapshot.parse(packageRecord.manifestJson);
    await this.storage.initialize();
    let archive: Buffer;
    try {
      archive = await this.storage.read(packageRecord.quarantineStorageKey);
    } catch {
      adminAuthError('ADMIN_SKILL_PACKAGE_UPLOAD_INCOMPLETE', 409);
    }
    const isolated = await readIsolatedSkillPackageBuffer(archive);
    if (
      archive.byteLength !== snapshot.declared_size_bytes ||
      isolated.archiveSha256 !== packageRecord.archiveSha256
    ) {
      adminAuthError('ADMIN_SKILL_PACKAGE_ARCHIVE_MISMATCH', 422);
    }
    const resources: QuarantinedResourceInput[] = [];
    for (const item of isolated.resources) {
      const contentHash = createHash('sha256').update(item.content).digest('hex');
      const storageKey = `skill-quarantine/${packageRecord.id}/resources/${contentHash}`;
      await this.writeOrVerify(storageKey, item.content);
      const owningSkill = isolated.manifest.skills.find((skill) =>
        item.path.startsWith(skill.definition_path.slice(0, -'SKILL.md'.length)),
      );
      resources.push({
        path: item.path,
        mediaType: item.mediaType,
        byteSize: item.content.byteLength,
        contentHash,
        storageKey,
        ...(owningSkill ? { skillId: owningSkill.skill_id } : {}),
        rightsMetadata: { source: isolated.manifest.source_provenance.type },
      });
    }
    try {
      const completed = await this.idempotency.execute({
        context,
        operation: 'skill_package.complete',
        idempotencyKey: input.idempotencyKey,
        request: {
          package_record_id: input.packageRecordId,
          expected_revision: input.expectedRevision,
        },
        responseStatus: 200,
        write: (transaction) =>
          this.installer
            .completeUploadInTransaction(transaction, {
              packageRecordId: input.packageRecordId,
              expectedRevision: input.expectedRevision,
              manifest: isolated.manifest,
              archiveSha256: isolated.archiveSha256,
              quarantineStorageKey: packageRecord.quarantineStorageKey,
              uploadExpiresAt: packageRecord.uploadExpiresAt,
              resources,
              platformEvalSuiteDigest: canonicalSha256({ suite: 's08-platform-eval@1' }),
              actor: actor(context),
            })
            .then((result) => ({
              package_record_id: result.packageRecordId,
              package_digest: result.packageDigest,
              revision: result.revision,
              status: result.status,
            })),
      });
      return completed;
    } catch (error) {
      if (error instanceof SkillPackageInstallError) {
        adminAuthError(
          error.code === 'SKILL_PACKAGE_IDENTITY_CONFLICT'
            ? 'ADMIN_SKILL_PACKAGE_CONFLICT'
            : 'ADMIN_SKILL_PACKAGE_INVALID',
          error.code === 'SKILL_PACKAGE_IDENTITY_CONFLICT' ? 409 : 422,
        );
      }
      throw error;
    }
  }

  async createValidation(
    context: AdminSessionContext,
    input: { packageRecordId: string; expectedRevision: number; idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    try {
      return await this.idempotency.execute({
        context,
        operation: 'skill_package.validation.create',
        idempotencyKey: input.idempotencyKey,
        request: {
          package_record_id: input.packageRecordId,
          expected_revision: input.expectedRevision,
        },
        responseStatus: 202,
        write: (transaction) =>
          this.revalidation
            .createAttemptInTransaction(transaction, {
              packageRecordId: input.packageRecordId,
              expectedPackageRevision: input.expectedRevision,
              validatorContractVersion: 'skill-package-validator@1',
              platformEvalSuiteDigest: canonicalSha256({ suite: 's08-platform-eval@1' }),
              reason: 'Create immutable Skill package validation attempt',
              actor: actor(context),
            })
            .then((result) => ({
              validation_report_id: result.validationReportId,
              status: 'queued',
              attempt_no: result.attemptNo,
            })),
      });
    } catch (error) {
      if (error instanceof SkillPackageRevalidationError) {
        adminAuthError(
          error.code === 'SKILL_PACKAGE_REVALIDATION_CONFLICT'
            ? 'ADMIN_SKILL_PACKAGE_CONFLICT'
            : 'ADMIN_SKILL_PACKAGE_INVALID',
          error.code === 'SKILL_PACKAGE_REVALIDATION_CONFLICT' ? 409 : 422,
        );
      }
      throw error;
    }
  }

  async approve(
    context: AdminSessionContext,
    input: {
      packageRecordId: string;
      expectedRevision: number;
      validationReportId: string;
      validationReportDigest: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    const report = await this.database.query.skillPackageValidationReports.findFirst({
      where: and(
        eq(skillPackageValidationReports.id, input.validationReportId),
        eq(skillPackageValidationReports.packageRecordId, input.packageRecordId),
      ),
    });
    if (!report || report.reportDigest !== input.validationReportDigest) {
      adminAuthError('ADMIN_SKILL_PACKAGE_REPORT_DRIFT', 409);
    }
    const approvalInput = {
      packageRecordId: input.packageRecordId,
      validationReportId: input.validationReportId,
      expectedPackageRevision: input.expectedRevision,
      reason: input.reason,
      actor: actor(context),
    };
    try {
      const snapshot = await this.approval.prepareApproval(approvalInput);
      return await this.idempotency.execute({
        context,
        operation: 'skill_package.approve',
        idempotencyKey: input.idempotencyKey,
        request: input,
        responseStatus: 200,
        write: (transaction) =>
          this.approval
            .approvePreparedInTransaction(transaction, approvalInput, snapshot)
            .then((result) => ({
              package_record_id: result.packageRecordId,
              validation_report_id: result.validationReportId,
              skill_ids: result.skillIds,
              reused: result.reused,
            })),
      });
    } catch (error) {
      if (error instanceof SkillPackageApprovalError) {
        adminAuthError(
          error.code === 'SKILL_PACKAGE_APPROVAL_CONFLICT' ||
            error.code === 'SKILL_PACKAGE_VERSION_CONFLICT'
            ? 'ADMIN_SKILL_PACKAGE_CONFLICT'
            : 'ADMIN_SKILL_PACKAGE_INVALID',
          error.code === 'SKILL_PACKAGE_APPROVAL_CONFLICT' ||
            error.code === 'SKILL_PACKAGE_VERSION_CONFLICT'
            ? 409
            : 422,
        );
      }
      throw error;
    }
  }

  async disable(
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      packageRecordId: string;
      expectedRevision: number;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.idempotency.execute({
      context,
      operation: 'skill_package.disable',
      idempotencyKey: input.idempotencyKey,
      request: input,
      responseStatus: 200,
      write: async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-package-disable', input.packageRecordId)})`,
        );
        const packageRecord = await transaction.query.skillPackages.findFirst({
          where: eq(skillPackages.id, input.packageRecordId),
        });
        if (
          !packageRecord ||
          packageRecord.status === 'disabled' ||
          packageRecord.revision !== input.expectedRevision
        ) {
          adminAuthError('ADMIN_SKILL_PACKAGE_CONFLICT', 409);
        }
        const now = new Date();
        const [updated] = await transaction
          .update(skillPackages)
          .set({
            status: 'disabled',
            revision: packageRecord.revision + 1,
            disabledBy: context.principalId,
            disabledReason: input.reason,
            disabledAt: now,
          })
          .where(
            and(
              eq(skillPackages.id, packageRecord.id),
              eq(skillPackages.revision, packageRecord.revision),
            ),
          )
          .returning({ revision: skillPackages.revision });
        if (!updated) adminAuthError('ADMIN_SKILL_PACKAGE_CONFLICT', 409);
        await transaction
          .update(skills)
          .set({ status: 'disabled' })
          .where(eq(skills.packageRecordId, packageRecord.id));
        await this.audit(transaction, context, request, {
          action: 'skill_package.disabled',
          targetId: packageRecord.id,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          after: { status: 'disabled', revision: updated.revision },
        });
        return {
          package_record_id: packageRecord.id,
          status: 'disabled',
          revision: updated.revision,
        };
      },
    });
  }

  async list(
    context: AdminSessionContext,
    input: { limit: number; cursor?: string; status?: typeof skillPackages.$inferSelect.status },
  ): Promise<Record<string, unknown>> {
    const filters = { status: input.status ?? null };
    const position = this.decodeCursor(context, input.cursor, filters);
    const rows = await this.database
      .select()
      .from(skillPackages)
      .where(
        and(
          input.status ? eq(skillPackages.status, input.status) : undefined,
          position
            ? or(
                lt(skillPackages.createdAt, position.createdAt),
                and(
                  eq(skillPackages.createdAt, position.createdAt),
                  lt(skillPackages.id, position.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(skillPackages.createdAt), desc(skillPackages.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const reportIds = page
      .map((item) => item.latestValidationReportId)
      .filter((id): id is string => Boolean(id));
    const reports = reportIds.length
      ? await this.database.query.skillPackageValidationReports.findMany({
          where: or(...reportIds.map((id) => eq(skillPackageValidationReports.id, id))),
        })
      : [];
    const reportById = new Map(reports.map((report) => [report.id, report]));
    const last = page.at(-1);
    return {
      items: page.map((item) =>
        this.summary(item, reportById.get(item.latestValidationReportId ?? '')),
      ),
      next_cursor:
        rows.length > input.limit && last
          ? this.cursor.encode({
              userId: context.principalId,
              endpoint: 'admin-skill-packages',
              filters,
              position: { id: last.id, createdAt: last.createdAt },
            })
          : null,
    };
  }

  async detail(packageRecordId: string): Promise<Record<string, unknown>> {
    const packageRecord = await this.database.query.skillPackages.findFirst({
      where: eq(skillPackages.id, packageRecordId),
    });
    if (!packageRecord) adminAuthError('ADMIN_RESOURCE_NOT_FOUND', 404);
    const [reports, releases] = await Promise.all([
      this.database.query.skillPackageValidationReports.findMany({
        where: eq(skillPackageValidationReports.packageRecordId, packageRecord.id),
        orderBy: [desc(skillPackageValidationReports.createdAt)],
      }),
      this.database
        .select()
        .from(skillCatalogReleases)
        .orderBy(desc(skillCatalogReleases.createdAt)),
    ]);
    const referencedReleases = releases.filter((release) =>
      JSON.stringify(release.manifestJson).includes(packageRecord.id),
    );
    return {
      ...this.summary(packageRecord, reports[0]),
      package: packageRecord.packageId
        ? {
            package_id: packageRecord.packageId,
            package_version: packageRecord.packageVersion,
            package_digest: packageRecord.packageDigest,
            archive_sha256: packageRecord.archiveSha256,
            source_type: packageRecord.sourceType,
            source_locator_digest: packageRecord.sourceLocatorDigest,
            license_summary: packageRecord.licenseSummaryJson,
          }
        : null,
      validations: reports.map((report) => ({
        id: report.id,
        attempt_no: report.attemptNo,
        status: report.status,
        report_digest: report.reportDigest,
        validator_contract_version: report.validatorContractVersion,
        platform_eval_suite_digest: report.platformEvalSuiteDigest,
        created_at: report.createdAt,
        completed_at: report.completedAt,
      })),
      release_references: referencedReleases.map((release) => ({
        id: release.id,
        release_no: release.releaseNo,
        status: release.status,
      })),
    };
  }

  private summary(
    item: typeof skillPackages.$inferSelect,
    report?: typeof skillPackageValidationReports.$inferSelect,
  ): Record<string, unknown> {
    return {
      id: item.id,
      package_id: item.packageId,
      package_version: item.packageVersion,
      package_digest: item.packageDigest,
      status: item.status,
      risk_status: item.riskStatus,
      revision: item.revision,
      latest_validation: report
        ? {
            id: report.id,
            attempt_no: report.attemptNo,
            status: report.status,
            report_digest: report.reportDigest,
          }
        : null,
      created_at: item.createdAt,
      approved_at: item.approvedAt,
      disabled_at: item.disabledAt,
    };
  }

  private decodeCursor(
    context: AdminSessionContext,
    cursor: string | undefined,
    filters: unknown,
  ): CursorPosition | undefined {
    if (!cursor) return undefined;
    try {
      return this.cursor.decode({
        cursor,
        userId: context.principalId,
        endpoint: 'admin-skill-packages',
        filters,
      });
    } catch (error) {
      if (error instanceof SignedCursorError) adminAuthError('ADMIN_CURSOR_INVALID', 400);
      throw error;
    }
  }

  private async writeOrVerify(storageKey: string, body: Uint8Array): Promise<void> {
    const buffer = Buffer.from(body);
    try {
      await this.storage.writeExclusive(storageKey, buffer);
    } catch (error) {
      const existing = await this.storage.read(storageKey).catch(() => undefined);
      if (!existing || !existing.equals(buffer)) throw error;
    }
  }

  private async audit(
    transaction: Transaction,
    context: AdminSessionContext,
    request: AdminRequest,
    input: {
      action: string;
      targetId: string;
      reason: string;
      idempotencyKey: string;
      after: Record<string, unknown>;
    },
  ): Promise<void> {
    await transaction.insert(adminAuditLogs).values({
      actorAdminId: context.principalId,
      actorType: 'admin_session',
      adminSessionId: context.id,
      permissionSnapshot: { permissions: context.permissions },
      action: input.action,
      targetType: 'skill_package',
      targetId: input.targetId,
      afterJson: input.after,
      reason: input.reason,
      requestId: requestId(request),
      idempotencyKeyHash: this.idempotencyHash.digest(input.idempotencyKey).digest,
      sourceIpHash: context.sourceIpHash,
      userAgentHash: context.userAgentHash,
      mfaLevel: context.mfaLevel,
      stepUpAt: context.stepUpAt,
      result: 'succeeded',
    });
  }
}
