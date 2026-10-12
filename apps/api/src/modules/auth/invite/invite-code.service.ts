import { createInviteCode, type HmacKeyring } from '../security/hmac-keyring.js';
import { normalizeEmailAllowlistEntry } from '../security/email.js';

export interface CreateInviteInput {
  maxUses: number;
  emailAllowlist: string[];
  expiresAt: Date | null;
  issuedBy: string | null;
  campaignId?: string;
  batchId?: string;
  issuedByAdminId?: string;
}

export interface PersistInviteInput {
  codeDigest: string;
  keyId: string;
  codePrefix: string;
  maxUses: number;
  emailAllowlist: string[];
  expiresAt: Date | null;
  issuedBy: string | null;
  campaignId?: string;
  batchId?: string;
  issuedByAdminId?: string;
}

export interface InviteCodeStore {
  create(input: PersistInviteInput): Promise<{ id: string }>;
}

export interface CreatedInvite {
  id: string;
  plaintextCode: string;
  codePrefix: string;
}

export class InviteCodeService {
  constructor(
    private readonly store: InviteCodeStore,
    private readonly keyring: HmacKeyring,
  ) {}

  async createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
    if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 100_000) {
      throw new RangeError('maxUses must be an integer between 1 and 100000');
    }
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw new RangeError('expiresAt must be in the future');
    }

    const plaintextCode = createInviteCode();
    const digest = this.keyring.digest(plaintextCode);
    const codePrefix = plaintextCode.slice(0, 6);
    const persisted = await this.store.create({
      codeDigest: digest.digest,
      keyId: digest.keyId,
      codePrefix,
      maxUses: input.maxUses,
      emailAllowlist: [...new Set(input.emailAllowlist.map(normalizeEmailAllowlistEntry))],
      expiresAt: input.expiresAt,
      issuedBy: input.issuedBy,
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.issuedByAdminId ? { issuedByAdminId: input.issuedByAdminId } : {}),
    });

    return { id: persisted.id, plaintextCode, codePrefix };
  }
}
