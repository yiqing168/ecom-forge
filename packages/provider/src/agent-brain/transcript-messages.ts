import {
  AgentBrainCallError,
  agentBrainTranscriptMessageSchema,
  type AgentBrainStepInput,
} from '@ecom-forge/agent';
import type { ModelMessage } from 'ai';
import { z } from 'zod';

const wireNames = new Map(
  [
    'load_skill',
    'inspect_image',
    'agent_respond',
    'agent_request_clarification',
    'agent_request_product_facts',
    'agent_candidate_plan',
    'agent_author_prompts',
  ].map((name) => [`${name}@1`, name]),
);

function wireName(name: string): string {
  const wire = wireNames.get(name);
  if (!wire) invalid();
  return wire;
}

function invalid(): never {
  throw new AgentBrainCallError('AGENT_BRAIN_TRANSCRIPT_INVALID', 'not_dispatched');
}

export function nativeTranscriptMessages(
  input: AgentBrainStepInput,
  currentMessage: ModelMessage,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  const seen = new Set<string>();
  const seenItems = new Set<string>();
  let currentCount = 0;
  let batch:
    | {
        calls: Array<{ id: string; name: string }>;
        results: Map<string, ModelMessage>;
        deferred: ModelMessage[];
      }
    | undefined;
  const append = (message: ModelMessage) => {
    if (batch) batch.deferred.push(message);
    else messages.push(message);
  };
  // Standalone model probes do not have a persisted session transcript. They may omit the field,
  // but an explicitly supplied empty transcript remains invalid and cannot bypass history checks.
  const transcriptItems =
    input.transcript_messages === undefined
      ? [
          {
            type: 'user_message' as const,
            item_id: '00000000-0000-4000-8000-000000000001',
            current: true,
            content: input.current_message,
            attachments: [],
          },
        ]
      : input.transcript_messages;
  for (const raw of transcriptItems) {
    const parsed = agentBrainTranscriptMessageSchema.safeParse(raw);
    if (!parsed.success) invalid();
    const item = parsed.data;
    if (seenItems.has(item.item_id)) invalid();
    seenItems.add(item.item_id);
    if (item.type === 'user_message') {
      if (item.current) {
        currentCount += 1;
        if (item.content !== input.current_message) invalid();
        append(currentMessage);
      } else append({ role: 'user', content: item.content });
    } else if (item.type === 'host_context') {
      // Escape `<`/`>` inside the serialized payload so user-provided text (e.g. a clarification
      // answer) can never forge a closing `</host_context>` tag for the model.
      const serialized = JSON.stringify(item.content)
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e');
      append({
        role: 'user',
        content: `<host_context name="${item.name}">${serialized}</host_context>`,
      });
    } else if (item.type === 'assistant_text') {
      if (batch) invalid();
      append({ role: 'assistant', content: item.text });
    } else if (item.type === 'assistant_output') {
      if (batch) invalid();
      for (const call of item.calls) {
        if (seen.has(call.call_id)) invalid();
        seen.add(call.call_id);
      }
      messages.push({
        role: 'assistant',
        content: [
          ...(item.commentary ? [{ type: 'text' as const, text: item.commentary }] : []),
          ...item.calls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.call_id,
            toolName: wireName(call.name),
            input: call.name === 'agent_candidate_plan@1' ? call.arguments.plan : call.arguments,
            ...(call.provider_metadata ? { providerOptions: call.provider_metadata } : {}),
          })),
        ],
      });
      batch = {
        calls: item.calls.map((call) => ({ id: call.call_id, name: call.name })),
        results: new Map(),
        deferred: [],
      };
    } else {
      if (
        !batch ||
        !batch.calls.some((call) => call.id === item.call_id && call.name === item.name) ||
        batch.results.has(item.call_id)
      )
        invalid();
      const result = z.json().safeParse(item.result);
      if (!result.success) invalid();
      batch.results.set(item.call_id, {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: item.call_id,
            toolName: wireName(item.name),
            output:
              item.status === 'succeeded'
                ? { type: 'json', value: result.data }
                : { type: 'error-text', value: JSON.stringify(result.data) },
          },
        ],
      });
      // Wire protocols require the complete result batch immediately after its calls.
      if (batch.results.size === batch.calls.length) {
        messages.push(
          ...batch.calls.map((call) => batch!.results.get(call.id)!),
          ...batch.deferred,
        );
        batch = undefined;
      }
    }
  }
  if (batch || currentCount !== 1) invalid();
  return messages;
}
