import { performance } from 'node:perf_hooks';

import { transcriptSequenceSchema } from '@ecom-forge/agent';
import {
  agentTurns,
  and,
  chatSessions,
  eq,
  inArray,
  isNull,
  sql,
  type Database,
} from '@ecom-forge/db';
import { z } from 'zod';

import { WORKER_RUNTIME_DEFAULTS } from '../config/runtime-defaults.js';
import { errorDetailLine } from '../provider/provider-telemetry.js';
import { emitTranscriptMetric, transcriptMetricValue } from './agent-transcript-metrics.js';
import type { AgentWriteQuery, Transaction } from './agent-turn.types.js';

const uuid = z.uuid().toLowerCase();
const inputSchema = z.strictObject({
  userId: uuid,
  sessionId: uuid,
  turnId: uuid,
  owner: z.string().min(1).max(256),
  revision: z.int().positive().max(2_147_483_647),
  continuationNo: z.int().positive().max(2_147_483_647),
  expectedGeneration: transcriptSequenceSchema,
});
const stateSchema = z.strictObject({
  schema_version: z.literal(1),
  mode: z.enum(['shadow', 'active']),
  integrity_version: z.literal(1),
  verified_through_sequence: z.union([z.literal('0'), transcriptSequenceSchema]),
  verified_digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const limitsSchema = z
  .strictObject({
    lockTimeoutMs: z.int().positive().max(WORKER_RUNTIME_DEFAULTS.agentTranscriptLockTimeoutMs),
    transactionTimeoutMs: z
      .int()
      .positive()
      .max(WORKER_RUNTIME_DEFAULTS.agentTranscriptTransactionTimeoutMs),
  })
  .refine((limits) => limits.lockTimeoutMs <= limits.transactionTimeoutMs);

export type AgentTranscriptWriteInput = z.infer<typeof inputSchema>;
type WriteLimits = z.infer<typeof limitsSchema>;
export type AgentTranscriptWriteFailure =
  | 'input_invalid'
  | 'session_unavailable'
  | 'session_state_invalid'
  | 'history_changed'
  | 'turn_stale'
  | 'lease_expired'
  | 'scope_closed'
  | 'scope_rejected'
  | 'concurrent_query'
  | 'transaction_expired'
  | 'lock_timeout'
  /** A deterministic domain invariant failed (missing trace, CAS conflict, cost drift, …). */
  | 'domain_conflict'
  | 'storage_unavailable';

export class AgentTranscriptWriteError extends Error {
  /**
   * `detail` is an optional controlled code or sanitized diagnostic (never user content) so callers and
   * logs can tell which invariant failed without widening the public error surface.
   */
  constructor(
    readonly reason: AgentTranscriptWriteFailure,
    readonly detail?: string,
    options?: ErrorOptions,
  ) {
    super('AGENT_TRANSCRIPT_WRITE_FAILED', options);
    this.name = 'AgentTranscriptWriteError';
  }
}

export interface AgentTranscriptWriteScope {
  readonly userId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly continuationNo: number;
  readonly revision: number;
  readonly nextSequence: bigint;
  readonly generation: bigint;
  readonly messageRevision: bigint;
  /** Scope issued only after native generation and owned turn validation. */
  /** One awaited SQL query. Never retain the raw transaction or perform external I/O. */
  query<T>(this: void, build: (transaction: Transaction) => PromiseLike<T>): Promise<T>;
  /** Poison the transaction after an application-level validation failure, even if caught. */
  abort(): never;
}

/** Fresh, non-financial transactions only. This does not authorize or capture semantic items. */
export class AgentTranscriptWriteTransactions {
  private readonly limits: WriteLimits;

  constructor(
    private readonly database: Pick<Database, 'transaction'>,
    limits?: WriteLimits,
  ) {
    const parsed = limitsSchema.safeParse(
      limits ?? {
        lockTimeoutMs: WORKER_RUNTIME_DEFAULTS.agentTranscriptLockTimeoutMs,
        transactionTimeoutMs: WORKER_RUNTIME_DEFAULTS.agentTranscriptTransactionTimeoutMs,
      },
    );
    if (!parsed.success) fail('input_invalid');
    this.limits = parsed.data;
  }

  async run<T>(
    raw: AgentTranscriptWriteInput,
    operation: (scope: AgentTranscriptWriteScope) => Promise<T>,
  ): Promise<T> {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) fail('input_invalid');
    const input = parsed.data;
    try {
      return await this.database.transaction((transaction) =>
        withQueryBudget(transaction, this.limits, (budget) =>
          this.runOwned(budget, input, operation),
        ),
      );
    } catch (error) {
      throw classify(error);
    }
  }

  /** Lock the session row and record the bounded lock-wait sample for the transcript metric. */
  private async lockSession(budget: QueryBudget, input: AgentTranscriptWriteInput) {
    const startedAt = performance.now();
    try {
      const [session] = await budget.query((tx) =>
        tx
          .select({
            nextSequence: chatSessions.transcriptNextSequence,
            generation: chatSessions.transcriptGeneration,
            messageRevision: chatSessions.messageHistoryRevision,
            state: chatSessions.transcriptStateJson,
          })
          .from(chatSessions)
          .where(
            and(
              eq(chatSessions.id, input.sessionId),
              eq(chatSessions.userId, input.userId),
              isNull(chatSessions.archivedAt),
            ),
          )
          .for('no key update'),
      );
      emitTranscriptMetric({
        metric: 'transcript_lock_wait',
        format: 'transcript_v1',
        result: 'ok',
        value: transcriptMetricValue(performance.now() - startedAt),
      });
      return session;
    } catch (error) {
      emitTranscriptMetric({
        metric: 'transcript_lock_wait',
        format: 'transcript_v1',
        result: 'failure',
        value: transcriptMetricValue(performance.now() - startedAt),
      });
      throw error;
    }
  }

  private async runOwned<T>(
    budget: QueryBudget,
    input: AgentTranscriptWriteInput,
    operation: (scope: AgentTranscriptWriteScope) => Promise<T>,
  ) {
    const session = await this.lockSession(budget, input);
    if (!session) fail('session_unavailable');
    const state = stateSchema.safeParse(session.state);
    if (
      !state.success ||
      session.nextSequence <= BigInt(state.data.verified_through_sequence) ||
      session.messageRevision < 0n
    )
      fail('session_state_invalid');
    if (session.generation !== BigInt(input.expectedGeneration)) fail('history_changed');
    const [turn] = await budget.query((tx) =>
      tx
        .select({
          leaseExpiresAt: agentTurns.processingLeaseExpiresAt,
        })
        .from(agentTurns)
        .where(
          and(
            eq(agentTurns.id, input.turnId),
            eq(agentTurns.userId, input.userId),
            eq(agentTurns.sessionId, input.sessionId),
            eq(agentTurns.processingOwner, input.owner),
            eq(agentTurns.revision, input.revision),
            eq(agentTurns.continuationNo, input.continuationNo),
            eq(agentTurns.transcriptCaptureVersion, 1),
            isNull(agentTurns.runQuoteId),
            isNull(agentTurns.workflowRunId),
            inArray(agentTurns.status, [
              'received_user_input',
              'loading_context',
              'detecting_intent',
              'validating_context',
              'clarifying',
              'planning',
              'plan_ready',
            ]),
            sql`${agentTurns.processingLeaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .for('update'),
    );
    if (!turn?.leaseExpiresAt) fail('turn_stale');
    const scope: AgentTranscriptWriteScope = Object.freeze({
      userId: input.userId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      continuationNo: input.continuationNo,
      revision: input.revision,
      nextSequence: session.nextSequence,
      generation: session.generation,
      messageRevision: session.messageRevision,
      query: <R>(build: (tx: Transaction) => PromiseLike<R>) => budget.query(build),
      abort: () => {
        budget.close('scope_rejected');
        fail('scope_rejected');
      },
    });
    const result = await operation(scope);
    // Check the original lease; a valid terminal callback may have cleared the turn owner.
    const lease = await budget.query((tx) =>
      tx.execute(
        sql`select ${turn.leaseExpiresAt!.toISOString()}::timestamptz > clock_timestamp() as valid`,
      ),
    );
    if (lease[0]?.valid !== true) fail('lease_expired');
    return result;
  }
}

/** Share the native whole-transaction deadline with summary publication and its dependency reads. */
export function withTranscriptQueryBudget<T>(
  transaction: Transaction,
  operation: (query: AgentWriteQuery) => Promise<T>,
): Promise<T> {
  return withQueryBudget(
    transaction,
    {
      lockTimeoutMs: WORKER_RUNTIME_DEFAULTS.agentTranscriptLockTimeoutMs,
      transactionTimeoutMs: WORKER_RUNTIME_DEFAULTS.agentTranscriptTransactionTimeoutMs,
    },
    (budget) => operation((build) => budget.query(build)),
  );
}

async function withQueryBudget<T>(
  transaction: Transaction,
  limits: WriteLimits,
  operation: (budget: QueryBudget) => Promise<T>,
): Promise<T> {
  const budget = new QueryBudget(transaction, limits);
  const rollbackReserve = Math.min(
    WORKER_RUNTIME_DEFAULTS.agentTranscriptRollbackReserveMs,
    Math.floor(limits.transactionTimeoutMs / 10),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      budget.close('transaction_expired');
      reject(new AgentTranscriptWriteError('transaction_expired'));
    }, limits.transactionTimeoutMs - rollbackReserve);
  });
  try {
    const result = await Promise.race([operation(budget), expired]);
    budget.assertOpen();
    return result;
  } finally {
    clearTimeout(timer);
    budget.close('scope_closed');
  }
}

class QueryBudget {
  private failure: AgentTranscriptWriteFailure | null = null;
  private pending = false;

  constructor(
    private readonly transaction: Transaction,
    private readonly limits: WriteLimits,
  ) {}

  close(reason: AgentTranscriptWriteFailure) {
    this.failure ??= reason;
  }

  assertOpen() {
    if (this.failure) fail(this.failure);
    if (this.pending) fail('concurrent_query');
  }

  async query<T>(build: (transaction: Transaction) => PromiseLike<T>): Promise<T> {
    if (this.failure) fail(this.failure);
    if (this.pending) {
      this.close('concurrent_query');
      fail('concurrent_query');
    }
    this.pending = true;
    try {
      // PG16 has no whole-transaction timeout. Carry the remaining server budget into every SQL/idle period.
      const clock = await this.transaction.execute(sql`
        with budget as materialized (
          select greatest(0, ${this.limits.transactionTimeoutMs} - ceil(extract(epoch from (clock_timestamp() - transaction_timestamp())) * 1000))::int as remaining
        )
        select remaining,
          set_config('statement_timeout', greatest(1, remaining)::text, true),
          set_config('idle_in_transaction_session_timeout', greatest(1, remaining)::text, true),
          set_config('lock_timeout', greatest(1, least(${this.limits.lockTimeoutMs}, remaining))::text, true)
        from budget
      `);
      if (typeof clock[0]?.remaining !== 'number' || clock[0].remaining <= 0)
        fail('transaction_expired');
      if (this.failure) fail(this.failure);
      const result = await build(this.transaction);
      if (this.failure) fail(this.failure);
      return result;
    } catch (error) {
      const classified = classify(error);
      this.close(classified.reason);
      throw classified;
    } finally {
      this.pending = false;
    }
  }
}

/** Controlled invariant code thrown by domain code, e.g. `AGENT_TRACE_MISSING`. */
const CONTROLLED_ERROR_CODE = /^AGENT_[A-Z0-9_]{1,58}$/;

function classify(error: unknown): AgentTranscriptWriteError {
  if (error instanceof AgentTranscriptWriteError) return error;
  // Drizzle wraps driver errors; never carry SQL, values or raw messages into the public error.
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const entry = current as { code?: unknown; cause?: unknown };
    if (entry.code === '55P03') return new AgentTranscriptWriteError('lock_timeout');
    if (entry.code === '57014' || entry.code === '25P03')
      return new AgentTranscriptWriteError('transaction_expired');
    current = entry.cause;
  }
  // A deterministic domain invariant (missing trace, summary CAS conflict, cost drift, schema
  // mismatch, …) is not an infrastructure failure: classifying it as `storage_unavailable` hides
  // the cause from callers and from operations. Surface it as `domain_conflict` instead, and
  // Keep the stable invariant code in detail; nested causes are sanitized by telemetry.
  const controlled = error instanceof Error && CONTROLLED_ERROR_CODE.test(error.message);
  const detail = controlled ? error.message : errorDetailLine(error, 600);
  const reason =
    error instanceof z.ZodError || controlled ? 'domain_conflict' : 'storage_unavailable';
  return new AgentTranscriptWriteError(reason, detail, { cause: error });
}

function fail(reason: AgentTranscriptWriteFailure): never {
  throw new AgentTranscriptWriteError(reason);
}
