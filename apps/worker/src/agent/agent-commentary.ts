import { chatMessages } from '@ecom-forge/db';
import type { AgentTranscriptItem } from '@ecom-forge/agent';

import { appendOutboxEventWithQuery } from '../database/outbox.repository.js';
import { splitPublicText } from './agent-turn.repository-helpers.js';
import type { AgentTranscriptWriteScope } from './agent-transcript-write-transaction.js';

/** Called only within the first successful settlement of a validated model output. */
export async function publishCommentaryInScope(
  scope: AgentTranscriptWriteScope,
  item: AgentTranscriptItem,
  traceId: string,
): Promise<number> {
  const payload = item.payload_json;
  if (payload.type !== 'assistant_output' || payload.mode !== 'tools' || !payload.commentary) {
    throw new Error('AGENT_COMMENTARY_SOURCE_INVALID');
  }
  const text = payload.commentary;
  await scope.query((tx) =>
    tx.insert(chatMessages).values({
      id: item.id,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      role: 'assistant',
      content: text,
      attachments: [],
    }),
  );
  const chunks = splitPublicText(text);
  let eventSeq = 0;
  for (const [index, text] of chunks.entries()) {
    const event = await appendOutboxEventWithQuery(scope.query, {
      scopeType: 'turn',
      scopeId: scope.turnId,
      eventType: 'turn.message_delta',
      payload: {
        turn_id: scope.turnId,
        agent_trace_id: traceId,
        message_id: item.id,
        delta_seq: index + 1,
        text_delta: text,
        is_final: index === chunks.length - 1,
      },
    });
    eventSeq = event.eventSeq;
  }
  return eventSeq;
}
