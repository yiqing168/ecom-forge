import { canonicalSha256 } from '@ecom-forge/shared';
import { describe, expect, it } from 'vitest';

import { transcriptOutcomeDigest } from './agent-llm-cost.repository.js';

/**
 * Regression lock for the transcript-outcome digest.
 *
 * The stored digest is written at settlement from the real outcome, while the transcript read
 * path rebuilds the outcome from the stored item — a rebuild that can never reconstruct the
 * optional `detail`. A digest that covered `detail` therefore never verified, which surfaced as
 * `transcript_integrity_failure` / `AGENT_TRANSCRIPT_READ_FAILED` and stalled every repair round.
 */
describe('transcript outcome digest', () => {
  const usage = { input_tokens: 40, output_tokens: 12 };

  it('ignores the optional detail so the read-path rebuild verifies', () => {
    const withDetail = {
      type: 'invalid_tool_input' as const,
      error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID' as const,
      tool: 'agent_candidate_plan',
      paths: ['nodes.0.params.aspect_ratio'],
      detail: 'nodes.0.params.aspect_ratio: Invalid option [received <missing>]',
      usage,
    };
    // Exactly the shape `agent-transcript-policy-context` rebuilds from the stored item.
    const rebuilt = {
      type: 'invalid_tool_input' as const,
      error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID' as const,
      tool: 'agent_candidate_plan',
      paths: ['nodes.0.params.aspect_ratio'],
      usage,
    };

    expect(transcriptOutcomeDigest(withDetail)).toBe(canonicalSha256(rebuilt));
  });

  it('still distinguishes outcomes that differ outside detail', () => {
    const base = {
      type: 'invalid_tool_input' as const,
      error_code: 'AGENT_BRAIN_TOOL_INPUT_INVALID' as const,
      tool: 'agent_candidate_plan',
      paths: ['nodes.0.params.aspect_ratio'],
      usage,
    };

    expect(transcriptOutcomeDigest(base)).not.toBe(
      transcriptOutcomeDigest({ ...base, paths: ['nodes.1.params.aspect_ratio'] }),
    );
    expect(transcriptOutcomeDigest(base)).not.toBe(
      transcriptOutcomeDigest({ ...base, tool: 'inspect_image' }),
    );
  });
});
