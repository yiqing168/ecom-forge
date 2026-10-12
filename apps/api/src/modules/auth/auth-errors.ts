export class AuthHttpError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = 'AuthHttpError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export class AuthOtpInvalidError extends Error {
  constructor() {
    super('The verification code is invalid or expired');
    this.name = 'AuthOtpInvalidError';
  }
}

export class AuthOtpAttemptsExceededError extends Error {
  constructor() {
    super('The verification code attempts are exhausted');
    this.name = 'AuthOtpAttemptsExceededError';
  }
}

export class VerificationTicketInvalidError extends Error {
  constructor() {
    super('The verification context is invalid');
    this.name = 'VerificationTicketInvalidError';
  }
}

export class AuthBadRequestError extends Error {
  constructor() {
    super('Invalid authentication request');
    this.name = 'AuthBadRequestError';
  }
}

export function classifyBetterAuthOtpError(error: unknown): Error {
  const candidate = error as { body?: { code?: string }; message?: string };
  const value = `${candidate.body?.code ?? ''} ${candidate.message ?? ''}`.toUpperCase();
  if (value.includes('TOO_MANY_ATTEMPTS')) {
    return new AuthOtpAttemptsExceededError();
  }
  return new AuthOtpInvalidError();
}
