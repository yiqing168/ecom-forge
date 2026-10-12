import { and, desc, eq, taskAttempts, tasks, type Database } from '@ecom-forge/db';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

interface AdvanceAttemptInput {
  attemptId: string;
  expectedStatus: typeof taskAttempts.$inferSelect.status;
  expectedDispatchState: typeof taskAttempts.$inferSelect.dispatchState;
  status: typeof taskAttempts.$inferSelect.status;
  dispatchState: typeof taskAttempts.$inferSelect.dispatchState;
  now: Date;
  recoveryEvidence?: 'persisted_transport_write';
  errorCode?: string;
}

export interface TaskAttemptAllocation {
  attempt: typeof taskAttempts.$inferSelect;
  reused: boolean;
}

const REUSE_ATTEMPT_STATUSES = new Set([
  'created',
  'dispatching',
  'accepted',
  'polling',
  'succeeded',
  'timeout',
  'outcome_unknown',
]);

const ATTEMPT_TRANSITIONS = new Set([
  'created/not_dispatched->dispatching/not_dispatched',
  'created/not_dispatched->succeeded/not_dispatched',
  'created/not_dispatched->failed/not_dispatched',
  'dispatching/not_dispatched->accepted/accepted',
  'dispatching/not_dispatched->failed/not_dispatched',
  'dispatching/not_dispatched->outcome_unknown/outcome_unknown',
  'created/not_dispatched->outcome_unknown/outcome_unknown',
  'accepted/accepted->polling/accepted',
  'accepted/accepted->succeeded/accepted',
  'accepted/accepted->failed/accepted',
  'accepted/accepted->timeout/outcome_unknown',
  'accepted/accepted->outcome_unknown/outcome_unknown',
  'polling/accepted->succeeded/accepted',
  'polling/accepted->failed/accepted',
  'polling/accepted->timeout/outcome_unknown',
  'polling/accepted->outcome_unknown/outcome_unknown',
]);

export class TaskAttemptRepository {
  constructor(private readonly database: Database) {}

  allocate(input: {
    taskId: string;
    provider: string;
    maxAttempts?: number;
  }): Promise<TaskAttemptAllocation> {
    return this.database.transaction(async (transaction) => {
      const [task] = await transaction
        .select()
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .for('update')
        .limit(1);
      if (!task) throw new Error('Task does not exist');
      if (!['queued', 'running'].includes(task.status)) {
        throw new Error(`Task status ${task.status} does not allow attempt allocation`);
      }

      const [latest] = await transaction
        .select()
        .from(taskAttempts)
        .where(eq(taskAttempts.taskId, input.taskId))
        .orderBy(desc(taskAttempts.attemptNo))
        .limit(1);
      if (
        latest &&
        (REUSE_ATTEMPT_STATUSES.has(latest.status) || latest.dispatchState !== 'not_dispatched')
      ) {
        return { attempt: latest, reused: true };
      }
      if (input.maxAttempts !== undefined && (latest?.attemptNo ?? 0) >= input.maxAttempts) {
        throw new Error('Task attempt limit has been reached');
      }

      const [created] = await transaction
        .insert(taskAttempts)
        .values({
          taskId: input.taskId,
          attemptNo: (latest?.attemptNo ?? 0) + 1,
          provider: input.provider,
        })
        .returning();
      if (!created) throw new Error('Task attempt insert returned no row');
      return { attempt: created, reused: false };
    });
  }

  advance(input: AdvanceAttemptInput): Promise<'advanced' | 'already_applied'> {
    return this.advanceWith(this.database, input);
  }

  advanceInTransaction(
    transaction: Transaction,
    input: AdvanceAttemptInput,
  ): Promise<'advanced' | 'already_applied'> {
    return this.advanceWith(transaction, input);
  }

  private async advanceWith(
    database: Pick<Database, 'query' | 'update'>,
    input: AdvanceAttemptInput,
  ): Promise<'advanced' | 'already_applied'> {
    const transition = `${input.expectedStatus}/${input.expectedDispatchState}->${input.status}/${input.dispatchState}`;
    if (!ATTEMPT_TRANSITIONS.has(transition)) {
      throw new Error(`Task attempt transition ${transition} is not allowed`);
    }
    if (
      input.expectedStatus === 'created' &&
      input.status === 'outcome_unknown' &&
      input.recoveryEvidence !== 'persisted_transport_write'
    ) {
      throw new Error('Created attempt recovery requires persisted transport-write evidence');
    }
    const [updated] = await database
      .update(taskAttempts)
      .set({
        status: input.status,
        dispatchState: input.dispatchState,
        ...(input.errorCode ? { rawErrorSummary: { error_code: input.errorCode } } : {}),
        ...(input.status === 'dispatching' ? { startedAt: input.now } : {}),
        ...(['succeeded', 'failed', 'timeout', 'outcome_unknown'].includes(input.status)
          ? { endedAt: input.now }
          : {}),
      })
      .where(
        and(
          eq(taskAttempts.id, input.attemptId),
          eq(taskAttempts.status, input.expectedStatus),
          eq(taskAttempts.dispatchState, input.expectedDispatchState),
        ),
      )
      .returning({ id: taskAttempts.id });
    if (updated) return 'advanced';
    const current = await database.query.taskAttempts.findFirst({
      where: eq(taskAttempts.id, input.attemptId),
    });
    if (!current) throw new Error('Task attempt does not exist');
    if (current.status === input.status && current.dispatchState === input.dispatchState) {
      return 'already_applied';
    }
    throw new Error(
      `Task attempt transition rejected from ${current.status}/${current.dispatchState}`,
    );
  }
}
