export interface RateLimitRule {
  max: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface VerificationRateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
  withExclusiveLock<T>(key: string, ttlSeconds: number, operation: () => Promise<T>): Promise<T>;
}

export function emailVerificationRateLimitSubject(value: string): string {
  return `email_verification\0${value}`;
}

export function registrationInviteRateLimitSubject(inviteCodeId: string): string {
  return `email_verification\0invite_code\0${inviteCodeId}`;
}

export class AuthControlPlaneUnavailableError extends Error {
  constructor() {
    super('Authentication control plane is unavailable');
    this.name = 'AuthControlPlaneUnavailableError';
  }
}

export class AuthExclusiveLockBusyError extends Error {
  constructor() {
    super('Authentication operation is already in progress');
    this.name = 'AuthExclusiveLockBusyError';
  }
}
