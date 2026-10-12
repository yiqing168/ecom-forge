/**
 * Pure database-name derivation and validation for the validation harness.
 *
 * Kept free of any database or process side effects so the rules that guard the destructive
 * `drop` path and the `_test` isolation requirement can be unit tested directly.
 */

const PROVISIONED_SUFFIX = '_migrated';
const MAX_IDENTIFIER_LENGTH = 63;
const ISOLATED_DATABASE_PATTERN = /_test(?:_|$)/;
const PROVISIONED_DATABASE_PATTERN = /_migrated(?:_|$)/;

/** Normalize a database name to the [a-z0-9_] alphabet PostgreSQL stores without quoting. */
export function sanitizeDatabaseIdentifier(value: string): string {
  return value.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/** The isolated "_test" naming guard every validation database must satisfy. */
export function isIsolatedTestDatabaseName(name: string): boolean {
  return ISOLATED_DATABASE_PATTERN.test(sanitizeDatabaseIdentifier(name));
}

/** Only isolated databases bearing the provisioning marker may ever be dropped. */
export function isProvisionedDatabaseName(name: string): boolean {
  const sanitized = sanitizeDatabaseIdentifier(name);
  return ISOLATED_DATABASE_PATTERN.test(sanitized) && PROVISIONED_DATABASE_PATTERN.test(sanitized);
}

/**
 * Derive the stable, deterministic provisioned database name from a configured one so repeated
 * runs reuse a single database. A name that already carries the suffix is returned unchanged; a
 * base longer than the identifier budget is truncated so the suffix is always preserved.
 */
export function deriveProvisionedDatabaseName(baseName: string): string {
  const sanitized = sanitizeDatabaseIdentifier(baseName);
  if (sanitized.endsWith(PROVISIONED_SUFFIX)) return sanitized;
  const maxBaseLength = MAX_IDENTIFIER_LENGTH - PROVISIONED_SUFFIX.length;
  return `${sanitized.slice(0, maxBaseLength)}${PROVISIONED_SUFFIX}`;
}

/** The canonical pathname guard for transcript integration test databases. */
export function isIsolatedTranscriptDatabasePath(pathname: string): boolean {
  return /^\/ecom_forge_test(?:_[a-z0-9_]+)?$/.test(pathname);
}
