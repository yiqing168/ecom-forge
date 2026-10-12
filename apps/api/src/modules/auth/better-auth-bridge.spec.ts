import { getAuthTables } from 'better-auth';

import {
  emailVerifiedInput,
  emailVerifiedOutput,
  emailVerifiedTimestampBridge,
} from './better-auth-bridge.js';

describe('emailVerifiedTimestampBridge', () => {
  it('maps Better Auth booleans to the timestamp truth', () => {
    expect(emailVerifiedInput(false)).toBeNull();
    expect(emailVerifiedInput(true)).toBeInstanceOf(Date);
    expect(() => emailVerifiedInput('true')).toThrow(TypeError);
  });

  it('maps the database timestamp back to a boolean', () => {
    expect(emailVerifiedOutput(null)).toBe(false);
    expect(emailVerifiedOutput(new Date('2026-08-09T00:00:00.000Z'))).toBe(true);
    expect(() => emailVerifiedOutput(true)).toThrow(TypeError);
  });

  it('overrides the core field without adding a second boolean column', () => {
    const tables = getAuthTables({ plugins: [emailVerifiedTimestampBridge] });
    const field = tables.user?.fields.emailVerified;

    expect(field?.fieldName).toBe('emailVerifiedAt');
    expect(field?.type).toBe('boolean');
    expect(field?.transform?.input).toBe(emailVerifiedInput);
    expect(field?.transform?.output).toBe(emailVerifiedOutput);
  });
});
