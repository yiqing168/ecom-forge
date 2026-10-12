import { and, eq, isNull, registrationClaims, type Database } from '@ecom-forge/db';

export interface RegistrationClaimBindingStore {
  bindUser(claimId: string, userId: string): Promise<void>;
}

export class DrizzleRegistrationClaimBindingStore implements RegistrationClaimBindingStore {
  constructor(private readonly database: Database) {}

  async bindUser(claimId: string, userId: string): Promise<void> {
    const [updated] = await this.database
      .update(registrationClaims)
      .set({ userId, updatedAt: new Date() })
      .where(and(eq(registrationClaims.id, claimId), isNull(registrationClaims.userId)))
      .returning({ userId: registrationClaims.userId });
    if (updated?.userId === userId) {
      return;
    }

    const existing = await this.database.query.registrationClaims.findFirst({
      where: eq(registrationClaims.id, claimId),
    });
    if (existing?.userId !== userId) {
      throw new Error('Registration claim user binding conflict');
    }
  }
}
