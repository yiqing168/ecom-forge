import type { BetterAuthPlugin, DBPrimitive } from 'better-auth';

export function emailVerifiedInput(value: DBPrimitive): Date | null {
  if (value === true) {
    return new Date();
  }
  if (value === false || value === null || value === undefined) {
    return null;
  }
  throw new TypeError('emailVerified must be a boolean');
}

export function emailVerifiedOutput(value: DBPrimitive): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (value instanceof Date) {
    return true;
  }
  throw new TypeError('email_verified_at must be a Date or null');
}

export const emailVerifiedTimestampBridge = {
  id: 'email-verified-timestamp-bridge',
  schema: {
    user: {
      disableMigration: true,
      fields: {
        emailVerified: {
          type: 'boolean',
          defaultValue: false,
          required: true,
          input: false,
          fieldName: 'emailVerifiedAt',
          transform: {
            input: emailVerifiedInput,
            output: emailVerifiedOutput,
          },
        },
      },
    },
  },
} satisfies BetterAuthPlugin;
