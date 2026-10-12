import { agentTraceSteps, agentTurns, and, eq, max, sql } from '@ecom-forge/db';
import { scopedAdvisoryLockKey } from '@ecom-forge/shared';

import type {
  AgentWriteQuery,
  ClaimedAgentTurn,
  TraceStepInput,
  Transaction,
} from './agent-turn.types.js';

export function lockOwnedTurn(
  transaction: Transaction,
  claimed: ClaimedAgentTurn,
  revision: number,
) {
  return transaction
    .select()
    .from(agentTurns)
    .where(
      and(
        eq(agentTurns.id, claimed.turnId),
        eq(agentTurns.processingOwner, claimed.owner),
        eq(agentTurns.revision, revision),
        eq(agentTurns.continuationNo, claimed.continuationNo),
      ),
    )
    .for('update');
}

export async function appendTraceStep(
  transaction: Transaction,
  traceId: string,
  input: TraceStepInput,
): Promise<{ stepId: string; stepNo: number }> {
  return appendTraceStepWithQuery((build) => Promise.resolve(build(transaction)), traceId, input);
}

export async function appendTraceStepWithQuery(
  query: AgentWriteQuery,
  traceId: string,
  input: TraceStepInput,
): Promise<{ stepId: string; stepNo: number }> {
  await query((transaction) =>
    transaction.execute(
      sql`select pg_advisory_xact_lock(${scopedAdvisoryLockKey('agent-trace', traceId)})`,
    ),
  );
  const [current] = await query((transaction) =>
    transaction
      .select({ stepNo: max(agentTraceSteps.stepNo) })
      .from(agentTraceSteps)
      .where(eq(agentTraceSteps.traceId, traceId)),
  );
  const stepNo = Number(current?.stepNo ?? 0) + 1;
  const [created] = await query((transaction) =>
    transaction
      .insert(agentTraceSteps)
      .values({
        traceId,
        stepNo,
        stepType: input.stepType,
        actor: input.actor,
        skillId: input.skillId,
        toolName: input.toolName,
        callPositionKey: input.callPositionKey,
        toolFingerprint: input.toolFingerprint,
        argsHash: input.argsHash,
        inputSummary: input.inputSummary,
        outputSummary: input.outputSummary,
        status: input.status,
        errorCode: input.errorCode,
        tokenUsageJson: input.tokenUsageJson,
        modelSnapshotJson: input.modelSnapshotJson,
      })
      .returning({ stepId: agentTraceSteps.id }),
  );
  if (!created) throw new Error('Agent trace step insert returned no row');
  return { stepId: created.stepId, stepNo };
}

export function splitPublicText(value: string): string[] {
  const codePoints = [...value];
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += 1_000) {
    chunks.push(codePoints.slice(index, index + 1_000).join(''));
  }
  if (chunks.length > 64) throw new Error('AGENT_PUBLIC_TEXT_TOO_LARGE');
  return chunks;
}
