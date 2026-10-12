const SERVICE_PREFIX = 'ecom-forge';

export function buildServiceName(service: string): string {
  const normalized = service.trim().toLowerCase();

  if (normalized.length === 0) {
    throw new Error('service must not be empty');
  }

  return `${SERVICE_PREFIX}-${normalized}`;
}

export {
  addMoney,
  compareMoney,
  divideMoney,
  grossMarginSatisfied,
  moneyEquals,
  multiplyMoney,
  normalizeMoney,
  subtractMoney,
} from './money.js';
export type { MoneyString } from './money.js';
export { advisoryLockKey, scopedAdvisoryLockKey } from './advisory-lock.js';
export {
  encodeEventWake,
  eventWakeChannel,
  NOOP_EVENT_WAKE_PUBLISHER,
  parseEventWake,
} from './event-wake.js';
export type { EventWake, EventWakePublisher } from './event-wake.js';
export {
  canonicalJson,
  canonicalSha256,
  hasAmbiguousCanonicalKeys,
  utf8Sha256,
} from './canonical-json.js';
export * from './creative-direction.js';
export * from './skill-execution.js';
export * from './agent-public-contract.js';
