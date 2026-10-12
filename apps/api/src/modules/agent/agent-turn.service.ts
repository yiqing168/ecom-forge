import {
  skillExecutionRules,
  skillGenerationIntent,
  EDIT_SOURCE_ROLES,
  type SkillExecutionPolicy,
} from '@ecom-forge/shared';
import { randomUUID } from 'node:crypto';

import {
  agentTraces,
  agentTraceSteps,
  agentTurnConfirmations,
  agentTurns,
  agentTranscriptItems,
  and,
  asc,
  chatMessages,
  chatSessions,
  creditAccounts,
  desc,
  eq,
  eventOutbox,
  inArray,
  max,
  runQuotes,
  sql,
  type Database,
} from '@ecom-forge/db';
import { compositeJobId, createQueueIntentInTransaction } from '@ecom-forge/queue';
import {
  canonicalSha256,
  compareMoney,
  scopedAdvisoryLockKey,
  createSessionCreativeDirectionSnapshot,
  parseSessionCreativeDirectionSnapshot,
} from '@ecom-forge/shared';
import { Logger } from '@nestjs/common';

import { appendOutboxEventInTransaction } from '../../shared/database/outbox.repository.js';
import type { EventWakeHub } from '../events/event-wake.hub.js';
import { EventContractError, projectPublicEvent } from '../events/event-contract.js';
import type { AppConfig } from '../../config/app-config.js';
import { AgentApiError, agentError } from './agent.errors.js';
import type { AbuseProtectionService } from '../auth/abuse-protection.service.js';
import type { CreateTurnInput, InterruptTurnInput } from './agent.schemas.js';
import { agentUserStatus, TERMINAL_TURN_STATUSES } from './agent-status.js';
import { SkillCatalogService } from './skill-catalog.service.js';
import { AgentBindingService } from './agent-binding.service.js';
import {
  AgentModelSelectionService,
  publicAgentModelSelection,
  type PublicAgentModelSelection,
} from './agent-model-selection.service.js';
import { publicAgentAttachments, publicPendingConfirmation } from './agent-public-projection.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface CreateTurnResponse {
  session_id: string;
  turn_id: string;
  user_message_id: string;
  agent_trace_id: string;
  skill_selection: {
    primary_skill_id: string;
    primary_name: string;
    preset_selections: Array<{ slot: string; preset_id: string; name: string }>;
  };
  model_selection: PublicAgentModelSelection;
  generation_preferences: CreateTurnInput['generation_preferences'];
  execution_authorization: {
    kind: 'generate_action';
  };
  user_status: 'thinking';
  revision: number;
  continuation_no: number;
  event_scope: string;
  last_event_seq: number;
}

export interface InterruptResponse {
  turn_id: string;
  user_status: 'stopped';
  revision: number;
  continuation_no: number;
  event_scope: string;
  last_event_seq: number;
}

function publicSkillSelection(snapshot: {
  primary_skill_id: string;
  primary_name: string;
  preset_selections: Array<{ slot: string; preset_id: string; name: string }>;
}) {
  return {
    primary_skill_id: snapshot.primary_skill_id,
    primary_name: snapshot.primary_name,
    preset_selections: snapshot.preset_selections.map(({ slot, preset_id, name }) => ({
      slot,
      preset_id,
      name,
    })),
  };
}

export class AgentTurnService {
  private readonly logger = new Logger(AgentTurnService.name);

  constructor(
    private readonly database: Database,
    private readonly eventWakeHub?: EventWakeHub,
    private readonly config?: AppConfig,
    private readonly abuseProtection?: AbuseProtectionService,
  ) {}

  async create(
    userId: string,
    input: CreateTurnInput,
    idempotencyKey: string,
    context: { ipBucket: string } = { ipBucket: 'unknown' },
  ): Promise<CreateTurnResponse> {
    const policyVersion = this.config?.agent.executionPolicyVersion ?? 'agent-execution-policy-v1';
    const normalized = {
      ...input,
      skill_selection: {
        ...input.skill_selection,
        preset_selections: [...input.skill_selection.preset_selections].sort((left, right) =>
          left.slot.localeCompare(right.slot),
        ),
      },
    };
    const generationPreferencesHash = canonicalSha256(normalized.generation_preferences);
    const requestHash = canonicalSha256(normalized);
    const executionAuthorization = {
      schema_version: 2 as const,
      kind: 'generate_action' as const,
      create_request_hash: requestHash,
      policy_version: policyVersion,
    };
    const authorizationHash = canonicalSha256(executionAuthorization);
    const replay = await this.createReplay(userId, idempotencyKey, requestHash);
    if (replay) return replay;
    await this.abuseProtection?.assertAgentRequest(userId, context.ipBucket);
    let result;
    try {
      result = await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-create-idempotency', `${userId}:${idempotencyKey}`)})`,
        );
        const lockedReplay = await this.createReplay(
          userId,
          idempotencyKey,
          requestHash,
          transaction,
        );
        if (lockedReplay) return { response: lockedReplay };
        await this.assertCreditBalance(transaction, userId);
        const selection = await new SkillCatalogService(transaction).resolveSelection(
          normalized.skill_selection,
        );
        const selectedSkillSlug = primarySkillSlug(selection.snapshot.primary_skill_id);
        let sessionId = normalized.session_id;
        let hasExistingSessionTurn = false;
        if (sessionId) {
          const [session] = await transaction
            .select({
              id: chatSessions.id,
              archivedAt: chatSessions.archivedAt,
              primarySkillSlug: chatSessions.primarySkillSlug,
              transcriptStateJson: chatSessions.transcriptStateJson,
              creativeDirectionSnapshotJson: chatSessions.creativeDirectionSnapshotJson,
              creativeDirectionSnapshotHash: chatSessions.creativeDirectionSnapshotHash,
            })
            .from(chatSessions)
            .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.userId, userId)))
            .for('update');
          if (!session) agentError('RESOURCE_NOT_FOUND');
          // `06`: an archived session is invisible to turn creation. Report the same 404 as a missing
          // session instead of leaking that it exists with a 409.
          if (session.archivedAt) agentError('RESOURCE_NOT_FOUND');
          const latestTurn = await transaction.query.agentTurns.findFirst({
            where: and(eq(agentTurns.sessionId, session.id), eq(agentTurns.userId, userId)),
            orderBy: [desc(agentTurns.createdAt), desc(agentTurns.id)],
            columns: { generationPreferencesJson: true },
          });
          const requestedDirection = createSessionCreativeDirectionSnapshot(
            normalized.generation_preferences.creative_direction,
          );
          const latestPreferences = latestTurn?.generationPreferencesJson as
            { creative_direction?: unknown } | null | undefined;
          const storedDirection =
            session.creativeDirectionSnapshotJson === null
              ? createSessionCreativeDirectionSnapshot(
                  latestTurn ? latestPreferences?.creative_direction : requestedDirection.selection,
                )
              : parseSessionCreativeDirectionSnapshot(session.creativeDirectionSnapshotJson);
          if (
            !storedDirection ||
            (session.creativeDirectionSnapshotJson !== null &&
              canonicalSha256(storedDirection) !== session.creativeDirectionSnapshotHash)
          ) {
            agentError('TURN_STATE_INVALID');
          }
          if (
            canonicalSha256(storedDirection.selection) !==
            canonicalSha256(requestedDirection.selection)
          ) {
            agentError('SESSION_CREATIVE_DIRECTION_MISMATCH');
          }
          if (session.creativeDirectionSnapshotJson === null) {
            await transaction
              .update(chatSessions)
              .set({
                creativeDirectionSnapshotJson: storedDirection,
                creativeDirectionSnapshotHash: canonicalSha256(storedDirection),
              })
              .where(and(eq(chatSessions.id, session.id), eq(chatSessions.userId, userId)));
          }
          if (session.primarySkillSlug && session.primarySkillSlug !== selectedSkillSlug) {
            agentError('SESSION_SKILL_MISMATCH');
          }
          const firstTurn = await transaction.query.agentTurns.findFirst({
            where: and(eq(agentTurns.sessionId, session.id), eq(agentTurns.userId, userId)),
            orderBy: [asc(agentTurns.createdAt), asc(agentTurns.id)],
            columns: {
              id: true,
              executionFormat: true,
              transcriptCaptureVersion: true,
              skillSelectionSnapshotJson: true,
            },
          });
          const existingMessage = await transaction.query.chatMessages.findFirst({
            where: eq(chatMessages.sessionId, session.id),
            columns: { id: true },
          });
          const existingTranscriptItem = await transaction.query.agentTranscriptItems.findFirst({
            where: and(
              eq(agentTranscriptItems.sessionId, session.id),
              eq(agentTranscriptItems.userId, userId),
            ),
            columns: { id: true },
          });
          const transcriptState = session.transcriptStateJson;
          const transcriptMode =
            transcriptState &&
            typeof transcriptState === 'object' &&
            !Array.isArray(transcriptState)
              ? (transcriptState as { mode?: unknown }).mode
              : undefined;
          if (
            firstTurn?.executionFormat !== undefined &&
            (firstTurn.executionFormat !== 'transcript_v1' ||
              firstTurn.transcriptCaptureVersion !== 1)
          ) {
            agentError('TURN_STATE_INVALID');
          }
          if (firstTurn && transcriptMode !== 'active') agentError('TURN_STATE_INVALID');
          if (!firstTurn && (existingMessage || existingTranscriptItem)) {
            agentError('TURN_STATE_INVALID');
          }
          if (!firstTurn && transcriptMode !== 'active') {
            await transaction
              .update(chatSessions)
              .set({
                transcriptStateJson: {
                  schema_version: 1,
                  mode: 'active',
                  integrity_version: 1,
                  verified_through_sequence: '0',
                  verified_digest: canonicalSha256([]),
                },
              })
              .where(eq(chatSessions.id, session.id));
          }
          hasExistingSessionTurn = Boolean(firstTurn);
          const pinnedPresets = sessionPresetIdentities(firstTurn?.skillSelectionSnapshotJson);
          if (
            pinnedPresets &&
            canonicalSha256(pinnedPresets) !==
              canonicalSha256(sessionPresetIdentities(selection.snapshot) ?? [])
          ) {
            agentError('SESSION_SKILL_MISMATCH');
          }
          if (!session.primarySkillSlug) {
            await transaction
              .update(chatSessions)
              .set({ primarySkillSlug: selectedSkillSlug })
              .where(eq(chatSessions.id, session.id));
          }
        } else {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-user-session-create', userId)})`,
          );
          const lockedReplayAfterUserLock = await this.createReplay(
            userId,
            idempotencyKey,
            requestHash,
            transaction,
          );
          if (lockedReplayAfterUserLock) return { response: lockedReplayAfterUserLock };
          const [session] = await transaction
            .insert(chatSessions)
            .values({
              userId,
              title: normalized.message.slice(0, 120),
              primarySkillSlug: selectedSkillSlug,
              creativeDirectionSnapshotJson: createSessionCreativeDirectionSnapshot(
                normalized.generation_preferences.creative_direction,
              ),
              creativeDirectionSnapshotHash: canonicalSha256(
                createSessionCreativeDirectionSnapshot(
                  normalized.generation_preferences.creative_direction,
                ),
              ),
              transcriptStateJson: {
                schema_version: 1,
                mode: 'active',
                integrity_version: 1,
                verified_through_sequence: '0',
                verified_digest: canonicalSha256([]),
              },
            })
            .returning({ id: chatSessions.id });
          if (!session) throw new Error('Chat session insert returned no row');
          sessionId = session.id;
        }
        const turnId = randomUUID();
        const attachmentSnapshots = await new AgentBindingService().resolve(transaction, {
          userId,
          sessionId,
          attachments: mentionScopedAttachments(normalized),
        });
        const requiredOperation = creativeTurnOperation(
          selection.snapshot.execution_policy,
          attachmentSnapshots,
          hasExistingSessionTurn,
        );
        const modelSelection = await new AgentModelSelectionService(
          transaction,
          this.config?.appEnv ?? 'test',
        ).resolve({
          userId,
          selection: normalized.model_selection,
          preferences: normalized.generation_preferences,
          requiredCapabilities: selection.requiredCapabilities,
          ...(requiredOperation ? { requiredOperation } : {}),
        });
        const supersededTurnIds = await this.supersedeActiveTurns(transaction, sessionId, turnId);
        const [createdTurn] = await transaction
          .insert(agentTurns)
          .values({
            id: turnId,
            sessionId,
            userId,
            status: 'received_user_input',
            executionFormat: 'transcript_v1',
            transcriptCaptureVersion: 1,
            primarySkillId: selection.snapshot.primary_skill_id,
            skillSelectionSnapshotJson: selection.snapshot,
            skillSelectionSnapshotHash: selection.hash,
            modelSelectionSnapshotJson: modelSelection.snapshot,
            modelSelectionSnapshotHash: modelSelection.hash,
            generationPreferencesJson: normalized.generation_preferences,
            generationPreferencesHash,
            executionAuthorizationJson: executionAuthorization,
            executionAuthorizationHash: authorizationHash,
            createIdempotencyKey: idempotencyKey,
            createRequestHash: requestHash,
            createResponseJson: {},
          })
          .returning();
        if (!createdTurn) throw new Error('Agent turn insert returned no row');
        if (supersededTurnIds.length > 0) {
          await transaction
            .update(agentTurns)
            .set({ supersededByTurnId: createdTurn.id })
            .where(inArray(agentTurns.id, supersededTurnIds));
        }
        const [message] = await transaction
          .insert(chatMessages)
          .values({
            sessionId,
            turnId: createdTurn.id,
            role: 'user',
            content: normalized.message,
            attachments: attachmentSnapshots,
            skillSnapshots: [
              { skill_id: selection.snapshot.primary_skill_id, snapshot_hash: selection.hash },
            ],
          })
          .returning({ id: chatMessages.id });
        if (!message) throw new Error('Chat message insert returned no row');
        await transaction
          .update(chatSessions)
          .set({
            updatedAt: new Date(),
            // `05` message_history_revision advances with every message write so Worker read
            // windows can fence on the session history revision.
            messageHistoryRevision: sql`${chatSessions.messageHistoryRevision} + 1`,
          })
          .where(eq(chatSessions.id, sessionId));
        const [trace] = await transaction
          .insert(agentTraces)
          .values({
            turnId: createdTurn.id,
            sessionId,
            userId,
            brainModelId: `${modelSelection.brainModelSnapshot.provider}:${modelSelection.brainModelSnapshot.model_id}@${modelSelection.brainModelSnapshot.version}`,
            brainModelSnapshotId: modelSelection.brainModelSnapshotId,
            brainModelSnapshotJson: modelSelection.brainModelSnapshot,
            skillIds: [selection.snapshot.primary_skill_id],
          })
          .returning({ id: agentTraces.id });
        if (!trace) throw new Error('Agent trace insert returned no row');
        await createQueueIntentInTransaction(transaction, {
          queueName: 'agent',
          jobId: compositeJobId({
            job_type: 'agent.continue',
            turn_id: createdTurn.id,
            continuation_no: createdTurn.continuationNo,
          }),
          aggregateType: 'agent_turn',
          aggregateId: createdTurn.id,
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            job_type: 'agent.continue',
            trace_id: trace.id,
            session_id: sessionId,
            turn_id: createdTurn.id,
            user_message_id: message.id,
            continuation_no: createdTurn.continuationNo,
            turn_revision: createdTurn.revision,
          },
        });
        const event = await appendOutboxEventInTransaction(transaction, {
          scopeType: 'turn',
          scopeId: createdTurn.id,
          eventType: 'turn.created',
          payload: {
            turn_id: createdTurn.id,
            agent_trace_id: trace.id,
            user_status: 'thinking',
          },
        });
        const response: CreateTurnResponse = {
          session_id: sessionId,
          turn_id: createdTurn.id,
          user_message_id: message.id,
          agent_trace_id: trace.id,
          skill_selection: publicSkillSelection(selection.snapshot),
          model_selection: publicAgentModelSelection(modelSelection.snapshot),
          generation_preferences: normalized.generation_preferences,
          execution_authorization: {
            kind: 'generate_action',
          },
          user_status: 'thinking',
          revision: createdTurn.revision,
          continuation_no: createdTurn.continuationNo,
          event_scope: `turn:${createdTurn.id}`,
          last_event_seq: event.eventSeq,
        };
        const [stored] = await transaction
          .update(agentTurns)
          .set({ createResponseJson: response })
          .where(eq(agentTurns.id, createdTurn.id))
          .returning({ id: agentTurns.id });
        if (!stored) throw new Error('Agent create response was not stored');
        return { response, eventSeq: event.eventSeq, turnId: createdTurn.id };
      });
    } catch (error) {
      if (error instanceof AgentApiError && error.code === 'CREDIT_BALANCE_EMPTY') {
        await this.abuseProtection?.recordZeroCreditAttempt(userId, context.ipBucket);
      }
      throw error;
    }
    if (result.eventSeq && result.turnId) {
      await this.publishWake(result.turnId, result.eventSeq);
    }
    return result.response;
  }

  private async assertCreditBalance(transaction: Transaction, userId: string): Promise<void> {
    const [account] = await transaction
      .select({ balance: creditAccounts.balance })
      .from(creditAccounts)
      .where(eq(creditAccounts.userId, userId))
      .for('update');
    if (!account || compareMoney(account.balance, '0.00') <= 0) {
      agentError('CREDIT_BALANCE_EMPTY');
    }
  }

  async interrupt(
    userId: string,
    turnId: string,
    input: InterruptTurnInput,
    idempotencyKey: string,
  ): Promise<InterruptResponse> {
    const requestHash = canonicalSha256({ turn_id: turnId, ...input });
    const replay = await this.interruptReplay(userId, idempotencyKey, requestHash);
    if (replay) return replay;
    const result = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-interrupt-idempotency', `${userId}:${idempotencyKey}`)})`,
      );
      const lockedReplay = await this.interruptReplay(
        userId,
        idempotencyKey,
        requestHash,
        transaction,
      );
      if (lockedReplay) return { response: lockedReplay };
      const probe = await transaction.query.agentTurns.findFirst({
        where: and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId)),
        columns: { sessionId: true },
      });
      if (!probe) agentError('RESOURCE_NOT_FOUND');
      const [session] = await transaction
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, probe.sessionId),
            eq(chatSessions.userId, userId),
            sql`${chatSessions.archivedAt} is null`,
          ),
        )
        .for('no key update');
      if (!session) agentError('RESOURCE_NOT_FOUND');
      const [turn] = await transaction
        .select()
        .from(agentTurns)
        .where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId)))
        .for('update');
      if (!turn) agentError('RESOURCE_NOT_FOUND');
      if (turn.workflowRunId) agentError('TURN_ALREADY_SUBMITTED');
      if (TERMINAL_TURN_STATUSES.includes(turn.status)) agentError('TURN_STATE_INVALID');
      const trace = await transaction.query.agentTraces.findFirst({
        where: eq(agentTraces.turnId, turn.id),
      });
      if (!trace) throw new Error('Agent trace is missing');
      const now = new Date();
      const nextRevision = turn.revision + 1;
      await transaction
        .update(agentTurnConfirmations)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(agentTurnConfirmations.turnId, turn.id),
            eq(agentTurnConfirmations.status, 'pending'),
          ),
        );
      if (turn.runQuoteId) {
        await transaction
          .update(runQuotes)
          .set({ status: 'cancelled' })
          .where(and(eq(runQuotes.id, turn.runQuoteId), eq(runQuotes.status, 'quoted')));
      }
      await this.appendTraceStep(transaction, trace.id, {
        stepType: 'interrupt',
        actor: 'user',
        inputSummary: { reason: 'user_requested' },
        outputSummary: { outcome: 'cancelled' },
        status: 'succeeded',
      });
      await this.settleStartedLlmStepsAsUnknown(transaction, trace.id);
      await transaction
        .update(agentTraces)
        .set({ status: 'cancelled', endedAt: now })
        .where(eq(agentTraces.id, trace.id));
      const statusEvent = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          previous_user_status: agentUserStatus(turn.status),
          user_status: 'stopped',
        },
      });
      const interruptedEvent = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.interrupted',
        payload: { turn_id: turn.id, agent_trace_id: trace.id, reason: 'user_requested' },
      });
      const cancelledEvent = await appendOutboxEventInTransaction(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.cancelled',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          reason: 'user_requested',
          user_status: 'stopped',
        },
      });
      const response: InterruptResponse = {
        turn_id: turn.id,
        user_status: 'stopped',
        revision: nextRevision,
        continuation_no: turn.continuationNo,
        event_scope: `turn:${turn.id}`,
        last_event_seq: cancelledEvent.eventSeq,
      };
      const [updated] = await transaction
        .update(agentTurns)
        .set({
          status: 'cancelled',
          revision: nextRevision,
          processingOwner: null,
          processingLeaseExpiresAt: null,
          interruptIdempotencyKey: idempotencyKey,
          interruptRequestHash: requestHash,
          interruptResponseJson: response,
          interruptedAt: now,
          endedAt: now,
        })
        .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
        .returning({ id: agentTurns.id });
      if (!updated) agentError('TURN_STATE_INVALID');
      return {
        response,
        eventSeq: Math.max(
          statusEvent.eventSeq,
          interruptedEvent.eventSeq,
          cancelledEvent.eventSeq,
        ),
        turnId: turn.id,
      };
    });
    if (result.eventSeq && result.turnId) await this.publishWake(result.turnId, result.eventSeq);
    return result.response;
  }

  async get(userId: string, turnId: string) {
    return this.database.transaction(
      async (transaction) => {
        const turn = await transaction.query.agentTurns.findFirst({
          where: and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId)),
        });
        if (!turn) agentError('RESOURCE_NOT_FOUND');
        const trace = await transaction.query.agentTraces.findFirst({
          where: eq(agentTraces.turnId, turn.id),
        });
        if (!trace) throw new Error('Agent trace is missing');
        const [pendingConfirmation, messages, sequence, activityEvents, failureEvents] =
          await Promise.all([
            transaction.query.agentTurnConfirmations.findFirst({
              where: and(
                eq(agentTurnConfirmations.turnId, turn.id),
                eq(agentTurnConfirmations.status, 'pending'),
              ),
              orderBy: [asc(agentTurnConfirmations.createdAt), asc(agentTurnConfirmations.id)],
            }),
            transaction
              .select({
                id: chatMessages.id,
                role: chatMessages.role,
                content: chatMessages.content,
                attachments: chatMessages.attachments,
                createdAt: chatMessages.createdAt,
              })
              .from(chatMessages)
              .where(
                and(
                  eq(chatMessages.turnId, turn.id),
                  inArray(chatMessages.role, ['user', 'assistant']),
                ),
              )
              .orderBy(
                asc(chatMessages.createdAt),
                sql`case when ${chatMessages.role} = 'user' then 0 else 1 end`,
                asc(chatMessages.id),
              ),
            transaction
              .select({ lastEventSeq: max(eventOutbox.eventSeq) })
              .from(eventOutbox)
              .where(and(eq(eventOutbox.scopeType, 'turn'), eq(eventOutbox.scopeId, turn.id))),
            transaction
              .select({
                eventSeq: eventOutbox.eventSeq,
                eventType: eventOutbox.eventType,
                payload: eventOutbox.payload,
                createdAt: eventOutbox.createdAt,
              })
              .from(eventOutbox)
              .where(
                and(
                  eq(eventOutbox.scopeType, 'turn'),
                  eq(eventOutbox.scopeId, turn.id),
                  inArray(eventOutbox.eventType, [
                    'turn.activity_started',
                    'turn.activity_finished',
                  ]),
                ),
              )
              .orderBy(asc(eventOutbox.eventSeq)),
            transaction
              .select({
                eventSeq: eventOutbox.eventSeq,
                eventType: eventOutbox.eventType,
                payload: eventOutbox.payload,
                createdAt: eventOutbox.createdAt,
              })
              .from(eventOutbox)
              .where(
                and(
                  eq(eventOutbox.scopeType, 'turn'),
                  eq(eventOutbox.scopeId, turn.id),
                  inArray(eventOutbox.eventType, ['turn.failed', 'turn.guardrail_triggered']),
                ),
              )
              .orderBy(desc(eventOutbox.eventSeq))
              .limit(1),
          ]);
        const snapshot = turn.skillSelectionSnapshotJson as {
          primary_skill_id: string;
          primary_name: string;
          preset_selections: Array<{ slot: string; preset_id: string; name: string }>;
          required_auxiliary: Array<{ skill_id: string; name: string }>;
          optional_auxiliary: Array<{ skill_id: string; name: string }>;
        };
        const loadedSkillIds = new Set(
          Array.isArray(trace.skillIds)
            ? trace.skillIds.filter((item): item is string => typeof item === 'string')
            : [],
        );
        const activeModelStep =
          agentUserStatus(turn.status) === 'thinking'
            ? await transaction.query.agentTraceSteps.findFirst({
                where: and(
                  eq(agentTraceSteps.traceId, trace.id),
                  eq(agentTraceSteps.status, 'started'),
                  eq(agentTraceSteps.stepType, 'llm_call'),
                ),
                orderBy: [desc(agentTraceSteps.stepNo)],
                columns: { id: true },
              })
            : null;
        const draftEvents = activeModelStep
          ? await transaction
              .select({
                eventSeq: eventOutbox.eventSeq,
                eventType: eventOutbox.eventType,
                payload: eventOutbox.payload,
                createdAt: eventOutbox.createdAt,
              })
              .from(eventOutbox)
              .where(
                and(
                  eq(eventOutbox.scopeType, 'turn'),
                  eq(eventOutbox.scopeId, turn.id),
                  inArray(eventOutbox.eventType, [
                    'turn.response_draft_delta',
                    'turn.response_draft_cleared',
                  ]),
                ),
              )
              .orderBy(asc(eventOutbox.eventSeq))
          : [];
        return {
          id: turn.id,
          session_id: turn.sessionId,
          user_status: agentUserStatus(turn.status),
          revision: turn.revision,
          continuation_no: turn.continuationNo,
          agent_trace_id: trace.id,
          skill_selection: publicSkillSelection(snapshot),
          model_selection: turn.modelSelectionSnapshotJson
            ? publicAgentModelSelection(turn.modelSelectionSnapshotJson)
            : null,
          generation_preferences: turn.generationPreferencesJson,
          execution_authorization: publicExecutionAuthorization(turn.executionAuthorizationJson),
          loaded_auxiliary_skills: [
            ...snapshot.required_auxiliary.map((item) => ({
              ...item,
              load_mode: 'required' as const,
            })),
            ...snapshot.optional_auxiliary
              .filter((item) => loadedSkillIds.has(item.skill_id))
              .map((item) => ({ ...item, load_mode: 'optional' as const })),
          ].map(({ skill_id, name, load_mode }) => ({ skill_id, name, load_mode })),
          run_quote_id: turn.runQuoteId,
          workflow_run_id: turn.workflowRunId,
          pending_confirmation: publicPendingConfirmation({
            confirmation: pendingConfirmation,
          }),
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            attachments: publicAgentAttachments(message.attachments),
            created_at: message.createdAt.toISOString(),
          })),
          activities: publicTurnActivities(turn.id, activityEvents),
          response_draft: activeModelStep
            ? this.responseDraft(turn.id, activeModelStep.id, draftEvents)
            : null,
          last_event_seq: Number(sequence[0]?.lastEventSeq ?? 0),
          failure_summary: failureEvents[0]
            ? publicTurnFailureSummary(turn.id, failureEvents[0])
            : null,
          created_at: turn.createdAt.toISOString(),
          ended_at: turn.endedAt?.toISOString() ?? null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private responseDraft(
    turnId: string,
    stepId: string,
    rows: Parameters<typeof publicTurnResponseDraft>[2],
  ): ReturnType<typeof publicTurnResponseDraft> {
    try {
      return publicTurnResponseDraft(turnId, stepId, rows);
    } catch (error) {
      if (!(error instanceof EventContractError || error instanceof ResponseDraftProjectionError)) {
        throw error;
      }
      this.logger.warn({
        event: 'agent_response_draft_discarded',
        metric: 'agent_response_draft_discard_total',
        reason: error instanceof ResponseDraftProjectionError ? error.reason : 'event_invalid',
      });
      return null;
    }
  }

  private async supersedeActiveTurns(
    transaction: Transaction,
    sessionId: string,
    newTurnId: string,
  ): Promise<string[]> {
    const active = await transaction
      .select()
      .from(agentTurns)
      .where(
        and(
          eq(agentTurns.sessionId, sessionId),
          sql`${agentTurns.id} <> ${newTurnId}`,
          sql`${agentTurns.workflowRunId} is null`,
          sql`${agentTurns.status} not in ('done','blocked','failed','cancelled','superseded')`,
        ),
      )
      .for('update');
    for (const turn of active) {
      const trace = await transaction.query.agentTraces.findFirst({
        where: eq(agentTraces.turnId, turn.id),
      });
      const now = new Date();
      await transaction
        .update(agentTurnConfirmations)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(agentTurnConfirmations.turnId, turn.id),
            eq(agentTurnConfirmations.status, 'pending'),
          ),
        );
      if (turn.runQuoteId) {
        await transaction
          .update(runQuotes)
          .set({ status: 'superseded' })
          .where(and(eq(runQuotes.id, turn.runQuoteId), eq(runQuotes.status, 'quoted')));
      }
      await transaction
        .update(agentTurns)
        .set({
          status: 'superseded',
          revision: turn.revision + 1,
          processingOwner: null,
          processingLeaseExpiresAt: null,
          endedAt: now,
        })
        .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)));
      if (trace) {
        await this.settleStartedLlmStepsAsUnknown(transaction, trace.id);
        await transaction
          .update(agentTraces)
          .set({ status: 'superseded', endedAt: now })
          .where(eq(agentTraces.id, trace.id));
        await appendOutboxEventInTransaction(transaction, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.superseded',
          payload: {
            turn_id: turn.id,
            agent_trace_id: trace.id,
            new_turn_id: newTurnId,
            reason: 'new_user_message',
            user_status: 'stopped',
          },
        });
      }
    }
    return active.map((turn) => turn.id);
  }

  private async createReplay(
    userId: string,
    key: string,
    hash: string,
    database: Pick<Database, 'query'> = this.database,
  ): Promise<CreateTurnResponse | null> {
    const existing = await database.query.agentTurns.findFirst({
      where: and(eq(agentTurns.userId, userId), eq(agentTurns.createIdempotencyKey, key)),
    });
    if (!existing) return null;
    if (existing.createRequestHash !== hash) agentError('IDEMPOTENCY_CONFLICT');
    return existing.createResponseJson as CreateTurnResponse;
  }

  private async interruptReplay(
    userId: string,
    key: string,
    hash: string,
    database: Pick<Database, 'query'> = this.database,
  ): Promise<InterruptResponse | null> {
    const existing = await database.query.agentTurns.findFirst({
      where: and(eq(agentTurns.userId, userId), eq(agentTurns.interruptIdempotencyKey, key)),
    });
    if (!existing) return null;
    if (existing.interruptRequestHash !== hash) agentError('IDEMPOTENCY_CONFLICT');
    return existing.interruptResponseJson as InterruptResponse;
  }

  private async appendTraceStep(
    transaction: Transaction,
    traceId: string,
    input: {
      stepType: 'interrupt';
      actor: 'user';
      inputSummary: Record<string, unknown>;
      outputSummary: Record<string, unknown>;
      status: 'succeeded';
    },
  ): Promise<void> {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-trace', traceId)})`,
    );
    const [current] = await transaction
      .select({ stepNo: max(agentTraceSteps.stepNo) })
      .from(agentTraceSteps)
      .where(eq(agentTraceSteps.traceId, traceId));
    await transaction.insert(agentTraceSteps).values({
      traceId,
      stepNo: Number(current?.stepNo ?? 0) + 1,
      stepType: input.stepType,
      actor: input.actor,
      inputSummary: input.inputSummary,
      outputSummary: input.outputSummary,
      status: input.status,
    });
  }

  private async publishWake(turnId: string, eventSeq: number): Promise<void> {
    await this.eventWakeHub
      ?.publish({ schema_version: 1, scope_type: 'turn', scope_id: turnId, event_seq: eventSeq })
      .catch(() => undefined);
  }

  private async settleStartedLlmStepsAsUnknown(
    transaction: Transaction,
    traceId: string,
  ): Promise<void> {
    await transaction
      .update(agentTraceSteps)
      .set({
        status: 'failed',
        errorCode: 'AGENT_CALL_OUTCOME_UNKNOWN',
        outputSummary: { outcome: 'unknown' },
      })
      .where(
        and(
          eq(agentTraceSteps.traceId, traceId),
          eq(agentTraceSteps.stepType, 'llm_call'),
          eq(agentTraceSteps.status, 'started'),
        ),
      );
  }
}

export function primarySkillSlug(primarySkillId: string): string {
  const separator = primarySkillId.lastIndexOf('@');
  if (separator <= 0) agentError('SKILL_SELECTION_INVALID');
  return primarySkillId.slice(0, separator);
}

function sessionPresetIdentities(snapshot: unknown): string[] | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const selections = (snapshot as { preset_selections?: unknown }).preset_selections;
  if (!Array.isArray(selections)) return null;
  const identities = selections.map((selection) => {
    if (!selection || typeof selection !== 'object') agentError('SKILL_VERSION_DRIFT');
    const { slot, preset_id: presetId } = selection as {
      slot?: unknown;
      preset_id?: unknown;
    };
    if (typeof slot !== 'string' || typeof presetId !== 'string') {
      agentError('SKILL_VERSION_DRIFT');
    }
    const separator = presetId.lastIndexOf('@');
    if (separator <= 0) agentError('SKILL_VERSION_DRIFT');
    return `${slot}:${presetId.slice(0, separator)}`;
  });
  return identities.sort();
}

type PublicTurnActivity = {
  activity_id: string;
  activity_type: 'knowledge_loading' | 'context_reading' | 'plan_preparing' | 'safety_checking';
  display_summary: string;
  status: 'started' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  public_error_code?: string;
};

function publicTurnActivities(
  turnId: string,
  rows: Array<{
    eventSeq: number;
    eventType: string;
    payload: unknown;
    createdAt: Date | null;
  }>,
): PublicTurnActivity[] {
  const activities = new Map<string, PublicTurnActivity>();
  for (const row of rows) {
    const event = projectPublicEvent(`turn:${turnId}`, row);
    if (
      event.event_type !== 'turn.activity_started' &&
      event.event_type !== 'turn.activity_finished'
    ) {
      throw new Error('AGENT_ACTIVITY_EVENT_INVALID');
    }
    const payload = event.payload as {
      activity_id: string;
      activity_type: PublicTurnActivity['activity_type'];
      display_summary: string;
      status: PublicTurnActivity['status'];
      public_error_code?: string;
    };
    const existing = activities.get(payload.activity_id);
    if (event.event_type === 'turn.activity_started') {
      if (existing) throw new Error('AGENT_ACTIVITY_EVENT_ORDER_INVALID');
      activities.set(payload.activity_id, {
        activity_id: payload.activity_id,
        activity_type: payload.activity_type,
        display_summary: payload.display_summary,
        status: 'started',
      });
      continue;
    }
    if (
      !existing ||
      existing.status !== 'started' ||
      existing.activity_type !== payload.activity_type ||
      existing.display_summary !== payload.display_summary
    ) {
      throw new Error('AGENT_ACTIVITY_EVENT_MISMATCH');
    }
    activities.set(payload.activity_id, {
      ...existing,
      status: payload.status,
      ...(payload.public_error_code ? { public_error_code: payload.public_error_code } : {}),
    });
  }
  return [...activities.values()];
}

class ResponseDraftProjectionError extends Error {
  constructor(readonly reason: 'event_invalid' | 'sequence_invalid' | 'too_long') {
    super('AGENT_RESPONSE_DRAFT_INVALID');
  }
}

function publicTurnResponseDraft(
  turnId: string,
  stepId: string,
  rows: Array<{ eventSeq: number; eventType: string; payload: unknown; createdAt: Date | null }>,
): { step_id: string; draft_seq: number; text: string } | null {
  let draftSeq = 0;
  let draftText = '';
  for (const row of rows) {
    const event = projectPublicEvent(`turn:${turnId}`, row);
    if (event.event_type === 'turn.response_draft_cleared') {
      if (event.payload.step_id === stepId) {
        draftSeq = 0;
        draftText = '';
      }
      continue;
    }
    if (event.event_type !== 'turn.response_draft_delta') {
      throw new ResponseDraftProjectionError('event_invalid');
    }
    if (event.payload.step_id !== stepId) continue;
    const sequence = Number(event.payload.draft_seq);
    if (sequence !== draftSeq + 1) {
      throw new ResponseDraftProjectionError('sequence_invalid');
    }
    draftText += String(event.payload.text_delta);
    if (Array.from(draftText).length > 8000) throw new ResponseDraftProjectionError('too_long');
    draftSeq = sequence;
  }
  return draftSeq > 0 ? { step_id: stepId, draft_seq: draftSeq, text: draftText } : null;
}

function publicExecutionAuthorization(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = snapshot as Record<string, unknown>;
  return value.schema_version === 2 && value.kind === 'generate_action'
    ? { kind: 'generate_action' as const }
    : null;
}

function publicTurnFailureSummary(
  turnId: string,
  row: { eventSeq: number; eventType: string; payload: unknown; createdAt: Date | null },
): string {
  const event = projectPublicEvent(`turn:${turnId}`, row);
  if (event.event_type !== 'turn.failed' && event.event_type !== 'turn.guardrail_triggered') {
    throw new Error('AGENT_FAILURE_EVENT_INVALID');
  }
  const summary = (event.payload as { summary: string }).summary;
  return summary === '积分余额不足；请充值后重新发起'
    ? '本次生成所需积分超过当前可用余额，未开始生成；请减少生成数量或联系管理员补充积分后重试'
    : summary;
}

/**
 * 当消息携带 @ 引用（mention_bindings 非空）时，只有被引用的附件进入 turn 绑定；
 * 上传但未 @ 的附件不参与生成。没有 @ 引用时维持全量附件语义。
 */
export function mentionScopedAttachments(
  input: Pick<CreateTurnInput, 'attachments' | 'mention_bindings'>,
): CreateTurnInput['attachments'] {
  if (input.mention_bindings.length === 0) return input.attachments;
  const mentioned = new Set(input.mention_bindings.map((mention) => mention.binding_id));
  return input.attachments.filter((attachment) => mentioned.has(attachment.binding_id));
}

export function creativeTurnOperation(
  policy: SkillExecutionPolicy | undefined,
  attachments: Awaited<ReturnType<AgentBindingService['resolve']>>,
  isSessionContinuation = false,
): 'image.generate' | 'image.edit' | undefined {
  if (!policy) return undefined;
  const rules = skillExecutionRules(policy);
  const editSources = attachments.filter((attachment) => attachment.role === 'edit_source');
  if (attachments.length === 0 && isSessionContinuation) return 'image.edit';
  if (editSources.length > 0) {
    if (
      editSources.length !== 1 ||
      attachments.length > policy.max_sources ||
      attachments.some((attachment) => !EDIT_SOURCE_ROLES.includes(attachment.role))
    )
      agentError('REFERENCE_NOT_AVAILABLE');
    return 'image.edit';
  }
  if (
    attachments.length < rules.min_sources ||
    attachments.length > rules.max_sources ||
    attachments.some((attachment) => !rules.roles.includes(attachment.role)) ||
    (policy.family === 'identity_edit' &&
      attachments.filter((item) => item.role === 'identity_anchor').length !== 1)
  ) {
    agentError('REFERENCE_NOT_AVAILABLE');
  }
  if (policy.family === 'product') return undefined;
  return skillGenerationIntent(policy, attachments.length) === 'creative_generate'
    ? 'image.generate'
    : 'image.edit';
}
