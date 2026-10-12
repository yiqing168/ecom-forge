import {
  and,
  count,
  eq,
  gt,
  inArray,
  inviteCodes,
  lt,
  or,
  registrationClaims,
  users,
  type Database,
} from '@ecom-forge/db';

import type {
  RegistrationGateStore,
  ReserveRegistrationInput,
  ReserveRegistrationResult,
  ReservedRegistrationClaim,
} from './registration-gate.js';
import { emailMatchesAllowlist } from '../security/email.js';

function toClaim(row: typeof registrationClaims.$inferSelect): ReservedRegistrationClaim {
  return {
    id: row.id,
    emailHash: row.emailHash,
    requestHash: row.requestHash,
    ticketHash: row.ticketHash,
    ticketNonce: row.ticketNonce,
    ticketVersion: row.ticketVersion,
    userId: row.userId,
    pendingEmail: row.pendingEmail,
    pendingDisplayName: row.pendingDisplayName,
    pendingPasswordHash: row.pendingPasswordHash,
    agreementVersion: row.agreementVersion,
    expiresAt: row.expiresAt,
  };
}

function allowlistMatches(value: unknown, email: string): boolean {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return false;
  }
  return emailMatchesAllowlist(email, value);
}

export class DrizzleRegistrationGateStore implements RegistrationGateStore {
  constructor(private readonly database: Database) {}

  async findByIdempotencyKey(idempotencyKey: string): Promise<ReservedRegistrationClaim | null> {
    const existing = await this.database.query.registrationClaims.findFirst({
      where: eq(registrationClaims.idempotencyKey, idempotencyKey),
    });
    return existing ? toClaim(existing) : null;
  }

  async findInviteCodeId(
    inviteCandidates: ReserveRegistrationInput['inviteCandidates'],
  ): Promise<string | null> {
    const inviteCondition = or(
      ...inviteCandidates.map((candidate) =>
        and(eq(inviteCodes.keyId, candidate.keyId), eq(inviteCodes.codeDigest, candidate.digest)),
      ),
    );
    if (!inviteCondition) return null;
    const [invite] = await this.database
      .select({ id: inviteCodes.id })
      .from(inviteCodes)
      .where(inviteCondition)
      .limit(1);
    return invite?.id ?? null;
  }

  async reserve(input: ReserveRegistrationInput): Promise<ReserveRegistrationResult> {
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const existing = await transaction.query.registrationClaims.findFirst({
        where: eq(registrationClaims.idempotencyKey, input.idempotencyKey),
      });
      if (existing) {
        if (existing.status === 'pending' && existing.expiresAt.getTime() <= now.getTime()) {
          await transaction
            .update(registrationClaims)
            .set({
              status: 'expired',
              ticketHash: null,
              ticketNonce: null,
              pendingEmail: null,
              pendingDisplayName: null,
              pendingPasswordHash: null,
              updatedAt: now,
            })
            .where(
              and(eq(registrationClaims.id, existing.id), eq(registrationClaims.status, 'pending')),
            );
          return { kind: 'not_eligible' };
        }
        return { kind: 'reserved', replay: true, claim: toClaim(existing) };
      }

      const inviteCondition = or(
        ...input.inviteCandidates.map((candidate) =>
          and(eq(inviteCodes.keyId, candidate.keyId), eq(inviteCodes.codeDigest, candidate.digest)),
        ),
      );
      if (!inviteCondition) {
        return { kind: 'not_eligible' };
      }

      const [invite] = await transaction
        .select()
        .from(inviteCodes)
        .where(inviteCondition)
        .for('update')
        .limit(1);
      if (
        !invite ||
        invite.disabledAt ||
        (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) ||
        !allowlistMatches(invite.emailAllowlist, input.normalizedEmail)
      ) {
        return { kind: 'not_eligible' };
      }

      const replayAfterLock = await transaction.query.registrationClaims.findFirst({
        where: eq(registrationClaims.idempotencyKey, input.idempotencyKey),
      });
      if (replayAfterLock) {
        return { kind: 'reserved', replay: true, claim: toClaim(replayAfterLock) };
      }

      const existingUser = await transaction.query.users.findFirst({
        where: eq(users.email, input.normalizedEmail),
        columns: { id: true },
      });
      if (existingUser) {
        return { kind: 'not_eligible' };
      }

      await transaction
        .update(registrationClaims)
        .set({
          status: 'expired',
          ticketHash: null,
          ticketNonce: null,
          pendingEmail: null,
          pendingDisplayName: null,
          pendingPasswordHash: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(registrationClaims.inviteCodeId, invite.id),
            eq(registrationClaims.status, 'pending'),
            lt(registrationClaims.expiresAt, now),
          ),
        );

      await transaction
        .update(registrationClaims)
        .set({
          status: 'expired',
          ticketHash: null,
          ticketNonce: null,
          pendingEmail: null,
          pendingDisplayName: null,
          pendingPasswordHash: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(registrationClaims.emailHash, input.emailHash),
            eq(registrationClaims.status, 'pending'),
            lt(registrationClaims.expiresAt, now),
          ),
        );

      const [active] = await transaction
        .select({ value: count() })
        .from(registrationClaims)
        .where(
          and(
            eq(registrationClaims.inviteCodeId, invite.id),
            or(
              and(eq(registrationClaims.status, 'pending'), gt(registrationClaims.expiresAt, now)),
              eq(registrationClaims.status, 'verified'),
            ),
          ),
        );
      if (invite.usedCount + (active?.value ?? 0) >= invite.maxUses) {
        return { kind: 'not_eligible' };
      }

      const existingActiveEmail = await transaction.query.registrationClaims.findFirst({
        where: and(
          eq(registrationClaims.emailHash, input.emailHash),
          inArray(registrationClaims.status, ['pending', 'verified']),
        ),
      });
      if (existingActiveEmail) {
        return { kind: 'not_eligible' };
      }

      const [claim] = await transaction
        .insert(registrationClaims)
        .values({
          id: input.claimId,
          inviteCodeId: invite.id,
          emailHash: input.emailHash,
          pendingEmail: input.normalizedEmail,
          pendingDisplayName: input.pendingDisplayName,
          pendingPasswordHash: input.pendingPasswordHash,
          agreementVersion: input.agreementVersion,
          ticketHash: input.ticketHash,
          ticketNonce: input.ticketNonce,
          ticketVersion: input.ticketVersion,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!claim) {
        const racedReplay = await transaction.query.registrationClaims.findFirst({
          where: eq(registrationClaims.idempotencyKey, input.idempotencyKey),
        });
        return racedReplay
          ? { kind: 'reserved', replay: true, claim: toClaim(racedReplay) }
          : { kind: 'not_eligible' };
      }
      return { kind: 'reserved', replay: false, claim: toClaim(claim) };
    });
  }
}
