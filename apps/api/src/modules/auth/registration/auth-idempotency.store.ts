import { randomUUID } from 'node:crypto';

import { AuthControlPlaneUnavailableError } from '../rate-limit/verification-rate-limiter.js';
import type { MailDispatchResult } from '../mail/mail.types.js';

const BEGIN_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if created then return ARGV[1] end
return redis.call('GET', KEYS[1])
`;

const TRANSITION_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local state = cjson.decode(existing)
if state.status ~= 'pending' or state.owner ~= ARGV[1] or state.requestHash ~= ARGV[2] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`;

const RELEASE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local state = cjson.decode(existing)
if state.status == 'pending' and state.owner == ARGV[1] and state.requestHash == ARGV[2] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface AuthIdempotencyEvalClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface RegistrationResendReplay {
  claimId: string;
  ticketHash: string;
  ticketNonce: string;
  ticketVersion: number;
}

export type AuthIdempotencyBegin =
  | { kind: 'acquired'; owner: string }
  | { kind: 'completed'; result: RegistrationResendReplay }
  | { kind: 'failed'; result: MailDispatchResult }
  | { kind: 'conflict' }
  | { kind: 'pending' };

type StoredIdempotency =
  | { status: 'pending'; owner: string; requestHash: string }
  | { status: 'completed'; requestHash: string; result: RegistrationResendReplay }
  | { status: 'failed'; requestHash: string; result: MailDispatchResult };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isResendReplay(value: unknown): value is RegistrationResendReplay {
  if (!value || typeof value !== 'object') return false;
  const replay = value as Partial<RegistrationResendReplay>;
  return (
    isNonEmptyString(replay.claimId) &&
    isNonEmptyString(replay.ticketHash) &&
    isNonEmptyString(replay.ticketNonce) &&
    Number.isInteger(replay.ticketVersion) &&
    Number(replay.ticketVersion) >= 1
  );
}

function isMailDispatchResult(value: unknown): value is MailDispatchResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<MailDispatchResult>;
  return (
    result.state !== undefined &&
    ['accepted', 'not_dispatched', 'outcome_unknown'].includes(result.state) &&
    (result.providerMessageId === undefined || typeof result.providerMessageId === 'string') &&
    (result.errorCode === undefined || typeof result.errorCode === 'string')
  );
}

export interface AuthIdempotencyStore {
  begin(key: string, requestHash: string, ttlSeconds: number): Promise<AuthIdempotencyBegin>;
  complete(
    key: string,
    requestHash: string,
    owner: string,
    result: RegistrationResendReplay,
    ttlSeconds: number,
  ): Promise<void>;
  fail(
    key: string,
    requestHash: string,
    owner: string,
    result: MailDispatchResult,
    ttlSeconds: number,
  ): Promise<void>;
  release(key: string, requestHash: string, owner: string): Promise<void>;
}

function parseStored(value: unknown): StoredIdempotency {
  if (typeof value !== 'string') throw new AuthControlPlaneUnavailableError();
  try {
    const parsed = JSON.parse(value) as Partial<StoredIdempotency>;
    if (!isNonEmptyString(parsed.requestHash)) throw new Error('missing request hash');
    if (parsed.status === 'pending' && isNonEmptyString(parsed.owner)) {
      return { status: 'pending', owner: parsed.owner, requestHash: parsed.requestHash };
    }
    if (parsed.status === 'completed' && isResendReplay(parsed.result)) {
      return { status: 'completed', requestHash: parsed.requestHash, result: parsed.result };
    }
    if (parsed.status === 'failed' && isMailDispatchResult(parsed.result)) {
      return { status: 'failed', requestHash: parsed.requestHash, result: parsed.result };
    }
  } catch {
    throw new AuthControlPlaneUnavailableError();
  }
  throw new AuthControlPlaneUnavailableError();
}

export class RedisAuthIdempotencyStore implements AuthIdempotencyStore {
  constructor(private readonly client: AuthIdempotencyEvalClient) {}

  async begin(key: string, requestHash: string, ttlSeconds: number): Promise<AuthIdempotencyBegin> {
    if (ttlSeconds < 1) throw new RangeError('Idempotency TTL must be positive');
    const owner = randomUUID();
    const pending: StoredIdempotency = { status: 'pending', owner, requestHash };
    let stored: StoredIdempotency;
    try {
      stored = parseStored(
        await this.client.eval(BEGIN_SCRIPT, {
          keys: [key],
          arguments: [JSON.stringify(pending), String(ttlSeconds)],
        }),
      );
    } catch (error) {
      if (error instanceof RangeError) throw error;
      throw new AuthControlPlaneUnavailableError();
    }
    if (stored.requestHash !== requestHash) return { kind: 'conflict' };
    if (stored.status === 'completed') return { kind: 'completed', result: stored.result };
    if (stored.status === 'failed') return { kind: 'failed', result: stored.result };
    return stored.owner === owner ? { kind: 'acquired', owner } : { kind: 'pending' };
  }

  async complete(
    key: string,
    requestHash: string,
    owner: string,
    result: RegistrationResendReplay,
    ttlSeconds: number,
  ): Promise<void> {
    await this.transition(
      key,
      requestHash,
      owner,
      { status: 'completed', requestHash, result },
      ttlSeconds,
    );
  }

  async fail(
    key: string,
    requestHash: string,
    owner: string,
    result: MailDispatchResult,
    ttlSeconds: number,
  ): Promise<void> {
    await this.transition(
      key,
      requestHash,
      owner,
      { status: 'failed', requestHash, result },
      ttlSeconds,
    );
  }

  async release(key: string, requestHash: string, owner: string): Promise<void> {
    try {
      await this.client.eval(RELEASE_SCRIPT, {
        keys: [key],
        arguments: [owner, requestHash],
      });
    } catch {
      throw new AuthControlPlaneUnavailableError();
    }
  }

  private async transition(
    key: string,
    requestHash: string,
    owner: string,
    state: Exclude<StoredIdempotency, { status: 'pending' }>,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const result = await this.client.eval(TRANSITION_SCRIPT, {
        keys: [key],
        arguments: [owner, requestHash, JSON.stringify(state), String(ttlSeconds)],
      });
      if (result !== 1) throw new AuthControlPlaneUnavailableError();
    } catch (error) {
      if (error instanceof AuthControlPlaneUnavailableError) throw error;
      throw new AuthControlPlaneUnavailableError();
    }
  }
}
