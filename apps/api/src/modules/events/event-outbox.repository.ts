import {
  agentTurns,
  and,
  asc,
  eq,
  eventOutbox,
  gt,
  max,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';

import type { OutboxEventProjection } from './event-contract.js';
import type { EventScopeType } from './event-query.js';

export class EventOutboxRepository {
  constructor(private readonly database: Database) {}

  async isOwnedScope(userId: string, scopeType: EventScopeType, scopeId: string): Promise<boolean> {
    const [owned] =
      scopeType === 'workflow_run'
        ? await this.database
            .select({ id: workflowRuns.id })
            .from(workflowRuns)
            .where(and(eq(workflowRuns.id, scopeId), eq(workflowRuns.userId, userId)))
            .limit(1)
        : await this.database
            .select({ id: agentTurns.id })
            .from(agentTurns)
            .where(and(eq(agentTurns.id, scopeId), eq(agentTurns.userId, userId)))
            .limit(1);
    return owned !== undefined;
  }

  async highWatermark(scopeType: EventScopeType, scopeId: string): Promise<number> {
    const [row] = await this.database
      .select({ eventSeq: max(eventOutbox.eventSeq) })
      .from(eventOutbox)
      .where(and(eq(eventOutbox.scopeType, scopeType), eq(eventOutbox.scopeId, scopeId)));
    return Number(row?.eventSeq ?? 0);
  }

  async listAfter(
    scopeType: EventScopeType,
    scopeId: string,
    lastEventSeq: number,
    limit: number,
  ): Promise<OutboxEventProjection[]> {
    return this.database
      .select({
        eventSeq: eventOutbox.eventSeq,
        eventType: eventOutbox.eventType,
        payload: eventOutbox.payload,
        createdAt: eventOutbox.createdAt,
      })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.scopeType, scopeType),
          eq(eventOutbox.scopeId, scopeId),
          gt(eventOutbox.eventSeq, lastEventSeq),
        ),
      )
      .orderBy(asc(eventOutbox.eventSeq))
      .limit(limit);
  }
}
