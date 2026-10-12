import {
  SignedCursorError,
  type CursorPosition,
  type SignedCursorCodec,
} from '../../shared/http/signed-cursor.js';
import { adminAuthError } from './admin-errors.js';
import type { AdminSessionContext } from './admin-http.js';

export function normalizedListFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined && value !== '')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function decodeAdminListCursor(input: {
  codec: SignedCursorCodec;
  context: AdminSessionContext;
  cursor?: string | undefined;
  endpoint: string;
  filters: Record<string, unknown>;
}): CursorPosition | undefined {
  if (!input.cursor) return undefined;
  try {
    return input.codec.decode({
      cursor: input.cursor,
      userId: input.context.principalId,
      endpoint: input.endpoint,
      filters: normalizedListFilters(input.filters),
    });
  } catch (error) {
    if (error instanceof SignedCursorError) adminAuthError('ADMIN_CURSOR_INVALID', 400);
    throw error;
  }
}

export function encodeAdminListCursor(input: {
  codec: SignedCursorCodec;
  context: AdminSessionContext;
  endpoint: string;
  filters: Record<string, unknown>;
  position: CursorPosition;
}): string {
  return input.codec.encode({
    userId: input.context.principalId,
    endpoint: input.endpoint,
    filters: normalizedListFilters(input.filters),
    position: input.position,
  });
}

export function normalizedTextFilter(value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC').trim();
  return normalized || undefined;
}
