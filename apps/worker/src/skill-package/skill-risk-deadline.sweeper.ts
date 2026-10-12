import {
  adminAuditLogs,
  and,
  asc,
  eq,
  eventOutbox,
  isNull,
  lte,
  skillPackages,
  type Database,
} from '@ecom-forge/db';

export class SkillRiskDeadlineSweeper {
  constructor(
    private readonly database: Database,
    private readonly batchSize = 100,
  ) {}

  async sweep(now = new Date()): Promise<number> {
    const due = await this.database
      .select({ id: skillPackages.id, revision: skillPackages.revision })
      .from(skillPackages)
      .where(
        and(
          eq(skillPackages.riskStatus, 'needs_review'),
          lte(skillPackages.riskReviewDueAt, now),
          isNull(skillPackages.riskBlockedAt),
        ),
      )
      .orderBy(
        asc(skillPackages.riskStatus),
        asc(skillPackages.riskReviewDueAt),
        asc(skillPackages.id),
      )
      .limit(this.batchSize);
    let blocked = 0;
    for (const candidate of due) {
      const changed = await this.database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(skillPackages)
          .set({ riskBlockedAt: now, revision: candidate.revision + 1 })
          .where(
            and(
              eq(skillPackages.id, candidate.id),
              eq(skillPackages.revision, candidate.revision),
              eq(skillPackages.riskStatus, 'needs_review'),
              lte(skillPackages.riskReviewDueAt, now),
              isNull(skillPackages.riskBlockedAt),
            ),
          )
          .returning({ id: skillPackages.id });
        if (!updated) return false;
        await transaction.insert(adminAuditLogs).values({
          actorType: 'system',
          action: 'skill_package.risk_deadline_blocked',
          targetType: 'skill_package',
          targetId: candidate.id,
          afterJson: { risk_status: 'needs_review', risk_blocked: true },
          reason: 'risk review deadline elapsed',
          result: 'blocked',
        });
        await transaction.insert(eventOutbox).values({
          scopeType: 'skill_package',
          scopeId: candidate.id,
          eventSeq: candidate.revision + 1,
          eventType: 'skill_package.risk_deadline_blocked',
          payload: {
            package_record_id: candidate.id,
            risk_status: 'needs_review',
            risk_blocked: true,
          },
          retentionTier: 'critical',
        });
        return true;
      });
      if (changed) blocked += 1;
    }
    return blocked;
  }
}
