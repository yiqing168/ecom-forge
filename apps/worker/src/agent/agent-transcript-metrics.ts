import { z } from 'zod';

/**
 * Structured-log equivalent metrics entry point for the S08 transcript extension.
 *
 * The repository has no prom-client/Prometheus dependency, so metrics reuse the existing
 * structured logger. Every metric is one event named `agent_transcript_metric` carrying a
 * bounded `metric` name plus only bounded labels (`format`/`type`/`result`). User, session,
 * turn or payload identifiers are deliberately NOT accepted: `strictObject` rejects them, so
 * a caller cannot accidentally create a high-cardinality label.
 */

export const transcriptMetricNameSchema = z.enum([
  'transcript_append_latency',
  'transcript_lock_wait',
  'transcript_bytes',
  'transcript_integrity_failure',
  'transcript_pending_call_recovery',
  'transcript_projection_tokens',
  'transcript_summary_cas_conflict',
]);

/** Bounded label enums only. No IDs, no free text, no payload content. */
export const transcriptMetricFormatSchema = z.enum(['transcript_v1', 'legacy_v1']);
export const transcriptMetricTypeSchema = z.enum([
  'user_message',
  'assistant_output',
  'tool_result',
  'host_context',
  'window',
  'summary',
]);
export const transcriptMetricResultSchema = z.enum([
  'ok',
  'conflict',
  'failure',
  'recovered',
  'degraded',
]);

export const transcriptMetricEventSchema = z.strictObject({
  event: z.literal('agent_transcript_metric'),
  metric: transcriptMetricNameSchema,
  format: transcriptMetricFormatSchema,
  type: transcriptMetricTypeSchema.optional(),
  result: transcriptMetricResultSchema.optional(),
  // `transcript_import_remaining` is intentionally absent: backfill was cancelled by the
  // `02` §11.0 scope revision (report it as "not applicable", never as zero).
  value: z.int().nonnegative().optional(),
});

export type TranscriptMetricName = z.infer<typeof transcriptMetricNameSchema>;
export type TranscriptMetricFormat = z.infer<typeof transcriptMetricFormatSchema>;
export type TranscriptMetricType = z.infer<typeof transcriptMetricTypeSchema>;
export type TranscriptMetricResult = z.infer<typeof transcriptMetricResultSchema>;
export type TranscriptMetricEvent = z.infer<typeof transcriptMetricEventSchema>;

export interface TranscriptMetricInput {
  metric: TranscriptMetricName;
  format: TranscriptMetricFormat;
  type?: TranscriptMetricType;
  result?: TranscriptMetricResult;
  value?: number;
}

/** A minimal structured-logging sink; the worker wires it to its lifecycle logger. */
export interface TranscriptMetricsSink {
  info(event: Record<string, unknown>): void;
}

const silentSink: TranscriptMetricsSink = { info: () => {} };
let sink: TranscriptMetricsSink = silentSink;

/**
 * Install (or clear) the process-wide sink. Passing `undefined` restores the silent default so
 * unit tests never leak metrics into an unrelated logger.
 */
export function setTranscriptMetricsSink(next?: TranscriptMetricsSink): void {
  sink = next ?? silentSink;
}

/**
 * Validate and freeze one metric event. Throws when a label is out of its bounded enum or when
 * a high-cardinality key (e.g. `user_id`) is supplied, so misuse fails loudly in tests.
 */
export function buildTranscriptMetricEvent(input: TranscriptMetricInput): TranscriptMetricEvent {
  return Object.freeze(
    transcriptMetricEventSchema.parse({ event: 'agent_transcript_metric', ...input }),
  );
}

/**
 * Emit exactly one metric event per call. This is a pass-through (never accumulates internally),
 * so repeated calls produce repeated events and never double count.
 */
export function emitTranscriptMetric(input: TranscriptMetricInput): TranscriptMetricEvent {
  const event = buildTranscriptMetricEvent(input);
  sink.info(event);
  return event;
}

/** Round a millisecond/bearing sample into a bounded, non-negative integer for the metric body. */
export function transcriptMetricValue(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), 9_007_199_254_740_991);
}
