import {
  agentTraces,
  agentTurns,
  and,
  creditReservations,
  eq,
  inArray,
  models,
  providerCircuitStates,
  runQuotes,
  sql,
  storageChannels,
  storageCredentialVersions,
  storageRuntimeState,
  storageValidationRuns,
  tasks,
  users,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';
import { canonicalSha256, compareMoney, normalizeMoney, type EventWake } from '@ecom-forge/shared';
import type { RetentionTier } from '@ecom-forge/types';

import { CreditError } from './credit-errors.js';
import { lockCreditAccount } from './credit-account.js';
import { freezeReservationInTransaction } from './reservation.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type QuoteSubmissionEvidence =
  | {
      kind: 'user_confirmation@v1';
      confirmation_amount: string;
      cost_confirmation: 'required' | 'not_required';
    }
  | {
      kind: 'generate_action@v2';
      turn_id: string;
      continuation_no: number;
      plan_digest: string;
      authorization_digest: string;
    }
  | {
      kind: 'retry_action@v1';
      source_workflow_run_id: string;
      source_task_id: string;
    };

export interface QuoteSubmitPorts {
  createQueueIntent(
    transaction: Transaction,
    input: {
      queueName: 'workflow' | 'task';
      jobId: string;
      aggregateType: string;
      aggregateId: string;
      payloadVersion: number;
      payload: unknown;
    },
  ): Promise<unknown>;
  appendOutboxEvent(
    transaction: Transaction,
    input: {
      scopeType: string;
      scopeId: string;
      eventType: string;
      payload: Record<string, unknown>;
      retentionTier?: RetentionTier;
    },
  ): Promise<{ eventSeq: number }>;
}

export interface QuoteSubmissionResult {
  response: {
    workflow_run_id: string;
    quote_id: string;
    reservation_id: string | null;
    status: 'queued';
    estimated_total_credits: string;
  };
  wakes: EventWake[];
}

export async function submitRunQuote(input: {
  database: Database;
  ports: QuoteSubmitPorts;
  userId: string;
  quoteId: string;
  idempotencyKey: string;
  evidence: QuoteSubmissionEvidence;
  now?: Date;
}): Promise<QuoteSubmissionResult> {
  const now = input.now ?? new Date();
  const result = await input.database.transaction(async (transaction) => {
    await assertChargeAllowed(transaction, input.userId);
    const preliminary = await transaction.query.runQuotes.findFirst({
      where: and(eq(runQuotes.id, input.quoteId), eq(runQuotes.userId, input.userId)),
      columns: {
        source: true,
        sourceId: true,
        submissionMode: true,
        planDigest: true,
        authorizationDigest: true,
      },
    });
    if (!preliminary) throw new CreditError('Quote was not found', 'RESERVATION_STATE_INVALID');
    await lockCreditAccount(transaction, input.userId);
    const agentQuote =
      preliminary.source === 'chat' &&
      preliminary.sourceId !== null &&
      preliminary.submissionMode !== null &&
      preliminary.planDigest !== null &&
      preliminary.authorizationDigest !== null;
    const turn =
      agentQuote && preliminary.sourceId
        ? await lockAgentTurn(transaction, preliminary.sourceId, input.userId)
        : null;
    const [quote] = await transaction
      .select()
      .from(runQuotes)
      .where(and(eq(runQuotes.id, input.quoteId), eq(runQuotes.userId, input.userId)))
      .for('update')
      .limit(1);
    if (!quote) throw new CreditError('Quote was not found', 'RESERVATION_STATE_INVALID');
    if (agentQuote && (!turn || quote.sourceId !== turn.id)) {
      throw new CreditError('Agent quote ownership is invalid', 'RESERVATION_STATE_INVALID');
    }
    validateSubmissionEvidence(quote, turn, input.evidence);
    const evidenceSignature = canonicalSha256(input.evidence);
    if (quote.status === 'submitted' && quote.workflowRunId) {
      const snapshot = quote.confirmationSnapshot as { submission_evidence_digest?: string };
      if (
        snapshot.submission_evidence_digest &&
        snapshot.submission_evidence_digest !== evidenceSignature
      ) {
        throw new CreditError(
          'Submit payload differs from the original request',
          'IDEMPOTENCY_CONFLICT',
        );
      }
      const reservation = await transaction.query.creditReservations.findFirst({
        where: eq(creditReservations.workflowRunId, quote.workflowRunId),
        columns: { id: true },
      });
      return {
        status: 'submitted' as const,
        response: response(
          quote.workflowRunId,
          quote.id,
          quote.estimatedTotalCredits,
          reservation?.id ?? null,
        ),
        wakes: [] as EventWake[],
      };
    }
    if (quote.status !== 'quoted') {
      throw new CreditError('Quote is no longer submitable', 'RESERVATION_STATE_INVALID');
    }
    if (quote.expiresAt.getTime() <= now.getTime()) {
      await transaction
        .update(runQuotes)
        .set({ status: 'expired' })
        .where(and(eq(runQuotes.id, quote.id), eq(runQuotes.status, 'quoted')));
      const wakes = turn
        ? await expireAgentTurnInTransaction(transaction, input.ports, turn, quote, now)
        : [];
      return { status: 'expired' as const, wakes };
    }
    if (quote.hasUnknownPrice) {
      throw new CreditError('Cost model unavailable', 'COST_MODEL_UNAVAILABLE');
    }
    if (agentQuote || input.evidence.kind === 'retry_action@v1') {
      await assertAgentExecutionAvailable(transaction, quote);
    }
    const reservationKey = `reservation:submit:${input.userId}:${input.idempotencyKey}`;
    const existingReservation = await transaction.query.creditReservations.findFirst({
      where: eq(creditReservations.idempotencyKey, reservationKey),
    });
    if (existingReservation) {
      throw new CreditError('Submit idempotency key was already used', 'IDEMPOTENCY_CONFLICT');
    }
    const [reservation] = await transaction
      .insert(creditReservations)
      .values({
        userId: input.userId,
        estimatedAmount: quote.estimatedTotalCredits,
        idempotencyKey: reservationKey,
      })
      .onConflictDoNothing({ target: creditReservations.idempotencyKey })
      .returning();
    if (!reservation) {
      throw new CreditError('Submit idempotency key was already used', 'IDEMPOTENCY_CONFLICT');
    }
    await freezeReservationInTransaction(transaction, {
      userId: input.userId,
      reservationId: reservation.id,
      amount: quote.estimatedTotalCredits,
      idempotencyKey: `freeze:reservation:${reservation.id}`,
      metadata: { quote_id: quote.id },
    });
    const [workflow] = await transaction
      .insert(workflowRuns)
      .values({
        userId: input.userId,
        triggerMode: quote.source,
        runQuoteId: quote.id,
        reservationId: reservation.id,
        status: 'reserved',
        planSnapshot: quote.planSnapshot,
        skillSnapshot: quote.skillSnapshot,
        pricingSnapshot: quote.pricingSnapshot,
      })
      .returning();
    if (!workflow) throw new Error('Workflow insert returned no row');
    await transaction
      .update(creditReservations)
      .set({ workflowRunId: workflow.id })
      .where(eq(creditReservations.id, reservation.id));
    const quoteTasks = quoteItems(quote);
    const storageSnapshot = await resolveStorageSnapshot(transaction, quoteTasks);
    const createdTasks = [];
    for (const item of quoteTasks) {
      const [task] = await transaction
        .insert(tasks)
        .values({
          workflowRunId: workflow.id,
          parentTaskId: item.parent_task_id,
          type: item.task_type,
          status: 'queued',
          modelId: item.model_id,
          modelVersion: item.model_version,
          costEstimate: item.estimated_credits,
          idempotencyKey: `task:${workflow.id}:${item.task_key}`,
          dagNodeId: item.task_key,
          dagJson: item.dag_json,
          paramsSnapshot: {
            source: quote.source,
            ...item.params_snapshot,
            ...(storageSnapshot ? { storage_snapshot: storageSnapshot } : {}),
          },
        })
        .returning();
      if (!task) throw new Error('Task insert returned no row');
      createdTasks.push(task);

      const moderation = moderationTaskClosure(item);
      if (moderation) {
        for (let outputIndex = 0; outputIndex < moderation.outputCount; outputIndex += 1) {
          const [moderationTask] = await transaction
            .insert(tasks)
            .values({
              workflowRunId: workflow.id,
              parentTaskId: task.id,
              type: 'moderation.image',
              status: 'pending',
              modelId: moderation.route.model_snapshot_id,
              modelVersion: null,
              costEstimate: '0.00',
              idempotencyKey: `task:${workflow.id}:${item.task_key}:moderation:${outputIndex}`,
              dagNodeId: `${item.task_key}:moderation:${outputIndex}`,
              dagJson: {
                node_id: `${item.task_key}:moderation:${outputIndex}`,
                depends_on: [item.task_key],
              },
              paramsSnapshot: {
                schema_version: 1,
                source: quote.source,
                generation_task_key: item.task_key,
                generation_operation_key: item.params_snapshot.operation_key,
                output_index: outputIndex,
                moderation_route: moderation.route,
                ...(storageSnapshot ? { storage_snapshot: storageSnapshot } : {}),
              },
            })
            .returning({ id: tasks.id });
          if (!moderationTask) throw new Error('Moderation task insert returned no row');
        }
      }
    }
    if (createdTasks.length === 0) throw new Error('Quote has no executable task');
    await transaction
      .update(workflowRuns)
      .set({ status: 'queued', revision: sql`${workflowRuns.revision} + 1` })
      .where(and(eq(workflowRuns.id, workflow.id), eq(workflowRuns.status, 'reserved')));
    await input.ports.createQueueIntent(transaction, {
      queueName: 'workflow',
      jobId: workflow.id,
      aggregateType: 'workflow_run',
      aggregateId: workflow.id,
      payloadVersion: 1,
      payload: {
        schema_version: 1,
        job_type: 'workflow.advance',
        trace_id: workflow.id,
        workflow_run_id: workflow.id,
        user_id: input.userId,
      },
    });
    for (const task of createdTasks) {
      await input.ports.createQueueIntent(transaction, {
        queueName: 'task',
        jobId: task.id,
        aggregateType: 'task',
        aggregateId: task.id,
        payloadVersion: 1,
        payload: {
          schema_version: 1,
          job_type: 'task.execute',
          trace_id: workflow.id,
          task_id: task.id,
          workflow_run_id: workflow.id,
          user_id: input.userId,
        },
      });
    }
    const workflowEvent = await input.ports.appendOutboxEvent(transaction, {
      scopeType: 'workflow_run',
      scopeId: workflow.id,
      eventType: 'workflow.created',
      payload: { workflow_run_id: workflow.id, status: 'queued' },
    });
    await transaction
      .update(runQuotes)
      .set({
        status: 'submitted',
        workflowRunId: workflow.id,
        confirmationSnapshot: {
          estimated_total_credits: quote.estimatedTotalCredits,
          currency: 'credits',
          submission_evidence_kind: input.evidence.kind,
          submission_evidence_digest: evidenceSignature,
        },
        confirmedAt: now,
      })
      .where(and(eq(runQuotes.id, quote.id), eq(runQuotes.status, 'quoted')));
    const wakes: EventWake[] = [wake('workflow_run', workflow.id, workflowEvent.eventSeq)];
    if (turn) {
      const [updatedTurn] = await transaction
        .update(agentTurns)
        .set({
          workflowRunId: workflow.id,
          status: 'waiting_provider_confirmation',
          revision: turn.revision + 1,
          confirmedAt: now,
        })
        .where(
          and(
            eq(agentTurns.id, turn.id),
            eq(agentTurns.revision, turn.revision),
            eq(agentTurns.runQuoteId, quote.id),
          ),
        )
        .returning({ id: agentTurns.id });
      if (!updatedTurn) throw new Error('AGENT_QUOTE_SUBMIT_TURN_CAS_FAILED');
      const trace = await transaction.query.agentTraces.findFirst({
        where: eq(agentTraces.turnId, turn.id),
        columns: { id: true },
      });
      if (!trace) throw new Error('AGENT_TRACE_MISSING');
      await transaction
        .update(agentTraces)
        .set({ status: 'succeeded', endedAt: now })
        .where(eq(agentTraces.id, trace.id));
      const turnEvent = await input.ports.appendOutboxEvent(transaction, {
        scopeType: 'turn',
        scopeId: turn.id,
        eventType: 'turn.status_changed',
        payload: {
          turn_id: turn.id,
          agent_trace_id: trace.id,
          previous_user_status:
            turn.status === 'waiting_user_confirmation' ? 'waiting_for_you' : 'thinking',
          user_status: 'thinking',
          workflow_run_id: workflow.id,
        },
      });
      wakes.push(wake('turn', turn.id, turnEvent.eventSeq));
    }
    return {
      status: 'submitted' as const,
      response: response(workflow.id, quote.id, quote.estimatedTotalCredits, reservation.id),
      wakes,
    };
  });
  if (result.status === 'expired') {
    throw new CreditError('Quote expired', 'RUN_QUOTE_EXPIRED', result.wakes);
  }
  return { response: result.response, wakes: result.wakes };
}

async function expireAgentTurnInTransaction(
  transaction: Transaction,
  ports: QuoteSubmitPorts,
  turn: typeof agentTurns.$inferSelect,
  quote: typeof runQuotes.$inferSelect,
  now: Date,
): Promise<EventWake[]> {
  if (
    turn.runQuoteId !== quote.id ||
    !['waiting_user_confirmation', 'run_quote_created'].includes(turn.status)
  ) {
    throw new CreditError('Agent quote state is invalid', 'RESERVATION_STATE_INVALID');
  }
  const trace = await transaction.query.agentTraces.findFirst({
    where: eq(agentTraces.turnId, turn.id),
    columns: { id: true },
  });
  if (!trace) throw new Error('AGENT_TRACE_MISSING');
  const [updatedTurn] = await transaction
    .update(agentTurns)
    .set({ status: 'cancelled', revision: turn.revision + 1, endedAt: now })
    .where(
      and(
        eq(agentTurns.id, turn.id),
        eq(agentTurns.revision, turn.revision),
        eq(agentTurns.runQuoteId, quote.id),
      ),
    )
    .returning({ id: agentTurns.id });
  if (!updatedTurn) throw new Error('AGENT_QUOTE_EXPIRY_TURN_CAS_FAILED');
  await transaction
    .update(agentTraces)
    .set({ status: 'cancelled', endedAt: now })
    .where(eq(agentTraces.id, trace.id));
  await ports.appendOutboxEvent(transaction, {
    scopeType: 'turn',
    scopeId: turn.id,
    eventType: 'turn.status_changed',
    payload: {
      turn_id: turn.id,
      agent_trace_id: trace.id,
      previous_user_status:
        turn.status === 'waiting_user_confirmation' ? 'waiting_for_you' : 'thinking',
      user_status: 'stopped',
    },
  });
  const event = await ports.appendOutboxEvent(transaction, {
    scopeType: 'turn',
    scopeId: turn.id,
    eventType: 'turn.cancelled',
    payload: {
      turn_id: turn.id,
      agent_trace_id: trace.id,
      reason: 'confirmation_expired',
      user_status: 'stopped',
    },
  });
  return [wake('turn', turn.id, event.eventSeq)];
}

async function assertChargeAllowed(database: Pick<Database, 'query'>, userId: string) {
  const user = await database.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { emailVerifiedAt: true, riskStatus: true },
  });
  if (!user?.emailVerifiedAt) {
    throw new CreditError('Verified email is required for charging', 'AUTH_VERIFICATION_REQUIRED');
  }
  if (user.riskStatus !== 'normal') {
    throw new CreditError('Account is restricted from charging', 'FORBIDDEN');
  }
}

async function lockAgentTurn(transaction: Transaction, turnId: string, userId: string) {
  const [turn] = await transaction
    .select()
    .from(agentTurns)
    .where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId)))
    .for('update')
    .limit(1);
  return turn ?? null;
}

function validateSubmissionEvidence(
  quote: typeof runQuotes.$inferSelect,
  turn: typeof agentTurns.$inferSelect | null,
  evidence: QuoteSubmissionEvidence,
): void {
  if (evidence.kind === 'retry_action@v1') {
    const retry = retrySnapshot(quote);
    if (
      quote.source !== 'chat' ||
      quote.sourceId !== null ||
      quote.submissionMode !== null ||
      !retry ||
      retry.source_workflow_run_id !== evidence.source_workflow_run_id ||
      retry.source_task_id !== evidence.source_task_id
    ) {
      throw new CreditError('Retry authorization does not match quote', 'COST_ACK_REQUIRED');
    }
    return;
  }
  if (evidence.kind === 'user_confirmation@v1') {
    const expectedConfirmation =
      quote.submissionMode === 'auto_submit' ? 'not_required' : 'required';
    if (
      compareMoney(normalizeMoney(evidence.confirmation_amount), quote.estimatedTotalCredits) !==
        0 ||
      evidence.cost_confirmation !== expectedConfirmation
    ) {
      throw new CreditError('Cost confirmation does not match quote', 'COST_ACK_REQUIRED');
    }
    if (quote.source === 'chat' && quote.submissionMode !== null) {
      const stateMatches =
        quote.status === 'submitted'
          ? turn?.status === 'waiting_provider_confirmation' &&
            turn.workflowRunId === quote.workflowRunId
          : !!turn && ['waiting_user_confirmation', 'run_quote_created'].includes(turn.status);
      if (
        !turn ||
        turn.runQuoteId !== quote.id ||
        !stateMatches ||
        turn.executionAuthorizationHash !== quote.authorizationDigest ||
        quote.planDigest === null
      ) {
        throw new CreditError('Agent quote state is invalid', 'RESERVATION_STATE_INVALID');
      }
    }
    return;
  }
  if (
    !turn ||
    quote.submissionMode !== 'auto_submit' ||
    quote.source !== 'chat' ||
    quote.sourceId !== evidence.turn_id ||
    turn.id !== evidence.turn_id ||
    turn.continuationNo !== evidence.continuation_no ||
    turn.runQuoteId !== quote.id ||
    (quote.status === 'submitted'
      ? turn.status !== 'waiting_provider_confirmation' ||
        turn.workflowRunId !== quote.workflowRunId
      : turn.status !== 'run_quote_created') ||
    quote.planDigest !== evidence.plan_digest ||
    quote.authorizationDigest !== evidence.authorization_digest ||
    turn.executionAuthorizationHash !== evidence.authorization_digest ||
    !turn.executionAuthorizationJson ||
    typeof turn.executionAuthorizationJson !== 'object' ||
    Array.isArray(turn.executionAuthorizationJson) ||
    (turn.executionAuthorizationJson as { schema_version?: unknown }).schema_version !== 2 ||
    (turn.executionAuthorizationJson as { kind?: unknown }).kind !== 'generate_action'
  ) {
    throw new CreditError('Turn authorization does not match quote', 'COST_ACK_REQUIRED');
  }
}

function quoteItems(quote: typeof runQuotes.$inferSelect) {
  const snapshot = quote.planSnapshot as {
    items?: Array<{
      taskKey: string;
      taskType: string;
      estimatedCredits: string;
      parentTaskId?: string;
      paramsSnapshot: Record<string, unknown> & {
        model_snapshot?: {
          id?: string;
          provider?: string;
          model_id?: string;
          version?: string;
          status_evidence_digest?: string | null;
        };
        input_bindings?: Array<{
          binding_key: string;
          kind: 'asset' | 'artifact';
          object_id: string;
          object_version: string;
          content_hash: string;
          role:
            | 'product'
            | 'style_reference'
            | 'composition_reference'
            | 'identity_anchor'
            | 'semantic_reference'
            | 'edit_source'
            | 'other';
          sort_order: number;
          provider_input: boolean;
          publication_revision: number | null;
        }>;
        operation_key?: string;
        output_count?: number;
        model_selection?: {
          moderation?: {
            image?: {
              capability?: string;
              runtime_revision?: number;
              model_snapshot_id?: string;
              credential_version_id?: string;
              policy_version?: string;
              evidence_digest?: string;
              pricing_digest?: string;
              risk_adjusted_cost_cny?: string | null;
            };
          };
        };
        depends_on?: string[];
      };
    }>;
  };
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0) {
    throw new CreditError('Quote execution snapshot is unavailable', 'COST_MODEL_UNAVAILABLE');
  }
  return snapshot.items.map((item) => ({
    task_key: item.taskKey,
    task_type: item.taskType,
    estimated_credits: normalizeMoney(item.estimatedCredits),
    parent_task_id: item.parentTaskId,
    params_snapshot: item.paramsSnapshot,
    model_id: item.paramsSnapshot.model_snapshot?.id,
    model_version: item.paramsSnapshot.model_snapshot?.version,
    dag_json: { node_id: item.taskKey, depends_on: item.paramsSnapshot.depends_on ?? [] },
  }));
}

function retrySnapshot(quote: typeof runQuotes.$inferSelect): {
  source_workflow_run_id: string;
  source_task_id: string;
} | null {
  const snapshot = quote.planSnapshot as {
    retry?: { source_workflow_run_id?: unknown; source_task_id?: unknown };
  };
  return typeof snapshot.retry?.source_workflow_run_id === 'string' &&
    typeof snapshot.retry.source_task_id === 'string'
    ? {
        source_workflow_run_id: snapshot.retry.source_workflow_run_id,
        source_task_id: snapshot.retry.source_task_id,
      }
    : null;
}

type QuoteItem = ReturnType<typeof quoteItems>[number];

function moderationTaskClosure(item: QuoteItem): {
  outputCount: number;
  route: {
    capability: 'moderation.image';
    runtime_revision: number;
    model_snapshot_id: string;
    credential_version_id: string;
    policy_version: string;
    evidence_digest: string;
    pricing_digest: string;
    risk_adjusted_cost_cny: string | null;
  };
} | null {
  const route = item.params_snapshot.model_selection?.moderation?.image;
  if (!route) return null;
  if (item.task_type !== 'image.generate' && item.task_type !== 'image.edit') {
    throw new CreditError(
      'Moderation route is attached to a non-image task',
      'COST_MODEL_UNAVAILABLE',
    );
  }
  const outputCount = item.params_snapshot.output_count;
  if (
    route.capability !== 'moderation.image' ||
    !Number.isInteger(route.runtime_revision) ||
    route.runtime_revision! <= 0 ||
    !isUuid(route.model_snapshot_id) ||
    !isUuid(route.credential_version_id) ||
    typeof route.policy_version !== 'string' ||
    route.policy_version.length < 1 ||
    route.policy_version.length > 128 ||
    !isSha256(route.evidence_digest) ||
    !isSha256(route.pricing_digest) ||
    (route.risk_adjusted_cost_cny !== null && typeof route.risk_adjusted_cost_cny !== 'string') ||
    !Number.isInteger(outputCount) ||
    outputCount! <= 0 ||
    outputCount! > 16 ||
    !isSha256(item.params_snapshot.operation_key)
  ) {
    throw new CreditError('Moderation execution snapshot is invalid', 'COST_MODEL_UNAVAILABLE');
  }
  return {
    outputCount: outputCount!,
    route: {
      capability: 'moderation.image',
      runtime_revision: route.runtime_revision!,
      model_snapshot_id: route.model_snapshot_id,
      credential_version_id: route.credential_version_id,
      policy_version: route.policy_version,
      evidence_digest: route.evidence_digest,
      pricing_digest: route.pricing_digest,
      risk_adjusted_cost_cny: route.risk_adjusted_cost_cny,
    },
  };
}

async function resolveStorageSnapshot(transaction: Transaction, items: QuoteItem[]) {
  const requiresStorage = items.some((item) => item.params_snapshot.model_selection !== undefined);
  if (!requiresStorage) return null;
  if (
    items.some(
      (item) =>
        !['image.generate', 'image.edit'].includes(item.task_type) ||
        item.params_snapshot.model_selection === undefined,
    )
  ) {
    throw new CreditError('Media storage closure is incomplete', 'PROVIDER_UNAVAILABLE');
  }
  const [runtime] = await transaction
    .select()
    .from(storageRuntimeState)
    .where(eq(storageRuntimeState.purpose, 'private_assets'))
    .for('update')
    .limit(1);
  if (!runtime?.activeChannelId) {
    throw new CreditError('Private storage is unavailable', 'PROVIDER_UNAVAILABLE');
  }
  const [channel] = await transaction
    .select()
    .from(storageChannels)
    .where(eq(storageChannels.id, runtime.activeChannelId))
    .for('update')
    .limit(1);
  const credential = channel?.activeCredentialVersionId
    ? await transaction.query.storageCredentialVersions.findFirst({
        where: and(
          eq(storageCredentialVersions.id, channel.activeCredentialVersionId),
          eq(storageCredentialVersions.storageChannelId, channel.id),
        ),
      })
    : undefined;
  const validation = credential?.validationEvidenceDigest
    ? await transaction.query.storageValidationRuns.findFirst({
        where: and(
          eq(storageValidationRuns.storageChannelId, channel!.id),
          eq(storageValidationRuns.credentialVersionId, credential.id),
          eq(storageValidationRuns.status, 'passed'),
          eq(storageValidationRuns.evidenceDigest, credential.validationEvidenceDigest),
        ),
        orderBy: (run, { desc }) => [desc(run.completedAt), desc(run.id)],
      })
    : undefined;
  if (
    !channel ||
    channel.purpose !== 'private_assets' ||
    channel.status !== 'active' ||
    !credential ||
    credential.status !== 'active' ||
    !credential.validationEvidenceDigest ||
    !validation
  ) {
    throw new CreditError('Private storage binding is unavailable', 'PROVIDER_UNAVAILABLE');
  }
  return {
    schema_version: 1 as const,
    purpose: 'private_assets' as const,
    runtime_revision: runtime.runtimeRevision,
    channel_id: channel.id,
    channel_revision: channel.revision,
    adapter_key: channel.adapterKey,
    endpoint_profile_key: channel.endpointProfileKey,
    region: channel.region,
    credential_version_id: credential.id,
    validation_evidence_digest: credential.validationEvidenceDigest,
  };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function assertAgentExecutionAvailable(
  transaction: Transaction,
  quote: typeof runQuotes.$inferSelect,
): Promise<void> {
  const snapshots = quoteItems(quote).map((item) => item.params_snapshot.model_snapshot);
  if (
    snapshots.some(
      (snapshot) => !snapshot?.id || !snapshot.provider || !snapshot.model_id || !snapshot.version,
    )
  ) {
    throw new CreditError('Agent model snapshot is unavailable', 'COST_MODEL_UNAVAILABLE');
  }
  const expected = new Map(snapshots.map((snapshot) => [snapshot!.id!, snapshot!]));
  const modelIds = [...expected.keys()].sort();
  const modelRows = await transaction
    .select()
    .from(models)
    .where(inArray(models.id, modelIds))
    .orderBy(models.id)
    .for('update');
  if (
    modelRows.length !== modelIds.length ||
    modelRows.some((row) => {
      const snapshot = expected.get(row.id);
      return (
        !snapshot ||
        row.status !== 'poc_passed' ||
        row.statusEvidenceDigest !== snapshot.status_evidence_digest ||
        row.provider !== snapshot.provider ||
        row.modelId !== snapshot.model_id ||
        row.version !== snapshot.version
      );
    })
  ) {
    throw new CreditError('Agent model is no longer approved', 'PROVIDER_UNAVAILABLE');
  }
  const scopeRows = [
    ...new Map(
      modelRows.map((row) => [
        `provider:${row.provider}`,
        {
          scopeType: 'provider' as const,
          scopeKey: `provider:${row.provider}`,
          provider: row.provider,
          modelId: null,
        },
      ]),
    ).values(),
    ...modelRows.map((row) => ({
      scopeType: 'model' as const,
      scopeKey: `model:${row.id}`,
      provider: row.provider,
      modelId: row.id,
    })),
  ].sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  await transaction.insert(providerCircuitStates).values(scopeRows).onConflictDoNothing();
  const circuitRows = await transaction
    .select()
    .from(providerCircuitStates)
    .where(
      inArray(
        providerCircuitStates.scopeKey,
        scopeRows.map((row) => row.scopeKey),
      ),
    )
    .orderBy(providerCircuitStates.scopeKey)
    .for('update');
  if (
    circuitRows.length !== scopeRows.length ||
    circuitRows.some((row) => row.status !== 'closed' || row.reasonCode === 'hourly_budget')
  ) {
    throw new CreditError('Provider is not available for a new submission', 'PROVIDER_UNAVAILABLE');
  }
}

function response(
  workflowId: string,
  quoteId: string,
  amount: string,
  reservationId: string | null,
) {
  return {
    workflow_run_id: workflowId,
    quote_id: quoteId,
    reservation_id: reservationId,
    status: 'queued' as const,
    estimated_total_credits: normalizeMoney(amount),
  };
}

function wake(scopeType: 'workflow_run' | 'turn', scopeId: string, eventSeq: number): EventWake {
  return { schema_version: 1, scope_type: scopeType, scope_id: scopeId, event_seq: eventSeq };
}
