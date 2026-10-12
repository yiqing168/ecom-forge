import { transcriptSequenceSchema } from '@ecom-forge/agent';
import { and, chatSessions, eq } from '@ecom-forge/db';
import { z } from 'zod';

import { WORKER_RUNTIME_DEFAULTS } from '../config/runtime-defaults.js';
import type { Transaction } from './agent-turn.types.js';

/**
 * Lifecycle driver for S08 semantic history (`08` §4.1, `05` transcript lifecycle).
 *
 * A resource deletion, isolation, risk freeze or version drift must make every affected
 * summary/checkpoint immediately unusable — never "once the asynchronous sweeper runs". Because
 * we cannot prove a projection excludes revoked content, the whole checkpoint is invalidated:
 * the transaction advances `transcript_generation` (which fences the projection caches and any
 * in-flight reader) and clears the reusable summary so no stale checkpoint can be injected into
 * the next model call.
 */

const DAY_MS = 86_400_000;

export const TRANSCRIPT_ARCHIVE_RETENTION = Object.freeze({
  /** Audit-snapshot physical retention after session archival (`08` §4.1). */
  physicalDays: WORKER_RUNTIME_DEFAULTS.transcriptArchivePhysicalRetentionDays,
  /** Audit-snapshot backup retention after session archival (`08` §4.1). */
  backupDays: WORKER_RUNTIME_DEFAULTS.transcriptArchiveBackupRetentionDays,
});

export const transcriptLifecycleReasonSchema = z.enum([
  'resource_revoked',
  'resource_isolated',
  'version_drift',
  'cleanup',
]);
export type TranscriptLifecycleReason = z.infer<typeof transcriptLifecycleReasonSchema>;

const invalidationInputSchema = z.strictObject({
  userId: z.uuid().toLowerCase(),
  sessionId: z.uuid().toLowerCase(),
  reason: transcriptLifecycleReasonSchema,
});

export interface TranscriptGenerationAdvance {
  /** New `transcript_generation` as a decimal string (never a raw JS number). */
  readonly generation: string;
  readonly invalidated: true;
  readonly reason: TranscriptLifecycleReason;
}

/** Minimal transaction surface: a single controlled transaction, never a network hop. */
export type TranscriptLifecycleTransaction = Pick<Transaction, 'select' | 'update'>;
type LifecycleQuery = <T>(
  build: (transaction: TranscriptLifecycleTransaction) => PromiseLike<T>,
) => Promise<T>;

/**
 * Advance `transcript_generation` and invalidate the reusable summary/checkpoint in one short
 * transaction. The session row is locked (`for update`) so concurrent revocations serialize and
 * cannot lose an increment. Idempotent-safe: repeating the operation only advances the cursor
 * monotonically and never resurrects revoked content.
 */
export async function invalidateTranscriptForLifecycle(
  transaction: TranscriptLifecycleTransaction,
  raw: { userId: string; sessionId: string; reason: TranscriptLifecycleReason },
  query: LifecycleQuery = (build) => Promise.resolve(build(transaction)),
): Promise<TranscriptGenerationAdvance> {
  const parsed = invalidationInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error('TURN_STATE_INVALID');
  const { userId, sessionId, reason } = parsed.data;

  const [session] = await query((tx) =>
    tx
      .select({
        id: chatSessions.id,
        generation: chatSessions.transcriptGeneration,
      })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
      .for('update'),
  );
  if (!session) throw new Error('AGENT_SESSION_MISSING');

  const current = BigInt(transcriptSequenceSchema.parse(session.generation.toString()));
  const next = current + 1n;

  const advanced = await query((tx) =>
    tx
      .update(chatSessions)
      .set({
        transcriptGeneration: next,
        // A checkpoint we cannot prove is free of revoked content must not be reused.
        summaryJson: {},
        summaryVersion: 0,
        summaryThroughTurnId: null,
      })
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.userId, userId),
          eq(chatSessions.transcriptGeneration, session.generation),
        ),
      )
      .returning({ id: chatSessions.id }),
  );
  if (advanced.length !== 1) throw new Error('AGENT_TRANSCRIPT_HISTORY_CHANGED');

  return Object.freeze({ generation: next.toString(), invalidated: true, reason });
}

/** Cleanup/revocation job entry point; same transaction as the cleanup it accompanies. */
export async function advanceTranscriptGenerationForCleanup(
  transaction: TranscriptLifecycleTransaction,
  input: { userId: string; sessionId: string },
  query?: LifecycleQuery,
): Promise<TranscriptGenerationAdvance> {
  return invalidateTranscriptForLifecycle(transaction, { ...input, reason: 'cleanup' }, query);
}

export interface TranscriptArchiveCleanupPlan {
  readonly archived_at: string;
  readonly physical_delete_eligible_at: string;
  readonly backup_expiry_at: string;
  readonly eligible_for_physical_delete: boolean;
  readonly retention: { readonly physical_days: number; readonly backup_days: number };
}

/**
 * Pure archive cleanup boundary plan. Archived transcript and private payloads follow the audit
 * snapshot window: physical retention (180 days) then backup expiry (365 days) after archival.
 * Nothing is deletable before the physical boundary.
 */
export function planTranscriptArchiveCleanup(input: {
  archivedAt: Date | string;
  now: Date | string;
}): TranscriptArchiveCleanupPlan {
  const archivedAt = new Date(input.archivedAt);
  const now = new Date(input.now);
  if (Number.isNaN(archivedAt.getTime()) || Number.isNaN(now.getTime())) {
    throw new Error('TURN_STATE_INVALID');
  }
  const physicalAt = new Date(
    archivedAt.getTime() + TRANSCRIPT_ARCHIVE_RETENTION.physicalDays * DAY_MS,
  );
  const backupAt = new Date(
    archivedAt.getTime() + TRANSCRIPT_ARCHIVE_RETENTION.backupDays * DAY_MS,
  );
  return Object.freeze({
    archived_at: archivedAt.toISOString(),
    physical_delete_eligible_at: physicalAt.toISOString(),
    backup_expiry_at: backupAt.toISOString(),
    eligible_for_physical_delete: now.getTime() >= physicalAt.getTime(),
    retention: {
      physical_days: TRANSCRIPT_ARCHIVE_RETENTION.physicalDays,
      backup_days: TRANSCRIPT_ARCHIVE_RETENTION.backupDays,
    },
  });
}
