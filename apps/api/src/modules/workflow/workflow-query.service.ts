import {
  and,
  asc,
  artifacts,
  desc,
  eq,
  eventOutbox,
  gte,
  inArray,
  lt,
  lte,
  max,
  or,
  sql,
  taskAttempts,
  tasks,
  workflowRuns,
  type Database,
} from '@ecom-forge/db';

import { TaskCursorCodec, type TaskCursorPosition, type TaskListFilters } from './task-cursor.js';

type WorkflowReadContext = Pick<Database, 'query' | 'select'>;

export interface LatestAttemptSummary {
  id: string;
  attempt_no: number;
  status: typeof taskAttempts.$inferSelect.status;
  dispatchState: typeof taskAttempts.$inferSelect.dispatchState;
}

type LatestRetrySummary = {
  parentTaskId: string;
  taskId: string;
  workflowRunId: string;
  status: typeof tasks.$inferSelect.status;
};

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function durationMs(startedAt: Date | null, endedAt: Date | null, now: Date): number | null {
  if (!startedAt) return null;
  return Math.max(0, (endedAt ?? now).getTime() - startedAt.getTime());
}

export class WorkflowQueryService {
  private readonly cursorCodec: TaskCursorCodec;

  constructor(
    private readonly database: Database,
    cursorSecret: string,
  ) {
    this.cursorCodec = new TaskCursorCodec(cursorSecret);
  }

  async getWorkflowSnapshot(userId: string, workflowRunId: string) {
    return this.database.transaction(
      async (transaction) => {
        const workflow = await transaction.query.workflowRuns.findFirst({
          where: and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.userId, userId)),
        });
        if (!workflow) return null;

        const taskRows = await transaction
          .select()
          .from(tasks)
          .where(eq(tasks.workflowRunId, workflow.id))
          .orderBy(asc(tasks.createdAt), asc(tasks.id));
        const latestAttempts = await this.latestAttempts(
          transaction,
          taskRows.map((task) => task.id),
        );
        const latestRetries = await this.latestRetries(
          transaction,
          userId,
          workflow.id,
          taskRows.map((task) => task.id),
        );
        const artifactRows =
          taskRows.length === 0
            ? []
            : await transaction
                .select({
                  id: artifacts.id,
                  taskId: artifacts.taskId,
                  type: artifacts.type,
                  visibility: artifacts.visibility,
                  publicationRevision: artifacts.publicationRevision,
                  metaJson: artifacts.metaJson,
                  createdAt: artifacts.createdAt,
                })
                .from(artifacts)
                .where(
                  and(
                    inArray(
                      artifacts.taskId,
                      taskRows.map((task) => task.id),
                    ),
                    inArray(artifacts.visibility, ['private', 'shared', 'public']),
                  ),
                )
                .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
        const [sequence] = await transaction
          .select({ lastEventSeq: max(eventOutbox.eventSeq) })
          .from(eventOutbox)
          .where(
            and(eq(eventOutbox.scopeType, 'workflow_run'), eq(eventOutbox.scopeId, workflow.id)),
          );

        return {
          workflow_run: {
            id: workflow.id,
            status: workflow.status,
            trigger_mode: workflow.triggerMode,
            created_at: workflow.createdAt.toISOString(),
            finished_at: iso(workflow.finishedAt),
          },
          tasks: taskRows.map((task) => {
            const attempt = latestAttempts.get(task.id);
            const retry = latestRetries.get(task.id);
            return {
              id: task.id,
              type: task.type,
              status: task.status,
              error_code: task.errorCode,
              output_count: publicImageOutputCount(task.type, task.paramsSnapshot),
              retryable: !retry && publicRetryableFailure(task, attempt),
              latest_retry: retry
                ? {
                    workflow_run_id: retry.workflowRunId,
                    task_id: retry.taskId,
                    status: retry.status,
                  }
                : null,
              created_at: task.createdAt.toISOString(),
              started_at: iso(task.startedAt),
              ended_at: iso(task.endedAt),
              latest_attempt: attempt
                ? { id: attempt.id, attempt_no: attempt.attempt_no, status: attempt.status }
                : null,
            };
          }),
          last_event_seq: Number(sequence?.lastEventSeq ?? 0),
          credit_summary: null,
          artifacts: artifactRows.map((artifact) => ({
            id: artifact.id,
            task_id: artifact.taskId,
            type: artifact.type,
            visibility: artifact.visibility,
            publication_revision: artifact.publicationRevision,
            output_index: publicImageOutputIndex(artifact.metaJson),
            created_at: artifact.createdAt.toISOString(),
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async listTasks(input: {
    userId: string;
    filters: TaskListFilters;
    cursor?: string;
    limit: number;
    now?: Date;
  }) {
    const position = input.cursor
      ? this.cursorCodec.decode(input.cursor, input.filters)
      : undefined;
    if (input.filters.source === 'batch') return { items: [], next_cursor: null };
    const cursorFilter = position ? this.cursorFilter(position) : undefined;
    const rows = await this.database
      .select({
        taskId: tasks.id,
        taskType: tasks.type,
        taskStatus: tasks.status,
        taskErrorCode: tasks.errorCode,
        taskCreatedAt: tasks.createdAt,
        taskStartedAt: tasks.startedAt,
        taskEndedAt: tasks.endedAt,
        workflowRunId: workflowRuns.id,
        workflowStatus: workflowRuns.status,
        triggerMode: workflowRuns.triggerMode,
        workflowCreatedAt: workflowRuns.createdAt,
        workflowFinishedAt: workflowRuns.finishedAt,
      })
      .from(tasks)
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(
        and(
          eq(workflowRuns.userId, input.userId),
          input.filters.status ? eq(tasks.status, input.filters.status) : undefined,
          input.filters.source ? eq(workflowRuns.triggerMode, input.filters.source) : undefined,
          input.filters.from ? gte(workflowRuns.createdAt, input.filters.from) : undefined,
          input.filters.to ? lte(workflowRuns.createdAt, input.filters.to) : undefined,
          cursorFilter,
        ),
      )
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id), desc(tasks.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const latestAttempts = await this.latestAttempts(
      this.database,
      page.map((row) => row.taskId),
    );
    const now = input.now ?? new Date();
    const last = page.at(-1);
    const hasNext = rows.length > input.limit && last;

    return {
      items: page.map((row) => ({
        task: {
          id: row.taskId,
          type: row.taskType,
          status: row.taskStatus,
          error_code: row.taskErrorCode,
          created_at: row.taskCreatedAt.toISOString(),
          started_at: iso(row.taskStartedAt),
          ended_at: iso(row.taskEndedAt),
        },
        workflow_run: {
          id: row.workflowRunId,
          status: row.workflowStatus,
          trigger_mode: row.triggerMode,
          created_at: row.workflowCreatedAt.toISOString(),
          finished_at: iso(row.workflowFinishedAt),
        },
        latest_attempt: latestAttempts.get(row.taskId) ?? null,
        duration_ms: durationMs(row.taskStartedAt, row.taskEndedAt, now),
      })),
      next_cursor: hasNext
        ? this.cursorCodec.encode(
            {
              workflowCreatedAt: last.workflowCreatedAt,
              workflowRunId: last.workflowRunId,
              taskId: last.taskId,
            },
            input.filters,
          )
        : null,
    };
  }

  private async latestAttempts(
    database: WorkflowReadContext,
    taskIds: string[],
  ): Promise<Map<string, LatestAttemptSummary>> {
    const result = new Map<string, LatestAttemptSummary>();
    if (taskIds.length === 0) return result;
    const rows = await database
      .select({
        taskId: taskAttempts.taskId,
        id: taskAttempts.id,
        attemptNo: taskAttempts.attemptNo,
        status: taskAttempts.status,
        dispatchState: taskAttempts.dispatchState,
      })
      .from(taskAttempts)
      .where(inArray(taskAttempts.taskId, taskIds))
      .orderBy(asc(taskAttempts.taskId), desc(taskAttempts.attemptNo));
    for (const row of rows) {
      if (!result.has(row.taskId)) {
        result.set(row.taskId, {
          id: row.id,
          attempt_no: row.attemptNo,
          status: row.status,
          dispatchState: row.dispatchState,
        });
      }
    }
    return result;
  }

  private async latestRetries(
    database: WorkflowReadContext,
    userId: string,
    sourceWorkflowRunId: string,
    parentTaskIds: string[],
  ): Promise<Map<string, LatestRetrySummary>> {
    const result = new Map<string, LatestRetrySummary>();
    if (parentTaskIds.length === 0) return result;
    const rows = await database
      .select({
        parentTaskId: tasks.parentTaskId,
        taskId: tasks.id,
        workflowRunId: tasks.workflowRunId,
        status: tasks.status,
      })
      .from(tasks)
      .innerJoin(workflowRuns, eq(workflowRuns.id, tasks.workflowRunId))
      .where(
        and(
          inArray(tasks.parentTaskId, parentTaskIds),
          inArray(tasks.type, ['image.generate', 'image.edit']),
          sql`${tasks.workflowRunId} <> ${sourceWorkflowRunId}`,
          eq(workflowRuns.userId, userId),
        ),
      )
      .orderBy(asc(tasks.parentTaskId), desc(tasks.createdAt), desc(tasks.id));
    for (const row of rows) {
      if (row.parentTaskId && !result.has(row.parentTaskId)) {
        result.set(row.parentTaskId, {
          parentTaskId: row.parentTaskId,
          taskId: row.taskId,
          workflowRunId: row.workflowRunId,
          status: row.status,
        });
      }
    }
    return result;
  }

  private cursorFilter(position: TaskCursorPosition) {
    return or(
      lt(workflowRuns.createdAt, position.workflowCreatedAt),
      and(
        eq(workflowRuns.createdAt, position.workflowCreatedAt),
        lt(workflowRuns.id, position.workflowRunId),
      ),
      and(
        eq(workflowRuns.createdAt, position.workflowCreatedAt),
        eq(workflowRuns.id, position.workflowRunId),
        lt(tasks.id, position.taskId),
      ),
    );
  }
}

function publicRetryableFailure(
  task: typeof tasks.$inferSelect,
  attempt: LatestAttemptSummary | undefined,
): boolean {
  return (
    ['image.generate', 'image.edit'].includes(task.type) &&
    ['failed', 'waiting_manual_review'].includes(task.status) &&
    publicImageOutputCount(task.type, task.paramsSnapshot) === 1 &&
    attempt !== undefined &&
    ((attempt.status === 'failed' && attempt.dispatchState !== 'outcome_unknown') ||
      (attempt.status === 'outcome_unknown' && attempt.dispatchState === 'outcome_unknown'))
  );
}

function publicImageOutputCount(taskType: string, paramsSnapshot: unknown): number | null {
  if (taskType !== 'image.generate' && taskType !== 'image.edit') return null;
  if (!paramsSnapshot || typeof paramsSnapshot !== 'object') return null;
  const value = (paramsSnapshot as Record<string, unknown>).output_count;
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 16
    ? Number(value)
    : null;
}

function publicImageOutputIndex(metaJson: unknown): number | null {
  if (!metaJson || typeof metaJson !== 'object') return null;
  const value = (metaJson as Record<string, unknown>).output_index;
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < 16 ? Number(value) : null;
}
