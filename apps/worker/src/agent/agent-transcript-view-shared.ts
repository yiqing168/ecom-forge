import { z } from 'zod';

import type { AuthorizedAgentTranscriptItem } from './agent-transcript.repository.js';

/** The strict shape of a `user_message` inline content value, shared by projection and summary. */
export const userContentSchema = z.strictObject({
  text: z.string(),
  attachments: z.array(z.record(z.string(), z.unknown())).max(9),
});

export function transcriptValue(
  value: { type: 'inline'; value: unknown } | { type: 'private_payload'; payload_id: string },
  item: AuthorizedAgentTranscriptItem,
): unknown {
  if (value.type === 'inline') return value.value;
  const payload = item.private_payloads.find(
    (candidate) => candidate.reference.payload_id === value.payload_id,
  );
  if (!payload) throw new Error('AGENT_TRANSCRIPT_PAYLOAD_UNAVAILABLE');
  return payload.value;
}
