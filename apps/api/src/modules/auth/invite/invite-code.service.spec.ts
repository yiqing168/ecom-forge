import { HmacKeyring } from '../security/hmac-keyring.js';
import {
  InviteCodeService,
  type InviteCodeStore,
  type PersistInviteInput,
} from './invite-code.service.js';

const secret = Buffer.alloc(32, 3).toString('base64url');

describe('InviteCodeService', () => {
  it('persists only a digest, key id and non-sensitive prefix', async () => {
    let persisted: PersistInviteInput | undefined;
    const store: InviteCodeStore = {
      create(input) {
        persisted = input;
        return Promise.resolve({ id: 'd2661a9f-4618-4f0e-893f-47796de9c72f' });
      },
    };
    const service = new InviteCodeService(store, new HmacKeyring(`invite-v1:${secret}`));

    const result = await service.createInvite({
      maxUses: 10,
      emailAllowlist: [' USER@例子.公司 ', 'user@xn--fsqu00a.xn--55qx5d', '@例子.公司'],
      expiresAt: new Date(Date.now() + 60_000),
      issuedBy: null,
    });

    expect(Buffer.from(result.plaintextCode, 'base64url')).toHaveLength(18);
    expect(persisted).toMatchObject({
      keyId: 'invite-v1',
      codePrefix: result.plaintextCode.slice(0, 6),
      maxUses: 10,
      emailAllowlist: ['user@xn--fsqu00a.xn--55qx5d', '@xn--fsqu00a.xn--55qx5d'],
    });
    expect(JSON.stringify(persisted)).not.toContain(result.plaintextCode);
  });

  it('rejects invalid capacity before writing', async () => {
    const create = vi.fn();
    const service = new InviteCodeService({ create }, new HmacKeyring(`invite-v1:${secret}`));

    await expect(
      service.createInvite({ maxUses: 0, emailAllowlist: [], expiresAt: null, issuedBy: null }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects expired invites and malformed allowlist addresses', async () => {
    const create = vi.fn();
    const service = new InviteCodeService({ create }, new HmacKeyring(`invite-v1:${secret}`));

    await expect(
      service.createInvite({
        maxUses: 1,
        emailAllowlist: [],
        expiresAt: new Date(Date.now() - 1),
        issuedBy: null,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      service.createInvite({
        maxUses: 1,
        emailAllowlist: ['invalid'],
        expiresAt: null,
        issuedBy: null,
      }),
    ).rejects.toThrow(/Invalid email/);
    expect(create).not.toHaveBeenCalled();
  });
});
