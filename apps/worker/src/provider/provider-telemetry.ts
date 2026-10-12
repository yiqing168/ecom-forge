import { createHash } from 'node:crypto';

export interface ProviderTelemetryLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export const NOOP_PROVIDER_TELEMETRY: ProviderTelemetryLogger = {
  info: () => undefined,
  error: () => undefined,
};

export function telemetryId(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 22);
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asUnknownArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? (value as unknown[]) : undefined;
}

export function stableErrorCode(error: unknown): string {
  const errorRecord = asUnknownRecord(error);
  if (errorRecord) {
    const code = errorRecord.code;
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{1,127}$/.test(code)) return code;
    const reason = errorRecord.reasonCode;
    if (typeof reason === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{1,127}$/.test(reason)) {
      return reason;
    }
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/.test(error.message)) {
    return error.message;
  }
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR';
  // Error.name is mutable and upstream libraries can put request data in it.
  return ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError'].includes(
    error.name,
  )
    ? error.name
    : 'Error';
}

type ErrorRecord = Record<string, unknown> & {
  reason?: unknown;
  detail?: unknown;
  issues?: unknown;
  cause?: unknown;
};

/**
 * Bounded, safe description of a failure for telemetry. Only *controlled* identifiers are
 * emitted: known error class names, `SCREAMING_SNAKE` codes, SQLSTATEs and zod issue
 * paths/codes. Raw `name`/`message`/`reason`/`detail` are upstream- or caller-controlled and can
 * carry secrets, signed URLs or user content (`docs/08`), so they are never copied verbatim.
 * The result stays diagnosable without a debugger: the code names the failure, the zod path
 * pinpoints the field and the SQLSTATE the class.
 */
export function errorDetailLine(error: unknown, limit = 700): string {
  const parts: string[] = [];
  const push = (value: string | undefined): void => {
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  };
  /** Codes that are themselves the message, e.g. `AGENT_TRACE_MISSING`. */
  const CONTROLLED_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
  const CONTROLLED_NAMES = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ZodError',
    'PostgresError',
    'AgentTranscriptWriteError',
    'AgentTranscriptReadError',
    'AgentBrainCallError',
  ]);
  const safeName = (value: unknown): string | undefined =>
    typeof value === 'string' && CONTROLLED_NAMES.has(value) ? value : undefined;
  const safeCode = (value: unknown): string | undefined =>
    typeof value === 'string' && CONTROLLED_CODE.test(value) ? value : undefined;

  if (error instanceof Error) {
    push(safeName(error.name));
    push(safeCode(error.message));
  } else {
    push(safeCode(error));
  }

  const describe = (current: unknown, prefix: string): ErrorRecord | undefined => {
    const record = asUnknownRecord(current) as ErrorRecord | undefined;
    if (!record) return undefined;
    // PostgreSQL driver errors put key values (e.g. `Key (user_id)=(...)`) inside `detail` and
    // sometimes `message`; only the controlled 5-char SQLSTATE is safe to emit for those.
    const pgCode = typeof record.code === 'string' ? record.code : undefined;
    if (pgCode && /^[0-9][0-9A-Z]{4}$/.test(pgCode)) {
      push(`${prefix}pg_code=${pgCode}`);
      return record;
    }
    const reason = safeCode(record.reason);
    // Some controlled failures carry a lowercase enum instead of a SCREAMING_SNAKE code
    // (e.g. `AgentTranscriptReadError.reason`: `history_changed`, `source_invalid`). The
    // allowlist below cannot carry paths, keys or user text, and without it a transcript read
    // failure is unattributable — the exact problem that made the 2026-09-15 outage hard to
    // diagnose.
    const lowercaseReason =
      typeof record.reason === 'string' && /^[a-z_]{1,64}$/.test(record.reason)
        ? record.reason
        : undefined;
    const resolvedReason = reason ?? lowercaseReason;
    push(resolvedReason ? `${prefix}reason=${resolvedReason}` : undefined);
    if (Array.isArray(record.issues)) {
      push(
        (safeValidationIssues(record) ?? [])
          .slice(0, 4)
          .map((issue) => `${issue.path || '(root)'}: ${issue.code}`)
          .join(' | '),
      );
    }
    return record;
  };

  const root = describe(error, '');
  let next: unknown = root?.cause;
  for (let depth = 0; depth < 4 && next instanceof Error; depth += 1) {
    const name = safeName(next.name);
    const code = safeCode(next.message);
    const labelled = [name, code].filter((value): value is string => Boolean(value)).join(': ');
    if (labelled.length > 0) push(`cause: ${labelled}`);
    next = describe(next, 'cause.')?.cause;
  }
  return parts.join(' | ').slice(0, limit);
}

export function safeValidationIssues(
  error: unknown,
): Array<{ code: string; path: string; fields?: string[] }> | undefined {
  const errorRecord = asUnknownRecord(error);
  const issues = asUnknownArray(errorRecord?.issues);
  if (!issues) return undefined;
  return issues.slice(0, 8).flatMap((issue) => {
    const issueRecord = asUnknownRecord(issue);
    if (!issueRecord) return [];
    const code =
      typeof issueRecord.code === 'string' && /^[a-z_]{1,64}$/.test(issueRecord.code)
        ? issueRecord.code
        : 'validation_error';
    const rawPath = asUnknownArray(issueRecord.path) ?? [];
    const path = rawPath
      .slice(0, 8)
      .map((segment: unknown) =>
        typeof segment === 'number'
          ? String(segment)
          : typeof segment === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(segment)
            ? segment
            : '?',
      )
      .join('.');
    const fields = (asUnknownArray(issueRecord.keys) ?? [])
      .filter(
        (field): field is string =>
          typeof field === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field),
      )
      .slice(0, 8);
    return [{ code, path, ...(fields.length > 0 ? { fields } : {}) }];
  });
}
