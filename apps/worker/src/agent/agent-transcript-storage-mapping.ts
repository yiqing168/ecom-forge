import {
  verifyAgentTranscriptItem,
  type AgentTranscriptItem,
  type AgentTranscriptItemContracts,
} from '@ecom-forge/agent';
import type { agentTranscriptItems } from '@ecom-forge/db';

export function verifyStoredTranscriptItem(
  row: typeof agentTranscriptItems.$inferSelect,
  scope: { user_id: string; session_id: string },
  contracts: AgentTranscriptItemContracts,
): AgentTranscriptItem {
  return verifyAgentTranscriptItem(
    {
      scope,
      record: {
        id: row.id,
        user_id: row.userId,
        session_id: row.sessionId,
        turn_id: row.turnId,
        continuation_no: row.continuationNo,
        sequence_no: row.sequenceNo.toString(),
        schema_version: row.schemaVersion,
        item_type: row.itemType,
        source_key: row.sourceKey,
        source_message_id: row.sourceMessageId,
        source_trace_step_id: row.sourceTraceStepId,
        import_attempt_id: row.importAttemptId,
        reply_to_item_id: row.replyToItemId,
        call_ordinal: row.callOrdinal,
        payload_json: row.payloadJson,
        payload_digest: row.payloadDigest,
        resource_dependencies_json: row.resourceDependenciesJson,
        created_at: row.createdAt.toISOString(),
      },
    },
    contracts,
  ).item;
}

export function transcriptItemValues(
  item: AgentTranscriptItem,
): typeof agentTranscriptItems.$inferInsert {
  return {
    id: item.id,
    userId: item.user_id,
    sessionId: item.session_id,
    turnId: item.turn_id,
    continuationNo: item.continuation_no,
    sequenceNo: BigInt(item.sequence_no),
    schemaVersion: item.schema_version,
    itemType: item.item_type,
    sourceKey: item.source_key,
    sourceMessageId: item.source_message_id,
    sourceTraceStepId: item.source_trace_step_id,
    importAttemptId: item.import_attempt_id,
    replyToItemId: item.reply_to_item_id,
    callOrdinal: item.call_ordinal,
    payloadJson: item.payload_json,
    payloadDigest: item.payload_digest,
    resourceDependenciesJson: item.resource_dependencies_json,
    createdAt: new Date(item.created_at),
  };
}
