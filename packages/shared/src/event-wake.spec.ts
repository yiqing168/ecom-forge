import { describe, expect, it } from 'vitest';

import { encodeEventWake, eventWakeChannel, parseEventWake } from './event-wake.js';

const wake = {
  schema_version: 1 as const,
  scope_type: 'workflow_run' as const,
  scope_id: '11111111-1111-4111-8111-111111111111',
  event_seq: 42,
};

describe('event wake protocol', () => {
  it('round trips the routing-only payload', () => {
    expect(parseEventWake(encodeEventWake(wake))).toEqual(wake);
    expect(parseEventWake(encodeEventWake({ ...wake, scope_type: 'turn' }))).toEqual({
      ...wake,
      scope_type: 'turn',
    });
    expect(eventWakeChannel('ecom-forge_test')).toBe('ecom-forge_test:sse:wake:v1');
  });

  it('rejects unknown fields and unsafe values', () => {
    expect(() => parseEventWake(JSON.stringify({ ...wake, user_id: wake.scope_id }))).toThrow();
    expect(() => parseEventWake(JSON.stringify({ ...wake, event_seq: 0 }))).toThrow();
    expect(() => parseEventWake('{bad')).toThrow();
    expect(() => eventWakeChannel('bad:prefix')).toThrow();
  });
});
