import type { AgentTranscriptItem } from '@ecom-forge/agent';
import {
  agentTurns,
  agentTraces,
  agentTraceSteps,
  and,
  desc,
  eq,
  lt,
  or,
  type Database,
} from '@ecom-forge/db';
import { canonicalJson } from '@ecom-forge/shared';
import { z } from 'zod';

/**
 * Cross-turn continuity: how the **previous attempt** in this session ended.
 *
 * The product requirement is that after a failed turn a user may simply say "继续/重新生成" and
 * expect the original request to be carried forward — which the model can only honour if it can
 * see that the previous attempt did not produce a result, and why.
 *
 * Design constraints (all deliberate, all load-bearing):
 *
 * 1. **Only server-controlled identifiers.** No summary, no provider text, no free text — `docs/08`
 *    forbids persisting model/user prose into the transcript. `stop_reason` is a bounded enum-like
 *    code, never a message.
 * 2. **Only durable, immutable-after-terminal sources.** Content is a pure function of
 *    `agent_turns.status` (+ `agent_traces.loop_guardrail_hit`, + the last failed step's
 *    `error_code`). The read path re-derives it and compares, so a source that can be purged or
 *    mutated later would turn every future read of this item into an integrity failure — which is
 *    precisely the class of defect this module must not reintroduce. **Never** derive from
 *    `event_outbox` (a delivery log) or from anything a later turn can overwrite.
 * 3. **No prose inside the verified payload.** A `z.literal` instruction string would make every
 *    stored item unverifiable the day someone rewords it (bricking the session). The context
 *    *name* carries the semantics instead, and the `@1` suffix versions the derivation algorithm:
 *    changing that algorithm requires a new name plus keeping this verifier for `@1` items.
 */

export const PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME = 'previous_attempt_failure@1';

/** `AGENT_MODEL_UNAVAILABLE`-style codes and the lowercase `charge_blocked`-style codes. */
const controlledCodeSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{2,63}$/);

export const previousAttemptFailureContextSchema = z.strictObject({
  turn_id: z.uuid(),
  user_status: z.enum(['blocked', 'failed']),
  /** `loop_guardrail_hit`, else the last failed step's `error_code`; `null` when unrecorded. */
  stop_reason: controlledCodeSchema.nullable(),
});

export type PreviousAttemptFailureContext = z.infer<typeof previousAttemptFailureContextSchema>;

export interface PreviousAttemptScope {
  userId: string;
  sessionId: string;
  turnId: string;
}

export function previousAttemptFailureSourceKey(turnId: string): string {
  return `previous-attempt-failure:${turnId}`;
}

function controlledCode(value: unknown): string | null {
  return typeof value === 'string' && controlledCodeSchema.safeParse(value).success ? value : null;
}

/**
 * Returns `null` when the previous attempt has nothing the model could act on (it did not fail at
 * all). Never guesses a reason from free text.
 */
export function preparePreviousAttemptFailure(input: {
  turnId: string;
  status: string;
  stopReason: unknown;
}): PreviousAttemptFailureContext | null {
  if (input.status !== 'blocked' && input.status !== 'failed') return null;
  return previousAttemptFailureContextSchema.parse({
    turn_id: input.turnId,
    user_status: input.status,
    stop_reason: controlledCode(input.stopReason),
  });
}

/**
 * The turn immediately before `scope.turnId` in the same session, anchored on the current turn's
 * `(created_at, id)` so the answer stays stable when later turns are appended.
 */
async function readPreviousTurn(
  database: Pick<Database, 'query'>,
  scope: PreviousAttemptScope,
): Promise<{ id: string; status: string } | null> {
  const current = await database.query.agentTurns.findFirst({
    where: and(
      eq(agentTurns.id, scope.turnId),
      eq(agentTurns.sessionId, scope.sessionId),
      eq(agentTurns.userId, scope.userId),
    ),
    columns: { createdAt: true },
  });
  if (!current) return null;
  const previous = await database.query.agentTurns.findFirst({
    where: and(
      eq(agentTurns.sessionId, scope.sessionId),
      eq(agentTurns.userId, scope.userId),
      or(
        lt(agentTurns.createdAt, current.createdAt),
        and(eq(agentTurns.createdAt, current.createdAt), lt(agentTurns.id, scope.turnId)),
      ),
    ),
    orderBy: [desc(agentTurns.createdAt), desc(agentTurns.id)],
    columns: { id: true, status: true },
  });
  return previous ?? null;
}

/** Bounded scan: the newest failed steps are the ones that explain the terminal state. */
const FAILED_STEP_SCAN_LIMIT = 8;

/**
 * Re-derives the context from durable rows only. Write path and read-verification path both call
 * this function, so the stored content and the verification share one definition by construction.
 */
export async function derivePreviousAttemptFailure(
  database: Pick<Database, 'query'>,
  scope: PreviousAttemptScope,
): Promise<PreviousAttemptFailureContext | null> {
  const previous = await readPreviousTurn(database, scope);
  if (!previous) return null;
  let stopReason: string | null = null;
  const trace = await database.query.agentTraces.findFirst({
    where: and(
      eq(agentTraces.turnId, previous.id),
      eq(agentTraces.userId, scope.userId),
      eq(agentTraces.sessionId, scope.sessionId),
    ),
    columns: { id: true, loopGuardrailHit: true },
  });
  if (trace) {
    stopReason = controlledCode(trace.loopGuardrailHit);
    if (stopReason === null) {
      const failed = await database.query.agentTraceSteps.findMany({
        where: and(eq(agentTraceSteps.traceId, trace.id), eq(agentTraceSteps.status, 'failed')),
        orderBy: [desc(agentTraceSteps.stepNo)],
        limit: FAILED_STEP_SCAN_LIMIT,
        columns: { errorCode: true },
      });
      for (const step of failed) {
        const code = controlledCode(step.errorCode);
        if (code !== null) {
          stopReason = code;
          break;
        }
      }
    }
  }
  return preparePreviousAttemptFailure({
    turnId: previous.id,
    status: previous.status,
    stopReason,
  });
}

/**
 * Source proof for `previous_attempt_failure@1`. The read path **must** dispatch here by name —
 * `createNativeTranscriptReader` previously routed every unrecognised host context to the
 * `runtime_policy@1` verifier, which rejects them and would fail the whole read.
 */
export class AgentTranscriptPreviousAttemptFailureBinding {
  constructor(private readonly database: Pick<Database, 'query'>) {}

  async verifySource(item: AgentTranscriptItem): Promise<boolean> {
    try {
      const payload = item.payload_json;
      const { turn_id: turnId, user_id: userId, session_id: sessionId } = item;
      if (
        item.item_type !== 'host_context' ||
        payload.type !== 'host_context' ||
        payload.name !== PREVIOUS_ATTEMPT_FAILURE_CONTEXT_NAME ||
        payload.content.type !== 'inline' ||
        !turnId ||
        item.continuation_no !== 1 ||
        item.source_key !== previousAttemptFailureSourceKey(turnId) ||
        item.source_message_id !== null ||
        item.source_trace_step_id !== null ||
        item.import_attempt_id !== null ||
        item.reply_to_item_id !== null ||
        item.call_ordinal !== null ||
        item.resource_dependencies_json.length !== 0
      )
        return false;
      const content = previousAttemptFailureContextSchema.parse(payload.content.value);
      if (canonicalJson(content) !== canonicalJson(payload.content.value)) return false;
      const expected = await derivePreviousAttemptFailure(this.database, {
        userId,
        sessionId,
        turnId,
      });
      return expected !== null && canonicalJson(expected) === canonicalJson(content);
    } catch {
      return false;
    }
  }
}
