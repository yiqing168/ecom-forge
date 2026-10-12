import { describe, expect, it, vi } from 'vitest';

import {
  TRANSCRIPT_ARCHIVE_RETENTION,
  advanceTranscriptGenerationForCleanup,
  invalidateTranscriptForLifecycle,
  planTranscriptArchiveCleanup,
  transcriptLifecycleReasonSchema,
  type TranscriptLifecycleTransaction,
} from './agent-transcript-lifecycle.js';

const DAY_MS = 86_400_000;
const userId = '5b1d0a2c-0000-4000-8000-000000000001';
const sessionId = '5b1d0a2c-0000-4000-8000-000000000002';
const archivedAt = '2026-01-01T00:00:00.000Z';

describe('transcript archive cleanup plan', () => {
  it('uses the audit snapshot window (physical 180 days / backup 365 days)', () => {
    expect(TRANSCRIPT_ARCHIVE_RETENTION).toEqual({ physicalDays: 180, backupDays: 365 });
  });

  it('is not eligible before the physical retention boundary', () => {
    const plan = planTranscriptArchiveCleanup({
      archivedAt,
      now: new Date(new Date(archivedAt).getTime() + 179 * DAY_MS),
    });
    expect(plan.physical_delete_eligible_at).toBe(
      new Date(new Date(archivedAt).getTime() + 180 * DAY_MS).toISOString(),
    );
    expect(plan.backup_expiry_at).toBe(
      new Date(new Date(archivedAt).getTime() + 365 * DAY_MS).toISOString(),
    );
    expect(plan.eligible_for_physical_delete).toBe(false);
  });

  it('is eligible exactly at the physical boundary and keeps backups 365 days', () => {
    const boundary = new Date(new Date(archivedAt).getTime() + 180 * DAY_MS);
    expect(
      planTranscriptArchiveCleanup({ archivedAt, now: boundary }).eligible_for_physical_delete,
    ).toBe(true);
    expect(
      planTranscriptArchiveCleanup({
        archivedAt,
        now: new Date(boundary.getTime() - 1),
      }).eligible_for_physical_delete,
    ).toBe(false);
    const plan = planTranscriptArchiveCleanup({
      archivedAt,
      now: new Date(new Date(archivedAt).getTime() + 400 * DAY_MS),
    });
    expect(plan.backup_expiry_at).toBe(
      new Date(new Date(archivedAt).getTime() + 365 * DAY_MS).toISOString(),
    );
    expect(plan.retention).toEqual({ physical_days: 180, backup_days: 365 });
  });

  it('rejects an invalid archive timestamp', () => {
    expect(() =>
      planTranscriptArchiveCleanup({ archivedAt: 'not-a-date', now: new Date() }),
    ).toThrow('TURN_STATE_INVALID');
  });
});

describe('transcript lifecycle invalidation input contract', () => {
  it('accepts only the bounded lifecycle reasons', () => {
    expect(transcriptLifecycleReasonSchema.options).toEqual([
      'resource_revoked',
      'resource_isolated',
      'version_drift',
      'cleanup',
    ]);
  });

  it('rejects an unknown reason before touching the transaction', async () => {
    const transaction = {
      select: vi.fn(),
      update: vi.fn(),
    } as unknown as TranscriptLifecycleTransaction;
    await expect(
      invalidateTranscriptForLifecycle(transaction, {
        userId,
        sessionId,
        // @ts-expect-error unknown lifecycle reason
        reason: 'sweeper_only',
      }),
    ).rejects.toThrow('TURN_STATE_INVALID');
    expect(transaction.select).not.toHaveBeenCalled();
  });

  it('rejects a malformed scope before any query', async () => {
    const transaction = {
      select: vi.fn(),
      update: vi.fn(),
    } as unknown as TranscriptLifecycleTransaction;
    await expect(
      invalidateTranscriptForLifecycle(transaction, {
        userId: 'not-a-uuid',
        sessionId,
        reason: 'resource_revoked',
      }),
    ).rejects.toThrow('TURN_STATE_INVALID');
    await expect(
      advanceTranscriptGenerationForCleanup(transaction, { userId, sessionId: 'nope' }),
    ).rejects.toThrow('TURN_STATE_INVALID');
    expect(transaction.select).not.toHaveBeenCalled();
  });
});
