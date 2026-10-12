import {
  emailMatchesAllowlist,
  InvalidEmailError,
  isBlockedRegistrationEmail,
  normalizeEmail,
  normalizeEmailAllowlistEntry,
  rewardMailboxIdentity,
} from './email.js';

describe('email normalization', () => {
  it('normalizes Unicode domains in a deterministic order', () => {
    expect(normalizeEmail('  User@例子.公司  ')).toBe('user@xn--fsqu00a.xn--55qx5d');
    expect(normalizeEmail('ＵＳＥＲ@example.com')).toBe('user@example.com');
  });

  it('rejects malformed addresses before any registration side effect', () => {
    expect(() => normalizeEmail('not-an-email')).toThrow(InvalidEmailError);
    expect(() => normalizeEmail('a@@example.com')).toThrow(InvalidEmailError);
    expect(() => normalizeEmail('a@localhost')).toThrow(InvalidEmailError);
  });

  it('folds only public Gmail aliases for reward risk checks', () => {
    expect(rewardMailboxIdentity('first.last+beta@googlemail.com')).toBe('firstlast@gmail.com');
    expect(rewardMailboxIdentity('first.last+beta@example.com')).toBe(
      'first.last+beta@example.com',
    );
  });

  it('normalizes exact and domain invite allowlist entries', () => {
    expect(normalizeEmailAllowlistEntry(' USER@例子.公司 ')).toBe('user@xn--fsqu00a.xn--55qx5d');
    expect(normalizeEmailAllowlistEntry(' @例子.公司 ')).toBe('@xn--fsqu00a.xn--55qx5d');
    expect(emailMatchesAllowlist('other@xn--fsqu00a.xn--55qx5d', ['@xn--fsqu00a.xn--55qx5d'])).toBe(
      true,
    );
    expect(emailMatchesAllowlist('other@example.com', ['allowed@example.com'])).toBe(false);
  });

  it('blocks only domains in the versioned registration risk list', () => {
    expect(isBlockedRegistrationEmail('user@mailinator.com')).toBe(true);
    expect(isBlockedRegistrationEmail('user@example.com')).toBe(false);
  });
});
