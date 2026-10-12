import {
  agentTranscriptItems,
  agentTranscriptPayloads,
  and,
  asc,
  chatSessions,
  eq,
  lte,
  sql,
  type Database,
} from '@ecom-forge/db';

import {
  advanceTranscriptGenerationForCleanup,
  TRANSCRIPT_ARCHIVE_RETENTION,
} from './agent-transcript-lifecycle.js';
import { withTranscriptQueryBudget } from './agent-transcript-write-transaction.js';

const DAY_MS = 86_400_000;

/** Bound on retained failure detail so one pass can never emit unbounded diagnostics. */
const FAILURE_DETAIL_LIMIT = 5;

function remainingTranscript() {
  return sql`(exists (select 1 from ${agentTranscriptItems} where ${agentTranscriptItems.sessionId} = ${chatSessions.id})
    or exists (select 1 from ${agentTranscriptPayloads} where ${agentTranscriptPayloads.sessionId} = ${chatSessions.id}))`;
}

/** Controlled PostgreSQL error code (or a stable fallback); never carries message text. */
function transcriptCleanupFailureCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return 'unexpected';
}

export interface TranscriptLifecycleSweepSummary {
  sessions: number;
  items: number;
  payloads: number;
  failed: number;
  /** Controlled failure codes (never message text) for sessions that failed during this pass. */
  failures: string[];
}

/**
 * Removes archived transcript storage after the audit snapshot window. Each session is handled in
 * its own short transaction so a bad row cannot prevent unrelated sessions from being cleaned.
 */
export class AgentTranscriptLifecycleSweeper {
  constructor(
    private readonly database: Database,
    private readonly batchSize: number,
  ) {}

  async sweep(now = new Date()): Promise<TranscriptLifecycleSweepSummary> {
    const physicalDeleteBefore = new Date(
      now.getTime() - TRANSCRIPT_ARCHIVE_RETENTION.physicalDays * DAY_MS,
    );
    const candidates = await this.database
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          sql`${chatSessions.archivedAt} is not null`,
          lte(chatSessions.archivedAt, physicalDeleteBefore),
          // Only a session that still holds transcript rows has physical work left, and deleting
          // those rows is exactly what makes a cleaned session stop matching afterwards — so this
          // predicate both targets the real work and keeps a cleaned session from starving later
          // batches. A failed cleanup keeps its items and is therefore retried on the next run.
          remainingTranscript(),
        ),
      )
      .orderBy(asc(chatSessions.archivedAt), asc(chatSessions.id))
      .limit(this.batchSize);

    const summary: TranscriptLifecycleSweepSummary = {
      sessions: 0,
      items: 0,
      payloads: 0,
      failed: 0,
      failures: [],
    };
    for (const candidate of candidates) {
      try {
        const result = await this.database.transaction((transaction) =>
          withTranscriptQueryBudget(transaction, async (query) => {
            const [session] = await query((tx) =>
              tx
                .select({ id: chatSessions.id, userId: chatSessions.userId })
                .from(chatSessions)
                .where(
                  and(
                    eq(chatSessions.id, candidate.id),
                    sql`${chatSessions.archivedAt} is not null`,
                    lte(chatSessions.archivedAt, physicalDeleteBefore),
                    remainingTranscript(),
                  ),
                )
                .for('update', { skipLocked: true }),
            );
            if (!session) return null;

            await advanceTranscriptGenerationForCleanup(
              transaction,
              {
                userId: session.userId,
                sessionId: session.id,
              },
              query,
            );

            const payloads = await query((tx) =>
              tx
                .delete(agentTranscriptPayloads)
                .where(eq(agentTranscriptPayloads.sessionId, session.id))
                .returning({ id: agentTranscriptPayloads.id }),
            );
            // Tool results hold the only self-reference in this append-only table. Delete them
            // before their assistant call parents, then remove the remaining session items.
            const toolResults = await query((tx) =>
              tx
                .delete(agentTranscriptItems)
                .where(
                  and(
                    eq(agentTranscriptItems.sessionId, session.id),
                    eq(agentTranscriptItems.itemType, 'tool_result'),
                  ),
                )
                .returning({ id: agentTranscriptItems.id }),
            );
            const items = await query((tx) =>
              tx
                .delete(agentTranscriptItems)
                .where(eq(agentTranscriptItems.sessionId, session.id))
                .returning({ id: agentTranscriptItems.id }),
            );
            return {
              items: toolResults.length + items.length,
              payloads: payloads.length,
            };
          }),
        );
        if (!result) continue;
        summary.sessions += 1;
        summary.items += result.items;
        summary.payloads += result.payloads;
      } catch (error) {
        summary.failed += 1;
        if (summary.failures.length < FAILURE_DETAIL_LIMIT) {
          summary.failures.push(transcriptCleanupFailureCode(error));
        }
      }
    }
    return summary;
  }
}
