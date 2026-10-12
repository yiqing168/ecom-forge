export const REGISTRATION_REWARD_CAMPAIGN_KEY = 'registration-default';

export const REGISTRATION_REWARD_MAX_CREDITS = '999999999.00';
export const REGISTRATION_REWARD_MAX_GRANTS = 10_000_000;

export const REGISTRATION_REWARD_ELIGIBILITY = {
  require_verified_email: true,
  require_normal_risk: true,
  deny_blocked_email: true,
  one_per_mailbox: true,
} as const;
