import { describe, expect, it } from 'vitest';

import { TaskCursorCodec } from './task-cursor.js';

const position = {
  workflowCreatedAt: new Date('2026-08-10T01:02:03.000Z'),
  workflowRunId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
};

describe('TaskCursorCodec', () => {
  it('round-trips a signed cursor', () => {
    const codec = new TaskCursorCodec('cursor-test-secret');
    const filters = { status: 'running' as const, source: 'chat' as const };

    expect(codec.decode(codec.encode(position, filters), filters)).toEqual(position);
  });

  it('rejects a cursor reused with different filters', () => {
    const codec = new TaskCursorCodec('cursor-test-secret');
    const cursor = codec.encode(position, { status: 'running' });

    expect(() => codec.decode(cursor, { status: 'failed' })).toThrow('Task cursor is invalid');
  });

  it('rejects a tampered cursor', () => {
    const codec = new TaskCursorCodec('cursor-test-secret');
    const cursor = codec.encode(position, {});

    expect(() => codec.decode(`${cursor}x`, {})).toThrow('Task cursor is invalid');
  });

  it('normalizes malformed payloads to the public invalid-cursor error', () => {
    const codec = new TaskCursorCodec('cursor-test-secret');

    expect(() => codec.decode('not-a-cursor', {})).toThrow('Task cursor is invalid');
  });
});
