import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  eq,
  gt,
  skillPackageResources,
  skillPackages,
  skillPackageValidationReports,
  type Database,
} from '@ecom-forge/db';
import type { QueuePayload } from '@ecom-forge/queue';
import { canonicalSha256 } from '@ecom-forge/shared';
import {
  parseSkillPackageManifest,
  validateSkillPackageContents,
  type SkillPackageContentResource,
} from '@ecom-forge/skills';

import type { QuarantineResourceReader } from './quarantine-resource.reader.js';

export type ValidationPayload = Extract<QueuePayload, { job_type: 'skill-package.validate' }>;

export interface ClaimedSkillPackageValidation {
  owner: string;
  revision: number;
}

export interface SkillPackageValidationResult {
  status: 'passed' | 'failed' | 'cancelled';
  severity: 'clear' | 'error' | 'critical';
  ruleId: string;
  reportDigest: string;
  summary: Record<string, string | number>;
}

const terminalStatuses = new Set(['passed', 'failed', 'cancelled']);
const criticalRuleIds = new Set([
  'SKILL_PACKAGE_SECRET_DETECTED',
  'SKILL_PACKAGE_PRIVILEGE_ESCALATION',
  'SKILL_PACKAGE_DYNAMIC_URL_FORBIDDEN',
]);

function resourceLimit(mediaType: string): number {
  return mediaType.startsWith('image/') ? 16 * 1024 * 1024 : 1024 * 1024;
}

function stableRuleId(error: unknown): string {
  if (!(error instanceof Error) || !/^SKILL_[A-Z0-9_]+$/.test(error.message)) {
    return 'SKILL_PACKAGE_VALIDATION_FAILED';
  }
  return error.message;
}

export class SkillPackageValidationService {
  constructor(
    private readonly database: Database,
    private readonly reader: QuarantineResourceReader,
    private readonly leaseMs: number,
    private readonly renewMs: number,
  ) {}

  async execute(payload: ValidationPayload): Promise<boolean> {
    let claim = await this.claim(payload, randomUUID(), new Date());
    if (!claim) return false;
    let ownershipLost = false;
    let renewal = Promise.resolve();
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        if (ownershipLost) return;
        const revision = await this.renew(payload, claim!, new Date());
        if (revision === null) ownershipLost = true;
        else claim = { ...claim!, revision };
      });
    }, this.renewMs);
    timer.unref();
    try {
      const result = await this.validate(payload);
      clearInterval(timer);
      await renewal;
      if (ownershipLost) return false;
      return this.complete(payload, claim, result, new Date());
    } finally {
      clearInterval(timer);
      await renewal;
    }
  }

  async claim(
    payload: ValidationPayload,
    owner: string,
    now: Date,
  ): Promise<ClaimedSkillPackageValidation | null> {
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    return this.database.transaction(async (transaction) => {
      const [report] = await transaction
        .select({
          id: skillPackageValidationReports.id,
          revision: skillPackageValidationReports.revision,
          status: skillPackageValidationReports.status,
          processingLeaseExpiresAt: skillPackageValidationReports.processingLeaseExpiresAt,
          startedAt: skillPackageValidationReports.startedAt,
        })
        .from(skillPackageValidationReports)
        .where(
          and(
            eq(skillPackageValidationReports.id, payload.validation_report_id),
            eq(skillPackageValidationReports.packageRecordId, payload.package_record_id),
            eq(skillPackageValidationReports.attemptNo, payload.attempt_no),
            eq(skillPackageValidationReports.packageDigest, payload.package_digest),
            eq(
              skillPackageValidationReports.validatorContractVersion,
              payload.validator_contract_version,
            ),
            eq(
              skillPackageValidationReports.platformEvalSuiteDigest,
              payload.platform_eval_suite_digest,
            ),
          ),
        )
        .for('update');
      if (!report || terminalStatuses.has(report.status)) return null;
      if (
        report.status === 'running' &&
        report.processingLeaseExpiresAt &&
        report.processingLeaseExpiresAt.getTime() > now.getTime()
      ) {
        return null;
      }
      const revision = report.revision + 1;
      const [updated] = await transaction
        .update(skillPackageValidationReports)
        .set({
          status: 'running',
          revision,
          processingOwner: owner,
          processingLeaseExpiresAt: leaseExpiresAt,
          lastHeartbeatAt: now,
          startedAt: report.startedAt ?? now,
        })
        .where(
          and(
            eq(skillPackageValidationReports.id, report.id),
            eq(skillPackageValidationReports.revision, report.revision),
          ),
        )
        .returning({ id: skillPackageValidationReports.id });
      return updated ? { owner, revision } : null;
    });
  }

  async renew(
    payload: ValidationPayload,
    claim: ClaimedSkillPackageValidation,
    now: Date,
  ): Promise<number | null> {
    const revision = claim.revision + 1;
    const [updated] = await this.database
      .update(skillPackageValidationReports)
      .set({
        revision,
        processingLeaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        lastHeartbeatAt: now,
      })
      .where(
        and(
          eq(skillPackageValidationReports.id, payload.validation_report_id),
          eq(skillPackageValidationReports.status, 'running'),
          eq(skillPackageValidationReports.processingOwner, claim.owner),
          eq(skillPackageValidationReports.revision, claim.revision),
          gt(skillPackageValidationReports.processingLeaseExpiresAt, now),
        ),
      )
      .returning({ revision: skillPackageValidationReports.revision });
    return updated?.revision ?? null;
  }

  async validate(payload: ValidationPayload): Promise<SkillPackageValidationResult> {
    try {
      const [packageRecord, report] = await Promise.all([
        this.database.query.skillPackages.findFirst({
          where: eq(skillPackages.id, payload.package_record_id),
        }),
        this.database.query.skillPackageValidationReports.findFirst({
          where: eq(skillPackageValidationReports.id, payload.validation_report_id),
        }),
      ]);
      if (
        !packageRecord ||
        !report ||
        packageRecord.packageDigest !== payload.package_digest ||
        packageRecord.revision !== report.packageRevision ||
        !packageRecord.manifestJson
      ) {
        return this.result(payload, 'cancelled', 'error', 'SKILL_PACKAGE_SNAPSHOT_DRIFT', {});
      }
      const manifest = parseSkillPackageManifest(packageRecord.manifestJson);
      const rows = await this.database.query.skillPackageResources.findMany({
        where: eq(skillPackageResources.packageRecordId, packageRecord.id),
      });
      const byPath = new Map(rows.map((resource) => [resource.resourcePath, resource]));
      if (rows.length !== manifest.resources.length || byPath.size !== rows.length) {
        throw new Error('SKILL_PACKAGE_RESOURCE_INVENTORY_INVALID');
      }
      const resources: SkillPackageContentResource[] = [];
      for (const expected of manifest.resources) {
        const row = byPath.get(expected.path);
        if (
          !row ||
          row.mediaType !== expected.media_type ||
          row.byteSize !== expected.byte_size ||
          row.contentHash !== expected.content_hash
        ) {
          throw new Error('SKILL_PACKAGE_RESOURCE_DIGEST_MISMATCH');
        }
        resources.push({
          path: row.resourcePath,
          mediaType: expected.media_type,
          content: await this.reader.read(row.storageKey, resourceLimit(row.mediaType)),
        });
      }
      const validation = validateSkillPackageContents({ manifest, resources });
      return this.result(payload, 'passed', 'clear', 'SKILL_PACKAGE_VALID', {
        skill_count: validation.skills.length,
        text_resource_count: validation.textResourceCount,
        binary_resource_count: validation.binaryResourceCount,
      });
    } catch (error) {
      const ruleId = stableRuleId(error);
      return this.result(
        payload,
        'failed',
        criticalRuleIds.has(ruleId) ? 'critical' : 'error',
        ruleId,
        {},
      );
    }
  }

  async complete(
    payload: ValidationPayload,
    claim: ClaimedSkillPackageValidation,
    result: SkillPackageValidationResult,
    now: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [report] = await transaction
        .select({
          id: skillPackageValidationReports.id,
          packageRecordId: skillPackageValidationReports.packageRecordId,
          revision: skillPackageValidationReports.revision,
          packageRevision: skillPackageValidationReports.packageRevision,
          packageDigest: skillPackageValidationReports.packageDigest,
          packageStatus: skillPackages.status,
          currentPackageRevision: skillPackages.revision,
          currentPackageDigest: skillPackages.packageDigest,
          latestValidationReportId: skillPackages.latestValidationReportId,
          approvedValidationReportId: skillPackages.approvedValidationReportId,
        })
        .from(skillPackageValidationReports)
        .innerJoin(
          skillPackages,
          eq(skillPackages.id, skillPackageValidationReports.packageRecordId),
        )
        .where(
          and(
            eq(skillPackageValidationReports.id, payload.validation_report_id),
            eq(skillPackageValidationReports.processingOwner, claim.owner),
            eq(skillPackageValidationReports.revision, claim.revision),
            eq(skillPackageValidationReports.status, 'running'),
            gt(skillPackageValidationReports.processingLeaseExpiresAt, now),
          ),
        )
        .for('update');
      if (!report) return false;
      const snapshotDrift =
        report.packageRevision !== report.currentPackageRevision ||
        report.packageDigest !== report.currentPackageDigest ||
        report.packageDigest !== payload.package_digest ||
        report.latestValidationReportId !== report.id;
      const effectiveResult = snapshotDrift
        ? this.result(payload, 'cancelled', 'error', 'SKILL_PACKAGE_SNAPSHOT_DRIFT', {})
        : result;
      const reportJson = {
        schema_version: 1,
        result: effectiveResult.status,
        severity: effectiveResult.severity,
        rule_id: effectiveResult.ruleId,
        summary: effectiveResult.summary,
      };
      const [updated] = await transaction
        .update(skillPackageValidationReports)
        .set({
          status: effectiveResult.status,
          revision: report.revision + 1,
          reportJson,
          reportDigest: effectiveResult.reportDigest,
          processingOwner: null,
          processingLeaseExpiresAt: null,
          completedAt: now,
        })
        .where(
          and(
            eq(skillPackageValidationReports.id, report.id),
            eq(skillPackageValidationReports.processingOwner, claim.owner),
            eq(skillPackageValidationReports.revision, report.revision),
          ),
        )
        .returning({ id: skillPackageValidationReports.id });
      if (!updated) return false;
      const isRevalidation =
        report.packageStatus === 'approved' && Boolean(report.approvedValidationReportId);
      const packageStatus =
        effectiveResult.severity === 'critical'
          ? 'disabled'
          : isRevalidation
            ? 'approved'
            : effectiveResult.status === 'passed'
              ? 'ready_for_review'
              : 'validation_failed';
      const riskUpdate = isRevalidation
        ? effectiveResult.status === 'passed'
          ? {
              riskStatus: 'clear' as const,
              riskReviewDueAt: null,
              riskBlockedAt: null,
            }
          : effectiveResult.severity === 'critical'
            ? {
                riskStatus: 'critical' as const,
                riskReviewDueAt: null,
                riskBlockedAt: now,
              }
            : {
                riskStatus: 'needs_review' as const,
                riskReviewDueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
                riskBlockedAt: null,
              }
        : {};
      if (!snapshotDrift && report.latestValidationReportId === report.id) {
        await transaction
          .update(skillPackages)
          .set({
            status: packageStatus,
            ...riskUpdate,
            ...(effectiveResult.severity === 'critical'
              ? {
                  riskStatus: 'critical' as const,
                  riskBlockedAt: now,
                  disabledBy: 'system',
                  disabledReason: effectiveResult.ruleId,
                  disabledAt: now,
                }
              : {}),
          })
          .where(
            and(
              eq(skillPackages.id, report.packageRecordId),
              eq(skillPackages.revision, report.currentPackageRevision),
              eq(skillPackages.packageDigest, report.currentPackageDigest!),
              eq(skillPackages.latestValidationReportId, report.id),
            ),
          );
      }
      await transaction.insert(adminAuditLogs).values({
        actorType: 'system',
        action: 'skill_package.validation_completed',
        targetType: 'skill_package_validation_report',
        targetId: report.id,
        afterJson: {
          status: effectiveResult.status,
          severity: effectiveResult.severity,
          rule_id: effectiveResult.ruleId,
          report_digest: effectiveResult.reportDigest,
        },
        result:
          effectiveResult.status === 'passed'
            ? 'succeeded'
            : effectiveResult.severity === 'critical'
              ? 'blocked'
              : 'failed',
      });
      return true;
    });
  }

  private result(
    payload: ValidationPayload,
    status: SkillPackageValidationResult['status'],
    severity: SkillPackageValidationResult['severity'],
    ruleId: string,
    summary: Record<string, string | number>,
  ): SkillPackageValidationResult {
    return {
      status,
      severity,
      ruleId,
      summary,
      reportDigest: canonicalSha256({
        package_digest: payload.package_digest,
        validator_contract_version: payload.validator_contract_version,
        platform_eval_suite_digest: payload.platform_eval_suite_digest,
        status,
        severity,
        rule_id: ruleId,
        summary,
      }),
    };
  }
}
