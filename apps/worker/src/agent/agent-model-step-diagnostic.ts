import { agentTraceSteps, agentTraces, and, eq, inArray, sql } from '@ecom-forge/db';

import type { ClaimedAgentTurn, Transaction } from './agent-turn.types.js';

type DiagnosticUpdate = {
  outputSummary: Record<string, unknown>;
  status?: 'failed' | 'blocked';
  errorCode?: string;
};

/** Downstream outcomes cannot replace the accepted model's semantic provenance. */
export async function recordModelStepDiagnostic(
  transaction: Transaction,
  input: {
    claimed: ClaimedAgentTurn;
    llmStepId: string;
    transcriptCaptureVersion: number | null;
    update: DiagnosticUpdate;
  },
): Promise<void> {
  const ownedTrace = transaction
    .select({ id: agentTraces.id })
    .from(agentTraces)
    .where(
      and(
        eq(agentTraces.id, input.claimed.traceId),
        eq(agentTraces.turnId, input.claimed.turnId),
        eq(agentTraces.sessionId, input.claimed.sessionId),
        eq(agentTraces.userId, input.claimed.userId),
      ),
    );
  if (input.transcriptCaptureVersion !== 1)
    throw new Error('AGENT_TRANSCRIPT_CAPTURE_VERSION_INVALID');
  const updated = await transaction
    .update(agentTraceSteps)
    .set({
      outputSummary: sql`${agentTraceSteps.outputSummary} || ${JSON.stringify({
        downstream: {
          ...input.update.outputSummary,
          ...(input.update.status ? { status: input.update.status } : {}),
          ...(input.update.errorCode ? { public_error_code: input.update.errorCode } : {}),
        },
      })}::jsonb`,
    })
    .where(
      and(
        eq(agentTraceSteps.id, input.llmStepId),
        inArray(agentTraceSteps.traceId, ownedTrace),
        eq(agentTraceSteps.stepType, 'llm_call'),
        eq(agentTraceSteps.actor, 'agent'),
      ),
    )
    .returning({ id: agentTraceSteps.id });
  if (updated.length !== 1) throw new Error('AGENT_MODEL_STEP_SOURCE_INVALID');
}
