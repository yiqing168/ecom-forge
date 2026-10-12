import { and, eq, inArray, registrationClaims, type Database } from '@ecom-forge/db';

import type { HmacKeyring } from '../security/hmac-keyring.js';
import { lookupSeed } from './registration-gate.js';

export interface VerificationClaim {
  id: string;
  inviteCodeId: string;
  userId: string | null;
  email: string;
  displayName: string;
  passwordHash: string;
  agreementVersion: string;
  ticketHash: string;
  ticketNonce: string;
  ticketVersion: number;
  expiresAt: Date;
}

export interface RegistrationClaimQueryStore {
  findByTicket(ticket: string): Promise<VerificationClaim | null>;
  invalidateTicket(claimId: string, ticketHashes: string[]): Promise<void>;
  rotateTicket(
    claimId: string,
    oldTicketHashes: string[],
    ticketHash: string,
    ticketNonce: string,
    ticketVersion: number,
  ): Promise<boolean>;
}

export class DrizzleRegistrationClaimQueryStore implements RegistrationClaimQueryStore {
  constructor(
    private readonly database: Database,
    private readonly ticketKeys: HmacKeyring,
  ) {}

  async findByTicket(ticket: string): Promise<VerificationClaim | null> {
    const ticketHashes = this.ticketKeys.candidates(lookupSeed(ticket)).map(({ digest }) => digest);
    const row = await this.database
      .select({
        id: registrationClaims.id,
        inviteCodeId: registrationClaims.inviteCodeId,
        userId: registrationClaims.userId,
        email: registrationClaims.pendingEmail,
        displayName: registrationClaims.pendingDisplayName,
        passwordHash: registrationClaims.pendingPasswordHash,
        agreementVersion: registrationClaims.agreementVersion,
        ticketHash: registrationClaims.ticketHash,
        ticketNonce: registrationClaims.ticketNonce,
        ticketVersion: registrationClaims.ticketVersion,
        expiresAt: registrationClaims.expiresAt,
      })
      .from(registrationClaims)
      .where(
        and(
          inArray(registrationClaims.ticketHash, ticketHashes),
          eq(registrationClaims.status, 'pending'),
        ),
      )
      .limit(1);
    const found = row[0];
    if (
      !found ||
      !found.email ||
      !found.displayName ||
      !found.passwordHash ||
      !found.agreementVersion ||
      !found.ticketHash ||
      !found.ticketNonce
    ) {
      return null;
    }
    return {
      id: found.id,
      inviteCodeId: found.inviteCodeId,
      userId: found.userId,
      email: found.email,
      displayName: found.displayName,
      passwordHash: found.passwordHash,
      agreementVersion: found.agreementVersion,
      ticketHash: found.ticketHash,
      ticketNonce: found.ticketNonce,
      ticketVersion: found.ticketVersion,
      expiresAt: found.expiresAt,
    };
  }

  async invalidateTicket(claimId: string, ticketHashes: string[]): Promise<void> {
    await this.database
      .update(registrationClaims)
      .set({
        status: 'expired',
        ticketHash: null,
        ticketNonce: null,
        pendingEmail: null,
        pendingDisplayName: null,
        pendingPasswordHash: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(registrationClaims.id, claimId),
          eq(registrationClaims.status, 'pending'),
          inArray(registrationClaims.ticketHash, ticketHashes),
        ),
      );
  }

  async rotateTicket(
    claimId: string,
    oldTicketHashes: string[],
    ticketHash: string,
    ticketNonce: string,
    ticketVersion: number,
  ): Promise<boolean> {
    const updated = await this.database
      .update(registrationClaims)
      .set({ ticketHash, ticketNonce, ticketVersion, updatedAt: new Date() })
      .where(
        and(
          eq(registrationClaims.id, claimId),
          eq(registrationClaims.status, 'pending'),
          inArray(registrationClaims.ticketHash, oldTicketHashes),
        ),
      )
      .returning({ id: registrationClaims.id });
    return Boolean(updated[0]);
  }
}
