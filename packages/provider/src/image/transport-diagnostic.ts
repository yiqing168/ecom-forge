import { z } from 'zod';

const networkCodeSchema = z.enum([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
  'ABORT_ERR',
]);
const errorNameSchema = z.enum([
  'Error',
  'TypeError',
  'AbortError',
  'TimeoutError',
  'SocketError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'SyntaxError',
]);

export const imageTransportDiagnosticSchema = z.strictObject({
  phase: z.enum(['response_headers', 'response_body', 'output_headers', 'output_body', 'dispatch']),
  elapsed_ms: z.int().nonnegative(),
  total_elapsed_ms: z.int().nonnegative(),
  aborted: z.boolean(),
  deadline_exceeded: z.boolean(),
  error_name: errorNameSchema.optional(),
  network_code: networkCodeSchema.optional(),
  http_status: z.int().min(100).max(599).optional(),
});
export type ImageTransportDiagnostic = z.infer<typeof imageTransportDiagnosticSchema>;

export function imageTransportDiagnostic(
  error: unknown,
  input: {
    phase: ImageTransportDiagnostic['phase'];
    startedAt: number;
    requestStartedAt: number;
    signal: AbortSignal;
    deadlineAt: Date;
    httpStatus?: number;
  },
): ImageTransportDiagnostic {
  const now = Date.now();
  const diagnostic: ImageTransportDiagnostic = {
    phase: input.phase,
    elapsed_ms: Math.max(0, now - input.startedAt),
    total_elapsed_ms: Math.max(0, now - input.requestStartedAt),
    aborted: input.signal.aborted,
    deadline_exceeded: now >= input.deadlineAt.getTime(),
    ...(input.httpStatus === undefined ? {} : { http_status: input.httpStatus }),
  };
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    const value = current as Record<string, unknown>;
    const name = errorNameSchema.safeParse(value.name);
    const code = networkCodeSchema.safeParse(value.code);
    if (name.success && !diagnostic.error_name) diagnostic.error_name = name.data;
    if (code.success && !diagnostic.network_code) diagnostic.network_code = code.data;
    current = value.cause;
  }
  return imageTransportDiagnosticSchema.parse(diagnostic);
}
