import { describe, expect, it } from 'vitest';

import { SignedCursorCodec, SignedCursorError } from './signed-cursor.js';

const codec = new SignedCursorCodec(Buffer.alloc(32, 4).toString('base64url'));
const input = {
  userId: '00000000-0000-4000-8000-000000000001',
  endpoint: 'assets',
  filters: { status: 'ready' },
  position: {
    createdAt: new Date('2026-08-13T00:00:00Z'),
    id: '00000000-0000-4000-8000-000000000002',
  },
};

describe('SignedCursorCodec', () => {
  it('round trips a cursor bound to actor, endpoint and filters', () => {
    const cursor = codec.encode(input);
    expect(codec.decode({ cursor, ...input })).toEqual(input.position);
  });

  it('rejects tampering and cross-filter reuse', () => {
    const cursor = codec.encode(input);
    expect(() => codec.decode({ cursor: `${cursor}x`, ...input })).toThrow(SignedCursorError);
    expect(() => codec.decode({ cursor, ...input, filters: { status: 'processing' } })).toThrow(
      SignedCursorError,
    );
  });
});
