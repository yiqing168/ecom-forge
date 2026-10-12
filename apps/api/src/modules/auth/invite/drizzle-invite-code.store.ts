import { inviteCodes, type Database } from '@ecom-forge/db';

import type { InviteCodeStore, PersistInviteInput } from './invite-code.service.js';

export class DrizzleInviteCodeStore implements InviteCodeStore {
  constructor(private readonly database: Database) {}

  async create(input: PersistInviteInput): Promise<{ id: string }> {
    const [invite] = await this.database
      .insert(inviteCodes)
      .values({
        legacyCode: null,
        codeDigest: input.codeDigest,
        keyId: input.keyId,
        codePrefix: input.codePrefix,
        emailAllowlist: input.emailAllowlist,
        maxUses: input.maxUses,
        expiresAt: input.expiresAt,
        issuedBy: input.issuedBy,
        campaignId: input.campaignId,
        batchId: input.batchId,
        issuedByAdminId: input.issuedByAdminId,
      })
      .returning({ id: inviteCodes.id });
    if (!invite) {
      throw new Error('Invite code insert returned no row');
    }
    return invite;
  }
}
