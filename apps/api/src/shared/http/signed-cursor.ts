import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalSha256 } from '@ecom-forge/shared';
import { z } from 'zod';

const payloadSchema = z.strictObject({
  version: z.literal(1),
  user_id: z.uuid(),
  endpoint: z.string().min(1).max(64),
  filters_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export class SignedCursorError extends Error {
  constructor() {
    super('CURSOR_INVALID');
    this.name = 'SignedCursorError';
  }
}

export class SignedCursorCodec {
  constructor(private readonly secret: string) {}

  encode(input: {
    userId: string;
    endpoint: string;
    filters: unknown;
    position: CursorPosition;
  }): string {
    const body = Buffer.from(
      JSON.stringify({
        version: 1,
        user_id: input.userId,
        endpoint: input.endpoint,
        filters_hash: canonicalSha256(input.filters),
        created_at: input.position.createdAt.toISOString(),
        id: input.position.id,
      }),
      'utf8',
    ).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  decode(input: {
    cursor: string;
    userId: string;
    endpoint: string;
    filters: unknown;
  }): CursorPosition {
    try {
      const [body, suppliedText, extra] = input.cursor.split('.');
      if (!body || !suppliedText || extra !== undefined) throw new SignedCursorError();
      const expectedText = createHmac('sha256', this.secret).update(body).digest('base64url');
      const supplied = Buffer.from(suppliedText, 'utf8');
      const expected = Buffer.from(expectedText, 'utf8');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new SignedCursorError();
      }
      const payload = payloadSchema.parse(
        JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
      );
      if (
        payload.user_id !== input.userId ||
        payload.endpoint !== input.endpoint ||
        payload.filters_hash !== canonicalSha256(input.filters)
      ) {
        throw new SignedCursorError();
      }
      return { createdAt: new Date(payload.created_at), id: payload.id };
    } catch (error) {
      if (error instanceof SignedCursorError) throw error;
      throw new SignedCursorError();
    }
  }
}
