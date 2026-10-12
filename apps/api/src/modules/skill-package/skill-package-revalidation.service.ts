import { randomUUID } from 'node:crypto';

import {
  adminAuditLogs,
  and,
  desc,
  eq,
  skillPackages,
  skillPackageValidationReports,
  sql,
  type Database,
} from '@ecom-forge/db';
import { createQueueIntentInTransaction } from '@ecom-forge/queue';
import { canonicalSha256, scopedAdvisoryLockKey } from '@ecom-forge/shared';

import type { AppEnvironment } from '../../config/app-config.js';
import {
  isAuthorizedSkillPackageActor,
  skillPackageAuditActor,
  type SkillPackageActor,
} from './skill-package-actor.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class SkillPackageRevalidationError extends Error {
  constructor(
    readonly code:
      | 'SKILL_PACKAGE_REVALIDATION_FORBIDDEN'
      | 'SKILL_PACKAGE_REVALIDATION_INVALID'
      | 'SKILL_PACKAGE_REVALIDATION_CONFLICT',
  ) {
    super(code);
    this.name = 'SkillPackageRevalidationError';
  }
}

export class SkillPackageRevalidationService {
  constructor(
    private readonly database: Database,
    private readonly appEnv: AppEnvironment,
  ) {}

  async createAttempt(input: {
    packageRecordId: string;
    expectedPackageRevision: number;
    validatorContractVersion: string;
    platformEvalSuiteDigest: string;
    reason: string;
    actor: SkillPackageActor;
  }): Promise<{ validationReportId: string; queueIntentId: string; attemptNo: number }> {
    return this.database.transaction((transaction) =>
      this.createAttemptInTransaction(transaction, input),
    );
  }

  async createAttemptInTransaction(
    transaction: Transaction,
    input: {
      packageRecordId: string;
      expectedPackageRevision: number;
      validatorContractVersion: string;
      platformEvalSuiteDigest: string;
      reason: string;
      actor: SkillPackageActor;
    },
  ): Promise<{ validationReportId: string; queueIntentId: string; attemptNo: number }> {
    if (!isAuthorizedSkillPackageActor(input.actor, this.appEnv)) {
      throw new SkillPackageRevalidationError('SKILL_PACKAGE_REVALIDATION_FORBIDDEN');
    }
    if (
      !input.reason.trim() ||
      !input.validatorContractVersion.trim() ||
      !/^[a-f0-9]{64}$/.test(input.platformEvalSuiteDigest)
    ) {
      throw new SkillPackageRevalidationError('SKILL_PACKAGE_REVALIDATION_INVALID');
    }
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('skill-package-revalidation', input.packageRecordId)})`,
    );
    const packageRecord = await transaction.query.skillPackages.findFirst({
      where: and(
        eq(skillPackages.id, input.packageRecordId),
        eq(skillPackages.revision, input.expectedPackageRevision),
      ),
    });
    const isInitialValidation = packageRecord
      ? ['uploaded', 'validation_failed'].includes(packageRecord.status) &&
        !packageRecord.approvedValidationReportId
      : false;
    const isRevalidation =
      packageRecord?.status === 'approved' && Boolean(packageRecord.approvedValidationReportId);
    if (
      !packageRecord ||
      (!isInitialValidation && !isRevalidation) ||
      !packageRecord.packageDigest ||
      packageRecord.disabledAt
    ) {
      throw new SkillPackageRevalidationError('SKILL_PACKAGE_REVALIDATION_CONFLICT');
    }
    const latestReport = packageRecord.latestValidationReportId
      ? await transaction.query.skillPackageValidationReports.findFirst({
          where: eq(skillPackageValidationReports.id, packageRecord.latestValidationReportId),
        })
      : undefined;
    if (latestReport && ['queued', 'running'].includes(latestReport.status)) {
      throw new SkillPackageRevalidationError('SKILL_PACKAGE_REVALIDATION_CONFLICT');
    }
    const [lastAttempt] = await transaction
      .select({ attemptNo: skillPackageValidationReports.attemptNo })
      .from(skillPackageValidationReports)
      .where(eq(skillPackageValidationReports.packageRecordId, packageRecord.id))
      .orderBy(desc(skillPackageValidationReports.attemptNo))
      .limit(1);
    const attemptNo = (lastAttempt?.attemptNo ?? 0) + 1;
    const validationReportId = randomUUID();
    await transaction.insert(skillPackageValidationReports).values({
      id: validationReportId,
      packageRecordId: packageRecord.id,
      packageRevision: packageRecord.revision,
      packageDigest: packageRecord.packageDigest,
      attemptNo,
      status: 'queued',
      validatorContractVersion: input.validatorContractVersion,
      platformEvalSuiteDigest: input.platformEvalSuiteDigest,
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
        package_record_id: packageRecord.id,
        validation_report_id: validationReportId,
        attempt_no: attemptNo,
        package_digest: packageRecord.packageDigest,
        validator_contract_version: input.validatorContractVersion,
        platform_eval_suite_digest: input.platformEvalSuiteDigest,
      },
    });
    await transaction
      .update(skillPackageValidationReports)
      .set({ queueIntentId: queueIntent.id })
      .where(eq(skillPackageValidationReports.id, validationReportId));
    const [updated] = await transaction
      .update(skillPackages)
      .set({
        latestValidationReportId: validationReportId,
        ...(isInitialValidation ? { status: 'validating' as const } : {}),
      })
      .where(
        and(
          eq(skillPackages.id, packageRecord.id),
          eq(skillPackages.revision, packageRecord.revision),
        ),
      )
      .returning({ id: skillPackages.id });
    if (!updated) throw new SkillPackageRevalidationError('SKILL_PACKAGE_REVALIDATION_CONFLICT');
    await transaction.insert(adminAuditLogs).values({
      ...skillPackageAuditActor(input.actor),
      action: 'skill_package.revalidation_created',
      targetType: 'skill_package_validation_report',
      targetId: validationReportId,
      afterJson: {
        package_digest: packageRecord.packageDigest,
        attempt_no: attemptNo,
        validator_contract_version: input.validatorContractVersion,
        platform_eval_suite_digest: input.platformEvalSuiteDigest,
      },
      reason: input.reason,
      idempotencyKeyHash: canonicalSha256({
        package_record_id: packageRecord.id,
        attempt_no: attemptNo,
      }),
      result: 'succeeded',
    });
    return { validationReportId, queueIntentId: queueIntent.id, attemptNo };
  }
}
