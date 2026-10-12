import { z } from 'zod';

const MAX_EVENT_SEQUENCE = 2_147_483_647;
const scopeSchema = z.string().regex(/^(?:workflow_run|turn):[0-9a-f-]{36}$/i);

export type EventScopeType = 'workflow_run' | 'turn';

export interface EventStreamQuery {
  scope: `${EventScopeType}:${string}`;
  scopeType: EventScopeType;
  scopeId: string;
  lastEventSeq: number;
}

export function parseEventStreamQuery(requestUrl: string): EventStreamQuery {
  let search: URLSearchParams;
  try {
    search = new URL(requestUrl, 'http://api.internal').searchParams;
  } catch {
    throw new Error('Event stream query is invalid');
  }
  const keys = [...search.keys()];
  if (keys.some((key) => key !== 'scope' && key !== 'last_event_seq')) {
    throw new Error('Event stream query contains unknown fields');
  }
  if (search.getAll('scope').length !== 1 || search.getAll('last_event_seq').length > 1) {
    throw new Error('Event stream query contains duplicate fields');
  }
  const scope = search.get('scope');
  const parsedScope = scopeSchema.safeParse(scope);
  if (!parsedScope.success) throw new Error('Event stream scope is invalid');
  const separator = parsedScope.data.indexOf(':');
  const scopeType = parsedScope.data.slice(0, separator) as EventScopeType;
  const scopeId = parsedScope.data.slice(separator + 1);
  if (!z.uuid().safeParse(scopeId).success) {
    throw new Error('Event stream scope identifier is invalid');
  }
  const serializedSequence = search.get('last_event_seq') ?? '0';
  if (!/^(?:0|[1-9]\d*)$/.test(serializedSequence)) {
    throw new Error('Event stream sequence is invalid');
  }
  const lastEventSeq = Number(serializedSequence);
  if (!Number.isSafeInteger(lastEventSeq) || lastEventSeq > MAX_EVENT_SEQUENCE) {
    throw new Error('Event stream sequence is outside the supported range');
  }
  return {
    scope: `${scopeType}:${scopeId}`,
    scopeType,
    scopeId,
    lastEventSeq,
  };
}
