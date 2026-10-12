import { describe, expect, it } from 'vitest';

import { parseEventStreamQuery } from './event-query.js';

const scope = 'workflow_run:11111111-1111-4111-8111-111111111111';
const turnScope = 'turn:22222222-2222-4222-8222-222222222222';

describe('parseEventStreamQuery', () => {
  it('parses the only active scope and decimal cursor', () => {
    expect(parseEventStreamQuery(`/api/v1/events?scope=${scope}&last_event_seq=42`)).toEqual({
      scope,
      scopeType: 'workflow_run',
      scopeId: '11111111-1111-4111-8111-111111111111',
      lastEventSeq: 42,
    });
  });

  it('parses a turn scope without weakening UUID validation', () => {
    expect(parseEventStreamQuery(`/api/v1/events?scope=${turnScope}`)).toEqual({
      scope: turnScope,
      scopeType: 'turn',
      scopeId: '22222222-2222-4222-8222-222222222222',
      lastEventSeq: 0,
    });
  });

  it.each([
    `/api/v1/events?scope=${scope}&scope=${scope}`,
    `/api/v1/events?scope=${scope}&last_event_seq=-1`,
    `/api/v1/events?scope=${scope}&last_event_seq=1e3`,
    `/api/v1/events?scope=session:11111111-1111-4111-8111-111111111111`,
    `/api/v1/events?scope=turn:not-a-uuid`,
    `/api/v1/events?scope=${scope}&extra=1`,
  ])('rejects an ambiguous or unsupported query: %s', (requestUrl) => {
    expect(() => parseEventStreamQuery(requestUrl)).toThrow();
  });
});
