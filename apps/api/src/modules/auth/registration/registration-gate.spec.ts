import { HmacKeyring } from '../security/hmac-keyring.js';
import {
  IdempotencyConflictError,
  RegistrationGate,
  RegistrationNotEligibleError,
  type RegistrationGateStore,
  type ReserveRegistrationInput,
  type ReservedRegistrationClaim,
} from './registration-gate.js';

const current = Buffer.alloc(32, 4).toString('base64url');
const historical = Buffer.alloc(32, 5).toString('base64url');

const payload = {
  email: ' User@例子.公司 ',
  password: 'a-long-password-value',
  displayName: '示例用户',
  inviteCode: 'invite-plaintext',
  agreementVersion: '2026-08-09',
};

function createGate(store: RegistrationGateStore): RegistrationGate {
  return new RegistrationGate(
    store,
    new HmacKeyring(`invite-v2:${current},invite-v1:${historical}`),
    new HmacKeyring(`identity-v1:${current}`),
    new HmacKeyring(`ticket-v2:${current},ticket-v1:${historical}`),
  );
}

describe('RegistrationGate', () => {
  it('normalizes identity and sends only invite HMAC candidates to the store', async () => {
    let received: ReserveRegistrationInput | undefined;
    const store: RegistrationGateStore = {
      findByIdempotencyKey: () => Promise.resolve(null),
      findInviteCodeId: () => Promise.resolve('6f07384b-3981-46d8-bfaa-b416987d1bb1'),
      reserve(input) {
        received = input;
        return Promise.resolve({
          kind: 'reserved',
          replay: false,
          claim: {
            id: input.claimId,
            emailHash: input.emailHash,
            requestHash: input.requestHash,
            ticketHash: input.ticketHash,
            ticketNonce: input.ticketNonce,
            ticketVersion: input.ticketVersion,
            userId: null,
            pendingEmail: input.normalizedEmail,
            pendingDisplayName: input.pendingDisplayName,
            pendingPasswordHash: input.pendingPasswordHash,
            agreementVersion: input.agreementVersion,
            expiresAt: input.expiresAt,
          },
        });
      },
    };

    const result = await createGate(store).reserve(payload, 'register-1', 'password-hash');

    expect(result.normalizedEmail).toBe('user@xn--fsqu00a.xn--55qx5d');
    expect(received?.inviteCandidates).toHaveLength(2);
    expect(JSON.stringify(received)).not.toContain(payload.inviteCode);
    expect(result.verificationTicket).toHaveLength(43);
  });

  it('reconstructs the same ticket on an idempotent replay', async () => {
    let saved: ReservedRegistrationClaim | undefined;
    const store: RegistrationGateStore = {
      findByIdempotencyKey: () => Promise.resolve(saved ?? null),
      findInviteCodeId: () => Promise.resolve('6f07384b-3981-46d8-bfaa-b416987d1bb1'),
      reserve(input) {
        if (!saved) {
          saved = {
            id: input.claimId,
            emailHash: input.emailHash,
            requestHash: input.requestHash,
            ticketHash: input.ticketHash,
            ticketNonce: input.ticketNonce,
            ticketVersion: input.ticketVersion,
            userId: null,
            pendingEmail: input.normalizedEmail,
            pendingDisplayName: input.pendingDisplayName,
            pendingPasswordHash: input.pendingPasswordHash,
            agreementVersion: input.agreementVersion,
            expiresAt: input.expiresAt,
          };
          return Promise.resolve({ kind: 'reserved', replay: false, claim: saved });
        }
        return Promise.resolve({ kind: 'reserved', replay: true, claim: saved });
      },
    };
    const gate = createGate(store);
    const first = await gate.reserve(payload, 'register-replay', 'password-hash');
    const replay = await gate.replay(payload, 'register-replay');

    expect(replay?.verificationTicket).toBe(first.verificationTicket);
    expect(replay?.replay).toBe(true);
  });

  it('unifies ineligible outcomes and rejects conflicting idempotency payloads', async () => {
    await expect(
      createGate({
        findByIdempotencyKey: () => Promise.resolve(null),
        findInviteCodeId: () => Promise.resolve(null),
        reserve: () => Promise.resolve({ kind: 'not_eligible' }),
      }).reserve(payload, 'blocked', 'password-hash'),
    ).rejects.toBeInstanceOf(RegistrationNotEligibleError);

    const conflictStore: RegistrationGateStore = {
      findByIdempotencyKey: () => Promise.resolve(null),
      findInviteCodeId: () => Promise.resolve('6f07384b-3981-46d8-bfaa-b416987d1bb1'),
      reserve(input) {
        return Promise.resolve({
          kind: 'reserved',
          replay: true,
          claim: {
            id: input.claimId,
            emailHash: input.emailHash,
            requestHash: 'different',
            ticketHash: input.ticketHash,
            ticketNonce: input.ticketNonce,
            ticketVersion: input.ticketVersion,
            userId: null,
            pendingEmail: input.normalizedEmail,
            pendingDisplayName: input.pendingDisplayName,
            pendingPasswordHash: input.pendingPasswordHash,
            agreementVersion: input.agreementVersion,
            expiresAt: input.expiresAt,
          },
        });
      },
    };
    await expect(
      createGate(conflictStore).reserve(payload, 'conflict', 'password-hash'),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('resolves a stable invite id using HMAC candidates without exposing plaintext', async () => {
    const findInviteCodeId = vi
      .fn<RegistrationGateStore['findInviteCodeId']>()
      .mockResolvedValue('6f07384b-3981-46d8-bfaa-b416987d1bb1');
    const gate = createGate({
      findByIdempotencyKey: () => Promise.resolve(null),
      findInviteCodeId,
      reserve: () => Promise.resolve({ kind: 'not_eligible' }),
    });

    await expect(gate.findInviteCodeId(payload.inviteCode)).resolves.toBe(
      '6f07384b-3981-46d8-bfaa-b416987d1bb1',
    );
    const candidates = findInviteCodeId.mock.calls[0]?.[0];
    expect(candidates?.map(({ keyId }) => keyId)).toEqual(['invite-v2', 'invite-v1']);
    expect(candidates?.every(({ digest }) => digest.length === 43)).toBe(true);
    expect(JSON.stringify(findInviteCodeId.mock.calls)).not.toContain(payload.inviteCode);
  });
});
