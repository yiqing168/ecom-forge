import {
  agentTraces,
  agentTurnConfirmations,
  agentTurns,
  and,
  chatMessages,
  chatSessions,
  creditAccounts,
  eq,
  sql,
  type Database,
} from '@ecom-forge/db';
import { compositeJobId, createQueueIntentInTransaction } from '@ecom-forge/queue';
import { canonicalSha256, compareMoney, scopedAdvisoryLockKey } from '@ecom-forge/shared';

import { appendOutboxEventInTransaction } from '../../shared/database/outbox.repository.js';
import type { EventWakeHub } from '../events/event-wake.hub.js';
import { ProductFactsConfirmationError, type ProductService } from '../resource/product.service.js';
import { AgentApiError, agentError } from './agent.errors.js';
import type { AbuseProtectionService } from '../auth/abuse-protection.service.js';
import {
  clarificationAnswerSchema,
  clarificationPayloadSchema,
  createProductFactsAnswerSchema,
  linkProductFactsAnswerSchema,
  productFactsConfirmationPayloadSchema,
  type ConfirmTurnInput,
} from './agent.schemas.js';

export interface ConfirmResponse {
  turn_id: string;
  user_status: 'thinking';
  revision: number;
  continuation_no: number;
  event_scope: string;
  last_event_seq: number;
}

export class AgentConfirmationService {
  constructor(
    private readonly database: Database,
    private readonly eventWakeHub?: EventWakeHub,
    private readonly products?: ProductService,
    private readonly abuseProtection?: AbuseProtectionService,
  ) {}

  async confirm(
    userId: string,
    turnId: string,
    input: ConfirmTurnInput,
    idempotencyKey: string,
    context: { ipBucket: string } = { ipBucket: 'unknown' },
  ): Promise<ConfirmResponse> {
    const requestHash = canonicalSha256({ turn_id: turnId, ...input });
    const replay = await this.replay(userId, idempotencyKey, requestHash);
    if (replay) return replay;
    await this.abuseProtection?.assertAgentRequest(userId, context.ipBucket);
    let result;
    try {
      result = await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-confirm-idempotency', `${userId}:${idempotencyKey}`)})`,
        );
        const lockedReplay = await this.replay(userId, idempotencyKey, requestHash, transaction);
        if (lockedReplay) return { response: lockedReplay };
        // Locate the session and confirmation type without locks, then take locks in the `05`
        // unified order (`credit_accounts -> chat_sessions -> agent_turns -> domain rows`) and
        // re-validate after locking. A turn-first order could ring against API turn creation and
        // the transcript write transactions.
        const [probe] = await transaction
          .select({ sessionId: agentTurns.sessionId })
          .from(agentTurns)
          .where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId)))
          .limit(1);
        if (!probe) agentError('RESOURCE_NOT_FOUND');
        const [typeProbe] = await transaction
          .select({ type: agentTurnConfirmations.type })
          .from(agentTurnConfirmations)
          .where(
            and(
              eq(agentTurnConfirmations.id, input.confirmation_id),
              eq(agentTurnConfirmations.turnId, turnId),
              eq(agentTurnConfirmations.userId, userId),
            ),
          )
          .limit(1);
        if (!typeProbe) agentError('RESOURCE_NOT_FOUND');
        if (typeProbe.type !== input.confirmation_type) agentError('TURN_STATE_INVALID');
        if (typeProbe.type === 'clarification') {
          await assertCreditBalance(transaction, userId);
        }
        const [sessionFence] = await transaction
          .select({ id: chatSessions.id })
          .from(chatSessions)
          .where(and(eq(chatSessions.id, probe.sessionId), eq(chatSessions.userId, userId)))
          .for('no key update');
        if (!sessionFence) agentError('RESOURCE_NOT_FOUND');
        const [turn] = await transaction
          .select()
          .from(agentTurns)
          .where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId)))
          .for('update');
        if (!turn) agentError('RESOURCE_NOT_FOUND');
        if (turn.status !== 'waiting_user_confirmation') agentError('TURN_STATE_INVALID');
        const [confirmation] = await transaction
          .select()
          .from(agentTurnConfirmations)
          .where(
            and(
              eq(agentTurnConfirmations.id, input.confirmation_id),
              eq(agentTurnConfirmations.turnId, turn.id),
              eq(agentTurnConfirmations.userId, userId),
            ),
          )
          .for('update');
        if (!confirmation) agentError('RESOURCE_NOT_FOUND');
        if (confirmation.status !== 'pending') agentError('TURN_STATE_INVALID');
        if (confirmation.expiresAt.getTime() <= Date.now())
          agentError('AGENT_CONFIRMATION_EXPIRED');
        if (
          confirmation.type !== input.confirmation_type ||
          confirmation.answerSchemaVersion !== input.confirmation_version ||
          confirmation.payloadDigest !== canonicalSha256(confirmation.publicPayloadJson)
        ) {
          agentError('TURN_STATE_INVALID');
        }
        if (confirmation.answerSchemaVersion !== 1) {
          agentError('AGENT_CONFIRMATION_NOT_AVAILABLE');
        }
        let normalizedAnswer: Record<string, unknown>;
        let userMessageContent: string;
        if (confirmation.type === 'clarification') {
          const payload = clarificationPayloadSchema.parse(confirmation.publicPayloadJson);
          const answer = clarificationAnswerSchema.parse(input.answers);
          if (answer.response_text && !payload.allow_free_text) agentError('TURN_STATE_INVALID');
          if (answer.response_text && answer.response_text.length > payload.max_response_chars) {
            agentError('TURN_STATE_INVALID');
          }
          const option = answer.selected_option_id
            ? payload.options.find((item) => item.id === answer.selected_option_id)
            : undefined;
          if (answer.selected_option_id && !option) agentError('TURN_STATE_INVALID');
          normalizedAnswer = {
            ...(answer.response_text ? { response_text: answer.response_text } : {}),
            ...(option
              ? { selected_option_id: option.id, selected_option_label: option.label }
              : {}),
          };
          userMessageContent = [option?.label, answer.response_text].filter(Boolean).join('\n');
        } else if (confirmation.type === 'product_facts') {
          if (!this.products) agentError('AGENT_CONFIRMATION_NOT_AVAILABLE');
          const payload = productFactsConfirmationPayloadSchema.parse(
            confirmation.publicPayloadJson,
          );
          try {
            let result: Awaited<ReturnType<ProductService['confirmFactsInTransaction']>>;
            if (payload.mode === 'create_product') {
              const answer = createProductFactsAnswerSchema.parse(input.answers);
              result = await this.products.confirmFactsInTransaction(transaction, userId, {
                mode: 'create_product',
                sourceAssetId: payload.source_asset_id,
                sourceVersion: payload.source_version,
                ...(answer.sku_code ? { skuCode: answer.sku_code } : {}),
                facts: answer.facts,
              });
              normalizedAnswer = {
                ...answer,
                product_id: result.productId,
                fact_set_id: result.factSetId,
                fact_set_version: result.versionNo,
              };
              userMessageContent = `已确认商品档案：${answer.facts.product_name}`;
            } else {
              const answer = linkProductFactsAnswerSchema.parse(input.answers);
              result = await this.products.confirmFactsInTransaction(transaction, userId, {
                mode: 'link_product',
                sourceAssetId: payload.source_asset_id,
                sourceVersion: payload.source_version,
                productId: payload.product_id,
                expectedLatestFactSetId: payload.expected_latest_fact_set_id,
                facts: answer.facts,
              });
              normalizedAnswer = {
                ...answer,
                product_id: result.productId,
                fact_set_id: result.factSetId,
                fact_set_version: result.versionNo,
              };
              userMessageContent = `已确认商品档案：${answer.facts.product_name}`;
            }
          } catch (error) {
            mapProductFactsError(error);
          }
        } else {
          agentError('AGENT_CONFIRMATION_NOT_AVAILABLE');
        }
        const [message] = await transaction
          .insert(chatMessages)
          .values({
            sessionId: turn.sessionId,
            turnId: turn.id,
            role: 'user',
            content: userMessageContent,
            attachments: [],
          })
          .returning({ id: chatMessages.id });
        if (!message) throw new Error('Confirmation message insert returned no row');
        // `05` message_history_revision advances with the confirmation message so Worker read
        // windows can fence on the session history revision.
        await transaction
          .update(chatSessions)
          .set({
            updatedAt: new Date(),
            messageHistoryRevision: sql`${chatSessions.messageHistoryRevision} + 1`,
          })
          .where(eq(chatSessions.id, turn.sessionId));
        const trace = await transaction.query.agentTraces.findFirst({
          where: eq(agentTraces.turnId, turn.id),
        });
        if (!trace) throw new Error('Agent trace is missing');
        const revision = turn.revision + 1;
        const continuationNo = turn.continuationNo + 1;
        await createQueueIntentInTransaction(transaction, {
          queueName: 'agent',
          jobId: compositeJobId({
            job_type: 'agent.continue',
            turn_id: turn.id,
            continuation_no: continuationNo,
          }),
          aggregateType: 'agent_turn',
          aggregateId: turn.id,
          payloadVersion: 1,
          payload: {
            schema_version: 1,
            job_type: 'agent.continue',
            trace_id: trace.id,
            session_id: turn.sessionId,
            turn_id: turn.id,
            user_message_id: message.id,
            continuation_no: continuationNo,
            turn_revision: revision,
          },
        });
        const event = await appendOutboxEventInTransaction(transaction, {
          scopeType: 'turn',
          scopeId: turn.id,
          eventType: 'turn.status_changed',
          payload: {
            turn_id: turn.id,
            agent_trace_id: trace.id,
            previous_user_status: 'waiting_for_you',
            user_status: 'thinking',
          },
        });
        const response: ConfirmResponse = {
          turn_id: turn.id,
          user_status: 'thinking',
          revision,
          continuation_no: continuationNo,
          event_scope: `turn:${turn.id}`,
          last_event_seq: event.eventSeq,
        };
        const now = new Date();
        const [answered] = await transaction
          .update(agentTurnConfirmations)
          .set({
            status: 'answered',
            answerJson: normalizedAnswer,
            idempotencyKey,
            requestHash,
            responseJson: response,
            answeredAt: now,
          })
          .where(
            and(
              eq(agentTurnConfirmations.id, confirmation.id),
              eq(agentTurnConfirmations.status, 'pending'),
            ),
          )
          .returning({ id: agentTurnConfirmations.id });
        if (!answered) agentError('TURN_STATE_INVALID');
        const [updated] = await transaction
          .update(agentTurns)
          .set({
            status: 'loading_context',
            revision,
            continuationNo,
            confirmedAt: now,
            processingOwner: null,
            processingLeaseExpiresAt: null,
          })
          .where(and(eq(agentTurns.id, turn.id), eq(agentTurns.revision, turn.revision)))
          .returning({ id: agentTurns.id });
        if (!updated) agentError('TURN_STATE_INVALID');
        return { response, eventSeq: event.eventSeq, turnId: turn.id };
      });
    } catch (error) {
      if (error instanceof AgentApiError && error.code === 'CREDIT_BALANCE_EMPTY') {
        await this.abuseProtection?.recordZeroCreditAttempt(userId, context.ipBucket);
      }
      throw error;
    }
    if (result.eventSeq && result.turnId) {
      await this.eventWakeHub
        ?.publish({
          schema_version: 1,
          scope_type: 'turn',
          scope_id: result.turnId,
          event_seq: result.eventSeq,
        })
        .catch(() => undefined);
    }
    return result.response;
  }

  private async replay(
    userId: string,
    key: string,
    hash: string,
    database: Pick<Database, 'query'> = this.database,
  ): Promise<ConfirmResponse | null> {
    const existing = await database.query.agentTurnConfirmations.findFirst({
      where: and(
        eq(agentTurnConfirmations.userId, userId),
        eq(agentTurnConfirmations.idempotencyKey, key),
      ),
    });
    if (!existing) return null;
    if (existing.requestHash !== hash) agentError('IDEMPOTENCY_CONFLICT');
    return existing.responseJson as ConfirmResponse;
  }
}

type AgentTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function assertCreditBalance(transaction: AgentTransaction, userId: string): Promise<void> {
  const [account] = await transaction
    .select({ balance: creditAccounts.balance })
    .from(creditAccounts)
    .where(eq(creditAccounts.userId, userId))
    .for('update');
  if (!account || compareMoney(account.balance, '0.00') <= 0) {
    agentError('CREDIT_BALANCE_EMPTY');
  }
}

function mapProductFactsError(error: unknown): never {
  if (!(error instanceof ProductFactsConfirmationError)) throw error;
  if (error.code === 'SOURCE_INVALID') agentError('REFERENCE_NOT_AVAILABLE');
  if (error.code === 'PRODUCT_INVALID') agentError('RESOURCE_NOT_FOUND');
  agentError('TURN_STATE_INVALID');
}
