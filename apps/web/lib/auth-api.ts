type ApiErrorPayload = { error?: { code?: string; message?: string } };

export class AuthApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

const apiOrigin = (process.env.NEXT_PUBLIC_API_ORIGIN ?? '').replace(/\/$/, '');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  const payload = (await response.json().catch(() => null)) as (T & ApiErrorPayload) | null;
  if (!response.ok) {
    const error = payload?.error;
    throw new AuthApiError(
      error?.code ?? 'AUTH_REQUEST_FAILED',
      response.status,
      error?.message ?? '认证服务暂时无法响应，请稍后重试',
    );
  }
  return payload as T;
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export interface RegisterResponse {
  verification_ticket: string;
  email: string;
  expires_in_seconds: number;
  resend_cooldown_seconds: number;
}

export interface VerificationRequestResponse {
  verification_ticket: string;
  expires_in_seconds: number;
  resend_cooldown_seconds: number;
}

export interface AuthUserResponse {
  access: {
    can_create: boolean;
    can_upload: boolean;
    can_charge: boolean;
    restriction_reason: 'email_verification_required' | 'account_restricted' | null;
  };
  user: {
    id: string;
    email: string;
    display_name: string;
    email_verified: boolean;
  };
}

export interface CreditAccountResponse {
  balance: string;
  frozen: string;
  available: string;
  currency: 'credits';
  as_of: string;
}

export type CreditLedgerType =
  | 'grant'
  | 'reservation_freeze'
  | 'consume'
  | 'release'
  | 'appeal_refund'
  | 'manual_correction'
  | 'expiry';

export interface CreditLedgerItem {
  id: string;
  type: CreditLedgerType;
  amount: string;
  balance_after: string;
  frozen_after: string;
  reservation_id: string | null;
  workflow_run_id: string | null;
  created_at: string;
}

export interface CreditLedgerResponse {
  items: CreditLedgerItem[];
  next_cursor: string | null;
}

export function register(
  input: {
    email: string;
    password: string;
    inviteCode: string;
    displayName?: string;
    agreementVersion?: string;
  },
  requestIdempotencyKey = idempotencyKey('register'),
): Promise<RegisterResponse> {
  return request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Idempotency-Key': requestIdempotencyKey },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      display_name: input.displayName ?? '新用户',
      invite_code: input.inviteCode,
      agreement_version: input.agreementVersion ?? '2026-08-09',
    }),
  });
}

export function login(email: string, password: string): Promise<AuthUserResponse> {
  return request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function getCurrentUser(): Promise<AuthUserResponse> {
  return request('/api/v1/me');
}

export function getCreditAccount(): Promise<CreditAccountResponse> {
  return request('/api/v1/credits/account');
}

export function getCreditLedger(cursor?: string, limit = 20): Promise<CreditLedgerResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return request(`/api/v1/credits/ledger?${query.toString()}`);
}

export function requestEmailVerification(
  ticket: string,
  requestIdempotencyKey = idempotencyKey('verification-resend'),
): Promise<VerificationRequestResponse> {
  return request('/api/v1/auth/email-verification/request', {
    method: 'POST',
    headers: { 'Idempotency-Key': requestIdempotencyKey },
    body: JSON.stringify({ verification_ticket: ticket }),
  });
}

export function verifyEmail(ticket: string, code: string): Promise<AuthUserResponse> {
  return request('/api/v1/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ verification_ticket: ticket, code }),
  });
}

export function requestPasswordReset(email: string): Promise<{ status: 'accepted' }> {
  return request('/api/v1/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function confirmPasswordReset(
  email: string,
  code: string,
  newPassword: string,
): Promise<{ status: 'reset' }> {
  return request('/api/v1/auth/password-reset/confirm', {
    method: 'POST',
    body: JSON.stringify({ email, code, new_password: newPassword }),
  });
}
