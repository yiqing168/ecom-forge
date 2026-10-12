import { randomBytes, randomUUID } from 'node:crypto';

import { normalizeEmail } from '../security/email.js';
import type { HmacDigest, HmacKeyring } from '../security/hmac-keyring.js';

export interface RegistrationPayload {
  email: string;
  password: string;
  displayName: string;
  inviteCode: string;
  agreementVersion: string;
}

export interface ReserveRegistrationInput {
  claimId: string;
  emailHash: string;
  inviteCandidates: HmacDigest[];
  idempotencyKey: string;
  requestHash: string;
  ticketHash: string;
  ticketNonce: string;
  ticketVersion: number;
  expiresAt: Date;
  normalizedEmail: string;
  pendingDisplayName: string;
  pendingPasswordHash: string;
  agreementVersion: string;
}

export interface ReservedRegistrationClaim {
  id: string;
  emailHash: string;
  requestHash: string;
  ticketHash: string | null;
  ticketNonce: string | null;
  ticketVersion: number;
  userId: string | null;
  pendingEmail: string | null;
  pendingDisplayName: string | null;
  pendingPasswordHash: string | null;
  agreementVersion: string | null;
  expiresAt: Date;
}

export type ReserveRegistrationResult =
  | { kind: 'reserved'; claim: ReservedRegistrationClaim; replay: boolean }
  | { kind: 'not_eligible' };

export interface RegistrationGateStore {
  findByIdempotencyKey(idempotencyKey: string): Promise<ReservedRegistrationClaim | null>;
  findInviteCodeId(inviteCandidates: HmacDigest[]): Promise<string | null>;
  reserve(input: ReserveRegistrationInput): Promise<ReserveRegistrationResult>;
}

export class RegistrationNotEligibleError extends Error {
  constructor() {
    super('Registration is not eligible');
    this.name = 'RegistrationNotEligibleError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export interface RegistrationReservation {
  claim: ReservedRegistrationClaim;
  normalizedEmail: string;
  verificationTicket: string;
  replay: boolean;
}

function requestFingerprint(payload: RegistrationPayload, normalizedEmail: string): string {
  return JSON.stringify({
    email: normalizedEmail,
    password: payload.password,
    displayName: payload.displayName.normalize('NFKC'),
    inviteCode: payload.inviteCode,
    agreementVersion: payload.agreementVersion,
  });
}

export function ticketSeed(claimId: string, version: number, nonce: string): string {
  return `verification-ticket\0${claimId}\0${version}\0${nonce}`;
}

export function lookupSeed(ticket: string): string {
  return `verification-ticket-lookup\0${ticket}`;
}

export class RegistrationGate {
  constructor(
    private readonly store: RegistrationGateStore,
    private readonly inviteKeys: HmacKeyring,
    private readonly identityKeys: HmacKeyring,
    private readonly ticketKeys: HmacKeyring,
  ) {}

  async replay(
    payload: RegistrationPayload,
    idempotencyKey: string,
  ): Promise<RegistrationReservation | null> {
    const claim = await this.store.findByIdempotencyKey(idempotencyKey);
    if (!claim) return null;
    const normalizedEmail = normalizeEmail(payload.email);
    const requestHash = this.identityKeys.digest(
      requestFingerprint(payload, normalizedEmail),
    ).digest;
    if (claim.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }
    return {
      claim,
      normalizedEmail,
      verificationTicket: this.restoreTicket(claim),
      replay: true,
    };
  }

  findInviteCodeId(inviteCode: string): Promise<string | null> {
    return this.store.findInviteCodeId(this.inviteKeys.candidates(inviteCode));
  }

  async reserve(
    payload: RegistrationPayload,
    idempotencyKey: string,
    passwordHash: string,
  ): Promise<RegistrationReservation> {
    const normalizedEmail = normalizeEmail(payload.email);
    const claimId = randomUUID();
    const ticketNonce = randomBytes(16).toString('base64url');
    const ticketVersion = 1;
    const verificationTicket = this.ticketKeys.digest(
      ticketSeed(claimId, ticketVersion, ticketNonce),
    ).digest;
    const ticketHash = this.ticketKeys.digest(lookupSeed(verificationTicket)).digest;
    const requestHash = this.identityKeys.digest(
      requestFingerprint(payload, normalizedEmail),
    ).digest;

    const result = await this.store.reserve({
      claimId,
      emailHash: this.identityKeys.digest(`registration-email\0${normalizedEmail}`).digest,
      inviteCandidates: this.inviteKeys.candidates(payload.inviteCode),
      idempotencyKey,
      requestHash,
      ticketHash,
      ticketNonce,
      ticketVersion,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      normalizedEmail,
      pendingDisplayName: payload.displayName.normalize('NFKC'),
      pendingPasswordHash: passwordHash,
      agreementVersion: payload.agreementVersion,
    });

    if (result.kind === 'not_eligible') {
      throw new RegistrationNotEligibleError();
    }
    if (result.claim.requestHash !== requestHash) {
      throw new IdempotencyConflictError();
    }

    const ticket = result.replay ? this.restoreTicket(result.claim) : verificationTicket;
    return {
      claim: result.claim,
      normalizedEmail,
      verificationTicket: ticket,
      replay: result.replay,
    };
  }

  private restoreTicket(claim: ReservedRegistrationClaim): string {
    if (!claim.ticketNonce || !claim.ticketHash || claim.expiresAt.getTime() <= Date.now()) {
      throw new RegistrationNotEligibleError();
    }
    const candidates = this.ticketKeys.candidates(
      ticketSeed(claim.id, claim.ticketVersion, claim.ticketNonce),
    );
    for (const candidate of candidates) {
      if (
        this.ticketKeys
          .candidates(lookupSeed(candidate.digest))
          .some(({ digest }) => digest === claim.ticketHash)
      ) {
        return candidate.digest;
      }
    }
    throw new RegistrationNotEligibleError();
  }
}
