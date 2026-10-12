import {
  agentBrainTranscriptMessageSchema,
  agentTranscriptWireCallId,
  type AgentBrainTranscriptMessage,
} from '@ecom-forge/agent';
import { z } from 'zod';

import type { AuthorizedAgentTranscriptItem } from './agent-transcript.repository.js';

import { transcriptValue, userContentSchema } from './agent-transcript-view-shared.js';
export { transcriptValue, userContentSchema };

function itemMessage(
  authorized: AuthorizedAgentTranscriptItem,
  currentUserMessageId: string,
): AgentBrainTranscriptMessage {
  const item = authorized.item;
  const payload = item.payload_json;
  if (payload.type === 'user_message') {
    const content = userContentSchema.parse(payload.content.value);
    return agentBrainTranscriptMessageSchema.parse({
      type: 'user_message',
      item_id: item.id,
      current: item.source_message_id === currentUserMessageId,
      content: content.text,
      attachments: content.attachments,
    });
  }
  if (payload.type === 'assistant_output') {
    if (payload.mode === 'text') {
      return agentBrainTranscriptMessageSchema.parse({
        type: 'assistant_text',
        item_id: item.id,
        text: payload.text,
      });
    }
    return agentBrainTranscriptMessageSchema.parse({
      type: 'assistant_output',
      item_id: item.id,
      ...(payload.commentary ? { commentary: payload.commentary } : {}),
      calls: payload.calls.map((call, callOrdinal) => ({
        call_id: agentTranscriptWireCallId({
          assistant_item_id: item.id,
          call_ordinal: callOrdinal,
        }),
        name: call.name,
        ...(call.provider_metadata ? { provider_metadata: call.provider_metadata } : {}),
        arguments: z
          .record(z.string(), z.unknown())
          .parse(transcriptValue(call.arguments, authorized)),
      })),
    });
  }
  if (payload.type === 'tool_result') {
    if (!item.reply_to_item_id || item.call_ordinal === null) {
      throw new Error('AGENT_TRANSCRIPT_TOOL_PAIR_MISSING');
    }
    return agentBrainTranscriptMessageSchema.parse({
      type: 'tool_result',
      item_id: item.id,
      call_id: agentTranscriptWireCallId({
        assistant_item_id: item.reply_to_item_id,
        call_ordinal: item.call_ordinal,
      }),
      name: payload.name,
      status: payload.status,
      result: authorized.resource_contents?.length
        ? {
            ...z.record(z.string(), z.unknown()).parse(transcriptValue(payload.result, authorized)),
            resource_contents: authorized.resource_contents,
          }
        : transcriptValue(payload.result, authorized),
    });
  }
  if (payload.type === 'host_context') {
    return agentBrainTranscriptMessageSchema.parse({
      type: 'host_context',
      item_id: item.id,
      name: payload.name,
      content: transcriptValue(payload.content, authorized),
    });
  }
  throw new Error('AGENT_TRANSCRIPT_ITEM_NOT_MODEL_VISIBLE');
}

/**
 * Convert the owned, already-authorized transcript into the provider-neutral
 * history contract. This function is intentionally a pure projection: it
 * never reads the database, executes tools, or changes source order.
 */
export function projectNativeTranscriptMessages(
  items: readonly AuthorizedAgentTranscriptItem[],
  currentUserMessageId: string,
): AgentBrainTranscriptMessage[] {
  const messages = items.map((item) => itemMessage(item, currentUserMessageId));
  const current = messages.filter((message) => message.type === 'user_message' && message.current);
  if (current.length !== 1) throw new Error('AGENT_TRANSCRIPT_CURRENT_MESSAGE_INVALID');
  return messages;
}
