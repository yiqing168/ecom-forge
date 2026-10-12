import { createHmac } from 'node:crypto';

import {
  agentSessionMutations,
  agentTraces,
  agentTurnConfirmations,
  agentTurns,
  and,
  asc,
  chatMessages,
  chatSessions,
  desc,
  eq,
  eventOutbox,
  inArray,
  lt,
  max,
  or,
  sql,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import {
  canonicalSha256,
  scopedAdvisoryLockKey,
  createSessionCreativeDirectionSnapshot,
  parseSessionCreativeDirectionSnapshot,
} from '@ecom-forge/shared';

import { SignedCursorCodec, SignedCursorError } from '../../shared/http/signed-cursor.js';
import { agentError } from './agent.errors.js';
import type {
  ArchiveSessionInput,
  RenameSessionInput,
  SessionDetailQuery,
  SessionListQuery,
} from './agent.schemas.js';
import { publicAgentModelSelection } from './agent-model-selection.service.js';
import { publicAgentAttachments, publicPendingConfirmation } from './agent-public-projection.js';
import { agentUserStatus } from './agent-status.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type MutationOperation = 'rename' | 'archive';

const TERMINAL_TURN_SQL = sql`('done','blocked','failed','cancelled','superseded')`;
const TERMINAL_WORKFLOW_SQL = sql`('succeeded','failed','cancelled','refunded')`;

function messagePreview(content: string): string {
  return content.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function publicSkillSelection(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as Record<string, unknown>;
  const presets = Array.isArray(value.preset_selections)
    ? value.preset_selections.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const item = entry as Record<string, unknown>;
        return typeof item.slot === 'string' &&
          typeof item.preset_id === 'string' &&
          typeof item.name === 'string'
          ? [{ slot: item.slot, preset_id: item.preset_id, name: item.name }]
          : [];
      })
    : [];
  if (typeof value.primary_skill_id !== 'string' || typeof value.primary_name !== 'string') {
    return null;
  }
  return {
    primary_skill_id: value.primary_skill_id,
    primary_name: value.primary_name,
    preset_selections: presets,
  };
}

function publicExecutionAuthorization(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as Record<string, unknown>;
  return value.schema_version === 2 && value.kind === 'generate_action'
    ? { kind: 'generate_action' as const }
    : null;
}

function publicModelSelection(snapshot: unknown) {
  if (!snapshot) return null;
  return publicAgentModelSelection(snapshot);
}

export class AgentSessionService {
  private readonly cursor: SignedCursorCodec;

  constructor(
    private readonly database: Database,
    private readonly idempotencySecret: string,
    cursorSecret: string,
  ) {
    this.cursor = new SignedCursorCodec(cursorSecret);
  }

  async list(userId: string, input: SessionListQuery) {
    const filters = { query: input.query ?? null, limit: input.limit };
    const position = this.decodeCursor(input.cursor, userId, 'agent-sessions', filters);
    return this.database.transaction(
      async (transaction) => {
        const rows = await transaction
          .select()
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.userId, userId),
              sql`${chatSessions.archivedAt} is null`,
              input.query
                ? sql`position(lower(${input.query}) in lower(${chatSessions.title})) > 0`
                : undefined,
              position
                ? or(
                    lt(chatSessions.updatedAt, position.createdAt),
                    and(
                      eq(chatSessions.updatedAt, position.createdAt),
                      lt(chatSessions.id, position.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(chatSessions.updatedAt), desc(chatSessions.id))
          .limit(input.limit + 1);
        const page = rows.slice(0, input.limit);
        const ids = page.map((row) => row.id);
        const [latestMessages, latestTurns] =
          ids.length === 0
            ? [[], []]
            : await Promise.all([
                transaction
                  .selectDistinctOn([chatMessages.sessionId], {
                    sessionId: chatMessages.sessionId,
                    content: chatMessages.content,
                  })
                  .from(chatMessages)
                  .where(
                    and(
                      inArray(chatMessages.sessionId, ids),
                      inArray(chatMessages.role, ['user', 'assistant']),
                    ),
                  )
                  .orderBy(
                    chatMessages.sessionId,
                    desc(chatMessages.createdAt),
                    desc(chatMessages.id),
                  ),
                transaction
                  .selectDistinctOn([agentTurns.sessionId], {
                    sessionId: agentTurns.sessionId,
                    id: agentTurns.id,
                    status: agentTurns.status,
                  })
                  .from(agentTurns)
                  .where(inArray(agentTurns.sessionId, ids))
                  .orderBy(agentTurns.sessionId, desc(agentTurns.createdAt), desc(agentTurns.id)),
              ]);
        const messageBySession = new Map(
          latestMessages.map((message) => [message.sessionId, messagePreview(message.content)]),
        );
        const turnBySession = new Map(latestTurns.map((turn) => [turn.sessionId, turn]));
        const last = page.at(-1);
        return {
          items: page.map((session) => {
            const turn = turnBySession.get(session.id);
            return {
              id: session.id,
              title: session.title,
              revision: session.revision,
              last_message_preview: messageBySession.get(session.id) ?? '',
              last_turn_id: turn?.id ?? null,
              last_turn_status: turn ? agentUserStatus(turn.status) : null,
              updated_at: session.updatedAt.toISOString(),
            };
          }),
          next_cursor:
            rows.length > input.limit && last
              ? this.cursor.encode({
                  userId,
                  endpoint: 'agent-sessions',
                  filters,
                  position: { createdAt: last.updatedAt, id: last.id },
                })
              : null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async get(userId: string, sessionId: string, input: SessionDetailQuery) {
    const filters = { session_id: sessionId, limit: input.limit };
    const position = this.decodeCursor(input.cursor, userId, 'agent-session-messages', filters);
    return this.database.transaction(
      async (transaction) => {
        const session = await transaction.query.chatSessions.findFirst({
          where: and(
            eq(chatSessions.id, sessionId),
            eq(chatSessions.userId, userId),
            sql`${chatSessions.archivedAt} is null`,
          ),
        });
        if (!session) agentError('RESOURCE_NOT_FOUND');
        const messageRows = await transaction
          .select({
            id: chatMessages.id,
            role: chatMessages.role,
            content: chatMessages.content,
            attachments: chatMessages.attachments,
            turnId: chatMessages.turnId,
            createdAt: chatMessages.createdAt,
          })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.sessionId, sessionId),
              inArray(chatMessages.role, ['user', 'assistant']),
              position
                ? or(
                    lt(chatMessages.createdAt, position.createdAt),
                    and(
                      eq(chatMessages.createdAt, position.createdAt),
                      lt(chatMessages.id, position.id),
                    ),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
          .limit(input.limit + 1);
        const page = messageRows.slice(0, input.limit);
        const activeTurn = await transaction.query.agentTurns.findFirst({
          where: and(
            eq(agentTurns.sessionId, sessionId),
            eq(agentTurns.userId, userId),
            sql`${agentTurns.status} not in ${TERMINAL_TURN_SQL}`,
          ),
          orderBy: [desc(agentTurns.createdAt), desc(agentTurns.id)],
        });
        const firstTurn = await transaction.query.agentTurns.findFirst({
          where: and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId)),
          orderBy: [asc(agentTurns.createdAt), asc(agentTurns.id)],
          columns: { skillSelectionSnapshotJson: true },
        });
        const pinnedSkillSelection = publicSkillSelection(firstTurn?.skillSelectionSnapshotJson);
        const latestDirectionTurn = await transaction.query.agentTurns.findFirst({
          where: and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId)),
          orderBy: [desc(agentTurns.createdAt), desc(agentTurns.id)],
          columns: { generationPreferencesJson: true },
        });
        const latestPreferences = latestDirectionTurn?.generationPreferencesJson as
          { creative_direction?: unknown } | null | undefined;
        const creativeDirectionSnapshot =
          session.creativeDirectionSnapshotJson === null
            ? createSessionCreativeDirectionSnapshot(latestPreferences?.creative_direction)
            : parseSessionCreativeDirectionSnapshot(session.creativeDirectionSnapshotJson);
        if (
          !creativeDirectionSnapshot ||
          (session.creativeDirectionSnapshotJson !== null &&
            canonicalSha256(creativeDirectionSnapshot) !== session.creativeDirectionSnapshotHash)
        ) {
          agentError('TURN_STATE_INVALID');
        }
        const turnIds = [
          ...new Set([
            ...page.flatMap((message) => (message.turnId ? [message.turnId] : [])),
            ...(activeTurn ? [activeTurn.id] : []),
          ]),
        ];
        const turns = await this.turnSummaries(transaction, userId, sessionId, turnIds);
        const oldest = page.at(-1);
        return {
          session: {
            id: session.id,
            title: session.title,
            revision: session.revision,
            primary_skill_slug: session.primarySkillSlug,
            preset_selections: pinnedSkillSelection?.preset_selections ?? [],
            creative_direction_snapshot: creativeDirectionSnapshot,
            created_at: session.createdAt.toISOString(),
            updated_at: session.updatedAt.toISOString(),
          },
          messages: [...page].reverse().map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            attachments: publicAgentAttachments(message.attachments),
            turn_id: message.turnId,
            created_at: message.createdAt.toISOString(),
          })),
          turns,
          active_turn_id: activeTurn?.id ?? null,
          older_cursor:
            messageRows.length > input.limit && oldest
              ? this.cursor.encode({
                  userId,
                  endpoint: 'agent-session-messages',
                  filters,
                  position: { createdAt: oldest.createdAt, id: oldest.id },
                })
              : null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  rename(userId: string, sessionId: string, input: RenameSessionInput, idempotencyKey: string) {
    return this.mutate({
      userId,
      sessionId,
      operation: 'rename',
      idempotencyKey,
      request: { session_id: sessionId, ...input },
      write: async (transaction) => {
        const current = await this.lockSession(transaction, userId, sessionId);
        if (current.revision !== input.revision) agentError('SESSION_REVISION_CONFLICT');
        const now = new Date();
        const [updated] = await transaction
          .update(chatSessions)
          .set({ title: input.title, revision: input.revision + 1, updatedAt: now })
          .where(
            and(
              eq(chatSessions.id, sessionId),
              eq(chatSessions.userId, userId),
              eq(chatSessions.revision, input.revision),
              sql`${chatSessions.archivedAt} is null`,
            ),
          )
          .returning();
        if (!updated) agentError('SESSION_REVISION_CONFLICT');
        return {
          id: updated.id,
          title: updated.title,
          revision: updated.revision,
          updated_at: updated.updatedAt.toISOString(),
        };
      },
    });
  }

  archive(userId: string, sessionId: string, input: ArchiveSessionInput, idempotencyKey: string) {
    return this.mutate({
      userId,
      sessionId,
      operation: 'archive',
      idempotencyKey,
      request: { session_id: sessionId, ...input },
      write: async (transaction) => {
        const current = await this.lockSession(transaction, userId, sessionId);
        if (current.revision !== input.revision) agentError('SESSION_REVISION_CONFLICT');
        await this.assertArchivable(transaction, userId, sessionId);
        const now = new Date();
        const [updated] = await transaction
          .update(chatSessions)
          .set({
            archivedAt: now,
            revision: input.revision + 1,
            updatedAt: now,
            transcriptGeneration: current.transcriptGeneration + 1n,
            summaryJson: {},
            summaryVersion: 0,
            summaryThroughTurnId: null,
          })
          .where(
            and(
              eq(chatSessions.id, sessionId),
              eq(chatSessions.userId, userId),
              eq(chatSessions.revision, input.revision),
              sql`${chatSessions.archivedAt} is null`,
            ),
          )
          .returning();
        if (!updated) agentError('SESSION_REVISION_CONFLICT');
        return { id: updated.id, revision: updated.revision, archived_at: now.toISOString() };
      },
    });
  }

  private async turnSummaries(
    transaction: Transaction,
    userId: string,
    sessionId: string,
    turnIds: string[],
  ) {
    if (turnIds.length === 0) return [];
    const turns = await transaction
      .select()
      .from(agentTurns)
      .where(
        and(
          inArray(agentTurns.id, turnIds),
          eq(agentTurns.userId, userId),
          eq(agentTurns.sessionId, sessionId),
        ),
      )
      .orderBy(asc(agentTurns.createdAt), asc(agentTurns.id));
    const [traces, confirmations, sequences] = await Promise.all([
      transaction.select().from(agentTraces).where(inArray(agentTraces.turnId, turnIds)),
      transaction
        .select()
        .from(agentTurnConfirmations)
        .where(
          and(
            inArray(agentTurnConfirmations.turnId, turnIds),
            eq(agentTurnConfirmations.status, 'pending'),
          ),
        )
        .orderBy(asc(agentTurnConfirmations.createdAt), asc(agentTurnConfirmations.id)),
      transaction
        .select({ scopeId: eventOutbox.scopeId, lastEventSeq: max(eventOutbox.eventSeq) })
        .from(eventOutbox)
        .where(and(eq(eventOutbox.scopeType, 'turn'), inArray(eventOutbox.scopeId, turnIds)))
        .groupBy(eventOutbox.scopeId),
    ]);
    const traceByTurn = new Map(traces.map((trace) => [trace.turnId, trace]));
    const confirmationByTurn = new Map<string, (typeof confirmations)[number]>();
    for (const confirmation of confirmations) {
      if (!confirmationByTurn.has(confirmation.turnId)) {
        confirmationByTurn.set(confirmation.turnId, confirmation);
      }
    }
    const sequenceByTurn = new Map(
      sequences.map((sequence) => [sequence.scopeId, Number(sequence.lastEventSeq ?? 0)]),
    );
    return turns.map((turn) => {
      const trace = traceByTurn.get(turn.id);
      const confirmation = confirmationByTurn.get(turn.id);
      return {
        id: turn.id,
        session_id: turn.sessionId,
        user_status: agentUserStatus(turn.status),
        revision: turn.revision,
        continuation_no: turn.continuationNo,
        agent_trace_id: trace?.id ?? null,
        skill_selection: publicSkillSelection(turn.skillSelectionSnapshotJson),
        model_selection: publicModelSelection(turn.modelSelectionSnapshotJson),
        generation_preferences: turn.generationPreferencesJson,
        execution_authorization: publicExecutionAuthorization(turn.executionAuthorizationJson),
        run_quote_id: turn.runQuoteId,
        workflow_run_id: turn.workflowRunId,
        pending_confirmation: publicPendingConfirmation({
          confirmation,
        }),
        last_event_seq: sequenceByTurn.get(turn.id) ?? 0,
        created_at: turn.createdAt.toISOString(),
        ended_at: turn.endedAt?.toISOString() ?? null,
      };
    });
  }

  private async mutate<T extends Record<string, unknown>>(input: {
    userId: string;
    sessionId: string;
    operation: MutationOperation;
    idempotencyKey: string;
    request: unknown;
    write: (transaction: Transaction) => Promise<T>;
  }): Promise<T> {
    const keyHash = createHmac('sha256', this.idempotencySecret)
      .update(input.idempotencyKey)
      .digest('hex');
    const requestHash = canonicalSha256(input.request);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-session-mutation', `${input.userId}:${input.operation}:${keyHash}`)})`,
      );
      const replay = await transaction.query.agentSessionMutations.findFirst({
        where: and(
          eq(agentSessionMutations.userId, input.userId),
          eq(agentSessionMutations.operation, input.operation),
          eq(agentSessionMutations.idempotencyKeyHash, keyHash),
        ),
      });
      if (replay) {
        if (replay.requestHash !== requestHash) agentError('IDEMPOTENCY_CONFLICT');
        return replay.responseJson as T;
      }
      const response = await input.write(transaction);
      await transaction.insert(agentSessionMutations).values({
        userId: input.userId,
        sessionId: input.sessionId,
        operation: input.operation,
        idempotencyKeyHash: keyHash,
        requestHash,
        responseJson: response,
      });
      return response;
    });
  }

  private async lockSession(transaction: Transaction, userId: string, sessionId: string) {
    const [session] = await transaction
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.id, sessionId),
          eq(chatSessions.userId, userId),
          sql`${chatSessions.archivedAt} is null`,
        ),
      )
      .for('update');
    if (!session) agentError('RESOURCE_NOT_FOUND');
    return session;
  }

  private async assertArchivable(
    transaction: Transaction,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const [activeTurn, pendingConfirmation, activeWorkflow] = await Promise.all([
      transaction
        .select({ id: agentTurns.id })
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.userId, userId),
            eq(agentTurns.sessionId, sessionId),
            sql`${agentTurns.status} not in ${TERMINAL_TURN_SQL}`,
          ),
        )
        .limit(1),
      transaction
        .select({ id: agentTurnConfirmations.id })
        .from(agentTurnConfirmations)
        .innerJoin(agentTurns, eq(agentTurns.id, agentTurnConfirmations.turnId))
        .where(
          and(
            eq(agentTurns.userId, userId),
            eq(agentTurns.sessionId, sessionId),
            eq(agentTurnConfirmations.status, 'pending'),
          ),
        )
        .limit(1),
      transaction
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .innerJoin(agentTurns, eq(agentTurns.workflowRunId, workflowRuns.id))
        .where(
          and(
            eq(agentTurns.userId, userId),
            eq(agentTurns.sessionId, sessionId),
            sql`${workflowRuns.status} not in ${TERMINAL_WORKFLOW_SQL}`,
          ),
        )
        .limit(1),
    ]);
    if (activeTurn[0] || pendingConfirmation[0] || activeWorkflow[0]) {
      agentError('SESSION_ACTIVE');
    }
  }

  private decodeCursor(
    cursor: string | undefined,
    userId: string,
    endpoint: string,
    filters: unknown,
  ) {
    if (!cursor) return undefined;
    try {
      return this.cursor.decode({ cursor, userId, endpoint, filters });
    } catch (error) {
      if (error instanceof SignedCursorError) agentError('SESSION_CURSOR_INVALID');
      throw error;
    }
  }
}
