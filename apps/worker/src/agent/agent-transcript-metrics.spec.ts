import { afterEach, describe, expect, it } from 'vitest';

import {
  buildTranscriptMetricEvent,
  emitTranscriptMetric,
  setTranscriptMetricsSink,
  transcriptMetricValue,
  type TranscriptMetricEvent,
  type TranscriptMetricName,
} from './agent-transcript-metrics.js';

const ALL_METRICS: readonly TranscriptMetricName[] = [
  'transcript_append_latency',
  'transcript_lock_wait',
  'transcript_bytes',
  'transcript_integrity_failure',
  'transcript_pending_call_recovery',
  'transcript_projection_tokens',
  'transcript_summary_cas_conflict',
];

function capture() {
  const events: TranscriptMetricEvent[] = [];
  setTranscriptMetricsSink({
    info: (event) => events.push(event as unknown as TranscriptMetricEvent),
  });
  return events;
}

afterEach(() => setTranscriptMetricsSink());

describe('transcript metric registration', () => {
  it('emits every S08 metric name under one bounded event', () => {
    const events = capture();
    for (const metric of ALL_METRICS) {
      emitTranscriptMetric({ metric, format: 'transcript_v1', result: 'ok', value: 1 });
    }
    expect(events).toHaveLength(ALL_METRICS.length);
    expect(events.map((event) => event.metric)).toEqual([...ALL_METRICS]);
    for (const event of events) {
      expect(event).toMatchObject({ event: 'agent_transcript_metric', format: 'transcript_v1' });
    }
  });

  it('does not implement the cancelled backfill metric', () => {
    expect(() =>
      buildTranscriptMetricEvent({
        // @ts-expect-error cancelled by the `02` §11.0 scope revision; reported as not applicable
        metric: 'transcript_import_remaining',
        format: 'transcript_v1',
      }),
    ).toThrow();
  });

  it('keeps only bounded labels and rejects high-cardinality identifiers', () => {
    expect(() =>
      buildTranscriptMetricEvent({
        metric: 'transcript_append_latency',
        format: 'transcript_v1',
        // @ts-expect-error user/session identifiers must never become labels
        user_id: '5b1d0a2c-0000-4000-8000-000000000001',
      }),
    ).toThrow();
    expect(() =>
      buildTranscriptMetricEvent({
        metric: 'transcript_projection_tokens',
        format: 'transcript_v1',
        // @ts-expect-error high-cardinality session identifier must never become a label
        session_id: 'ignored',
      }),
    ).toThrow();
  });

  it('rejects labels outside the bounded enums', () => {
    expect(() =>
      emitTranscriptMetric({
        // @ts-expect-error unknown metric name
        metric: 'transcript_made_up',
        format: 'transcript_v1',
      }),
    ).toThrow();
    expect(() =>
      emitTranscriptMetric({
        metric: 'transcript_bytes',
        // @ts-expect-error unknown format
        format: 'future_v2',
      }),
    ).toThrow();
    expect(() =>
      emitTranscriptMetric({
        metric: 'transcript_bytes',
        format: 'legacy_v1',
        // @ts-expect-error unknown result
        result: 'maybe',
      }),
    ).toThrow();
    expect(() =>
      emitTranscriptMetric({
        metric: 'transcript_bytes',
        format: 'legacy_v1',
        // @ts-expect-error unknown item type
        type: 'prompt',
      }),
    ).toThrow();
  });

  it('counts each emission once, so repeated emits never double count', () => {
    const events = capture();
    const first = emitTranscriptMetric({
      metric: 'transcript_bytes',
      format: 'transcript_v1',
      value: 128,
    });
    const second = emitTranscriptMetric({
      metric: 'transcript_bytes',
      format: 'transcript_v1',
      value: 128,
    });
    expect(events).toHaveLength(2);
    expect(first).toEqual(second);
    expect(events[0]).toMatchObject({ value: 128 });
  });

  it('prevents negative or non-finite samples from reaching a metric body', () => {
    expect(transcriptMetricValue(-1)).toBe(0);
    expect(transcriptMetricValue(Number.NaN)).toBe(0);
    expect(transcriptMetricValue(12.4)).toBe(12);
    expect(() =>
      emitTranscriptMetric({
        metric: 'transcript_lock_wait',
        format: 'transcript_v1',
        value: -5,
      }),
    ).toThrow();
  });

  it('defaults to a silent sink so unwired callers cannot throw', () => {
    setTranscriptMetricsSink();
    expect(() =>
      emitTranscriptMetric({
        metric: 'transcript_integrity_failure',
        format: 'transcript_v1',
        value: 1,
      }),
    ).not.toThrow();
  });
});
