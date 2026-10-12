const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_SEQUENCE = 2_147_483_647;

export interface EventWake {
  schema_version: 1;
  scope_type: 'workflow_run' | 'turn';
  scope_id: string;
  event_seq: number;
}

export interface EventWakePublisher {
  publish(wake: EventWake): Promise<void>;
}

export const NOOP_EVENT_WAKE_PUBLISHER: EventWakePublisher = {
  publish: () => Promise.resolve(),
};

export function eventWakeChannel(redisPrefix: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(redisPrefix)) {
    throw new Error('Redis prefix is invalid');
  }
  return `${redisPrefix}:sse:wake:v1`;
}

export function encodeEventWake(wake: EventWake): string {
  assertEventWake(wake);
  return JSON.stringify(wake);
}

export function parseEventWake(serialized: string): EventWake {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Event wake payload is not valid JSON');
  }
  assertEventWake(value);
  return value;
}

function assertEventWake(value: unknown): asserts value is EventWake {
  if (!isRecord(value) || Object.keys(value).length !== 4) {
    throw new Error('Event wake payload shape is invalid');
  }
  if (
    value.schema_version !== 1 ||
    (value.scope_type !== 'workflow_run' && value.scope_type !== 'turn') ||
    typeof value.scope_id !== 'string' ||
    !UUID_PATTERN.test(value.scope_id) ||
    typeof value.event_seq !== 'number' ||
    !Number.isInteger(value.event_seq) ||
    value.event_seq < 1 ||
    value.event_seq > MAX_EVENT_SEQUENCE
  ) {
    throw new Error('Event wake payload values are invalid');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
