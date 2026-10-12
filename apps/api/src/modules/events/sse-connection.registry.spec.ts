import { describe, expect, it } from 'vitest';

import { SseConnectionLimitError, SseConnectionRegistry } from './sse-connection.registry.js';

describe('SseConnectionRegistry', () => {
  it('enforces and releases total and per-user limits idempotently', () => {
    const registry = new SseConnectionRegistry(2, 1);
    const release = registry.acquire('user-a');
    expect(() => registry.acquire('user-a')).toThrow(SseConnectionLimitError);
    const releaseOther = registry.acquire('user-b');
    expect(() => registry.acquire('user-c')).toThrow(SseConnectionLimitError);
    release();
    release();
    releaseOther();
    expect(registry.active()).toBe(0);
  });
});
