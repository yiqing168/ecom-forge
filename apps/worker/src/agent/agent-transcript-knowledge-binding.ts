import {
  callPositionKey,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import { agentTraces, agentTraceSteps, and, eq, type Database } from '@ecom-forge/db';
import { canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

import { verifyTranscriptKnowledgeResultSource } from './agent-transcript-tool-contracts.js';

export function prepareTranscriptKnowledgeResultBinding(
  item: AgentTranscriptItem,
  parent: AgentTranscriptItem,
  contracts: AgentTranscriptItemContracts,
) {
  if (!verifyTranscriptKnowledgeResultSource({ item, parent }, contracts))
    throw new Error('AGENT_TRANSCRIPT_TOOL_SOURCE_INVALID');
  return {
    schema_version: 1,
    assistant_item_id: parent.id,
    call_ordinal: item.call_ordinal,
    result_item_id: item.id,
    sequence_no: item.sequence_no,
    payload_digest: item.payload_digest,
    resource_dependencies_digest: canonicalSha256(item.resource_dependencies_json),
  };
}

export class AgentTranscriptKnowledgeBinding {
  constructor(
    private readonly database: Pick<Database, 'query'>,
    private readonly contracts: AgentTranscriptItemContracts,
  ) {}

  async verifySource({
    item,
    parent,
  }: {
    item: AgentTranscriptItem;
    parent: AgentTranscriptItem;
  }): Promise<boolean> {
    try {
      const expected = prepareTranscriptKnowledgeResultBinding(item, parent, this.contracts);
      const trace = await this.database.query.agentTraces.findFirst({
        where: and(
          eq(agentTraces.turnId, item.turn_id!),
          eq(agentTraces.userId, item.user_id),
          eq(agentTraces.sessionId, item.session_id),
        ),
      });
      if (!trace || item.payload_json.type !== 'tool_result') return false;
      const step = await this.database.query.agentTraceSteps.findFirst({
        where: and(
          eq(agentTraceSteps.id, item.source_trace_step_id!),
          eq(agentTraceSteps.traceId, trace.id),
        ),
      });
      const summary = z
        .object({ transcript_results: z.array(z.unknown()).min(1).max(4) })
        .safeParse(step?.outputSummary);
      if (
        !step ||
        !summary.success ||
        summary.data.transcript_results.filter(
          (entry) => canonicalSha256(entry) === canonicalSha256(expected),
        ).length !== 1
      )
        return false;
      if (step.stepType === 'guardrail')
        return item.payload_json.status !== 'succeeded' && step.status === 'blocked';
      if (step.stepType === 'observation') {
        const policy = z
          .object({ policy: z.literal('tool_batch_shape') })
          .safeParse(step.inputSummary);
        const rejection = z
          .object({
            outcome: z.literal('tool_batch_rejected'),
            call_count: z.int().positive(),
          })
          .safeParse(step.outputSummary);
        return (
          step.actor === 'system' &&
          step.status === 'failed' &&
          step.errorCode === 'AGENT_TOOL_NOT_ALLOWED' &&
          policy.success &&
          rejection.success &&
          parent.payload_json.type === 'assistant_output' &&
          rejection.data.call_count === parent.payload_json.calls.length &&
          (item.call_ordinal === 0
            ? item.payload_json.status === 'rejected'
            : item.payload_json.status === 'not_executed')
        );
      }
      if (step.stepType !== 'tool_call' || step.actor !== 'tool') return false;
      if (item.payload_json.status === 'not_executed') return step.status === 'failed';
      const model = await this.database.query.agentTraceSteps.findFirst({
        where: and(
          eq(agentTraceSteps.id, parent.source_trace_step_id!),
          eq(agentTraceSteps.traceId, trace.id),
        ),
      });
      return (
        !!model &&
        step.toolName === item.payload_json.name &&
        step.argsHash === item.payload_json.arguments_digest &&
        step.callPositionKey ===
          callPositionKey({
            turnId: item.turn_id!,
            continuationNo: parent.continuation_no!,
            llmStepNo: model.stepNo,
            callIndex: item.call_ordinal!,
          }) &&
        step.status === (item.payload_json.status === 'succeeded' ? 'succeeded' : 'failed')
      );
    } catch {
      return false;
    }
  }
}
