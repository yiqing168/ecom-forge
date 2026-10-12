import { domainToASCII } from 'node:url';

const LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export class InvalidEmailError extends Error {
  constructor() {
    super('Invalid email address');
    this.name = 'InvalidEmailError';
  }
}

export function normalizeEmail(input: string): string {
  const normalized = input.trim().normalize('NFKC');
  const separator = normalized.lastIndexOf('@');
  if (
    separator <= 0 ||
    separator === normalized.length - 1 ||
    normalized.indexOf('@') !== separator
  ) {
    throw new InvalidEmailError();
  }

  const local = normalized.slice(0, separator).toLowerCase();
  const asciiDomain = domainToASCII(normalized.slice(separator + 1).toLowerCase());
  if (
    !LOCAL_PART_PATTERN.test(local) ||
    local.length > 64 ||
    !DOMAIN_PATTERN.test(asciiDomain) ||
    asciiDomain.length > 255
  ) {
    throw new InvalidEmailError();
  }

  const email = `${local}@${asciiDomain}`;
  if (email.length > 320) {
    throw new InvalidEmailError();
  }
  return email;
}

export function normalizeEmailDomain(input: string): string {
  const normalized = input.trim().normalize('NFKC').replace(/^@/, '').toLowerCase();
  const asciiDomain = domainToASCII(normalized);
  if (!DOMAIN_PATTERN.test(asciiDomain) || asciiDomain.length > 255) {
    throw new InvalidEmailError();
  }
  return asciiDomain;
}

export function normalizeEmailAllowlistEntry(input: string): string {
  const normalized = input.trim().normalize('NFKC');
  return normalized.startsWith('@')
    ? `@${normalizeEmailDomain(normalized)}`
    : normalizeEmail(normalized);
}

export function emailMatchesAllowlist(email: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return allowlist.some(
    (entry) => entry === email || (entry.startsWith('@') && entry.slice(1) === domain),
  );
}

export const EMAIL_RISK_RULES_VERSION = 'disposable-relay-v1';

const BLOCKED_REGISTRATION_DOMAINS = new Set([
  '10minutemail.com',
  'guerrillamail.com',
  'mailinator.com',
  'temp-mail.org',
]);

export function isBlockedRegistrationEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return BLOCKED_REGISTRATION_DOMAINS.has(domain);
}

export function rewardMailboxIdentity(normalizedEmail: string): string {
  const [local, domain] = normalizedEmail.split('@');
  if (!local || !domain) {
    throw new InvalidEmailError();
  }
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') {
    return normalizedEmail;
  }
  const untagged = local.split('+', 1)[0]?.replaceAll('.', '');
  if (!untagged) {
    throw new InvalidEmailError();
  }
  return `${untagged}@gmail.com`;
}
