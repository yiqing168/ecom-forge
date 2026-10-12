import type { EventWake } from '@ecom-forge/shared';

export class CreditError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      | 'INSUFFICIENT_CREDITS'
      | 'COST_MODEL_UNAVAILABLE'
      | 'PROVIDER_UNAVAILABLE'
      | 'COST_ACK_REQUIRED'
      | 'RUN_QUOTE_EXPIRED'
      | 'RESOURCE_BUSY'
      | 'AUTH_VERIFICATION_REQUIRED'
      | 'FORBIDDEN'
      | 'RESOURCE_NOT_FOUND'
      | 'CREDIT_ACCOUNT_UNAVAILABLE'
      | 'RESERVATION_STATE_INVALID'
      | 'SETTLEMENT_PROTECTED',
    readonly eventWakes: readonly EventWake[] = [],
  ) {
    super(message);
    this.name = 'CreditError';
  }
}

export class CreditProjectionDriftError extends Error {
  constructor() {
    super('Credit account projection does not match ledger replay');
    this.name = 'CreditProjectionDriftError';
  }
}
