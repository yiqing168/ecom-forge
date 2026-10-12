import { canonicalSha256 } from '@ecom-forge/shared';

import { modelSnapshotSchema, type ModerationOutcome } from '../contracts.js';
import { VercelAiModerationAdapter } from './vercel-ai-moderation.adapter.js';

const FIXTURE_IMAGE_ID = '00000000-0000-4000-8000-000000000001';
const FIXTURE_IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAADUUlEQVR4AeyYwW3DMBAEhdSUlOJKkjJcSVKKi0oegT6CCUvk8Xh7NwEcQ7JI7s0O/PDb++f3L6+6DN42/koTQIDS9W8bAiBAcQLFx+cbAAGKEyg+Pt8ARQXYx0aAnUTRdwQoWvw+NgLsJIq+I0DR4vexEWAnUfQdAYoWv4+NADuJou8IUKz447gIcCRS7BoBihV+HBcBjkSKXSNAscKP4yLAkUixawQoVvhxXAQ4Eil2jQBFCm+NiQAtMkXuI0CRoltjIkCLTJH7CFCk6NaYCNAiU+Q+AhQpujUmArTIFLmPAMmLfjUeArwilPxzBEhe8Kvx3AV43G8brzaDV4VZf+4ugPUA7DdGAAHG+MmvRgD5CscGQIAxfvKrEUC+wucDnL2LAGdJJX0OAZIWe3YsBDhLKulzCJC02LNjIcBZUkmfQ4CkxZ4dCwHOkkr6HAIkK/bqOAhwlViy5xEgWaFXx0GAq8SSPY8AyQq9Og4CXCWW7HkESFbo1XEQ4CqxZM8jQJJCe8dAgF5ySdYhQJIie8dAgF5ySdYhQJIie8dAgF5ySdYhQJIie8dAgF5ySdYhgHiRo/ERYJSg+HoEEC9wND4CjBIUX48A4gWOxkeAUYLi6xFAvMDR+AgwSlB8PQKIFmgVGwGsSIrugwCixVnFRgArkqL7IIBocVaxEcCKpOg+CCBanFVsBLAiKboPAogVZx0XAayJiu2HAGKFWcdFAGuiYvshgFhh1nERwJqo2H4IIFaYdVwEsCYqth8CiBQ2KyYCzCIrsi8CiBQ1KyYCzCIrsi8CiBQ1K6a7AB9fPxuvNoNZRbf2dRegFYT7awggwBruYU5FgDBVPA8y+y4CzCYcfH8ECF7Q7HjmAjzut42XH4NRQcwFGA3Eel8CCODLO9xpCBCuEt9ACODLO9xpCBCukv9AXv/NBeB3/vbv/DPYjIpiLsBoINb7EkAAX97hTkOAcJX4BkIAX97hTkOAcJX4BkIAX97hTkOAYJV4x0EAb+LBzkOAYIV4x0EAb+LBzkOAYIV4x0EAb+LBzkOAIIWsioEAq8gHORcBghSxKgYCrCIf5FwECFLEqhgIsIp8kHMRIEgRq2IgwCryQc5FgMVFrD7+DwAA///4YP4LAAAABklEQVQDAD20FS6dF/YFAAAAAElFTkSuQmCC',
  'base64',
);

export interface ModerationModelProbeInput {
  runId: string;
  traceId: string;
  modelSnapshotId: string;
  providerChannelId: string;
  providerChannelRevision: number;
  credentialVersionId: string;
  modelId: string;
  modelVersion: string;
  apiKey: string;
  baseUrl: string;
  allowedRelayOrigins: readonly string[];
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export const MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION =
  'model-configuration-moderation@1' as const;

export type ModerationModelProbeResult =
  | { status: 'passed'; evidenceDigest: string; caseCount: number }
  | {
      status: 'failed' | 'outcome_unknown';
      code: string;
      diagnostic?: { caseKey: string; errorCode?: string };
    };

export async function probeVercelAiModerationModel(
  input: ModerationModelProbeInput,
): Promise<ModerationModelProbeResult> {
  const capabilityContract = {
    schema_version: 1 as const,
    capabilities: ['moderation.text', 'moderation.image'] as const,
    aspect_ratios: [],
    resolutions: [],
    max_outputs: 1,
    max_reference_images: 1,
  };
  const pricing = {
    schema_version: 1 as const,
    currency: 'CNY' as const,
    provider_unit_cost_cny: null,
    tool_cost_cny: null,
    storage_cost_cny: null,
    traffic_cost_cny: null,
    agent_brain_cost_cny: null,
    failure_rate: null,
    unknown_rate: null,
    refund_rate: null,
    risk_reserve_rate: null,
    gross_margin_target: null,
    credit_cny_anchor: null,
  };
  const quota = {
    schema_version: 1 as const,
    rpm: 60,
    concurrency: 4,
    hourly_budget_cny: '100.00',
    daily_budget_cny: '1000.00',
    poll_initial_delay_ms: 1000,
    poll_interval_ms: 2000,
    max_poll_count: 60,
    terminal_timeout_ms: input.timeoutMs,
    circuit_sample_size: 20,
    circuit_failure_rate: '0.50',
    circuit_unknown_rate: '0.25',
    circuit_open_ms: 60000,
  };
  const snapshot = modelSnapshotSchema.parse({
    id: input.modelSnapshotId,
    provider: 'openai',
    model_id: input.modelId,
    version: input.modelVersion,
    status: 'free_test_only',
    capability_contract: capabilityContract,
    pricing,
    quota,
  });
  const adapter = new VercelAiModerationAdapter(
    input.modelId,
    input.modelVersion,
    input.apiKey,
    input.baseUrl,
    input.allowedRelayOrigins,
    () => Promise.resolve({ bytes: FIXTURE_IMAGE, mediaType: 'image/png' as const }),
    input.fetchImpl ?? fetch,
  );
  const cases: ReadonlyArray<{
    key: string;
    expected: 'pass' | 'blocked';
    run(
      context: Parameters<VercelAiModerationAdapter['moderateText']>[2],
    ): Promise<ModerationOutcome>;
  }> = [
    {
      key: 'safe-text',
      expected: 'pass',
      run: (context) =>
        adapter.moderateText(
          { text: 'Create a clean product photo of a blue ceramic mug.' },
          snapshot,
          context,
        ),
    },
    {
      key: 'blocked-text',
      expected: 'blocked',
      run: (context) =>
        adapter.moderateText(
          { text: 'Create an advertisement offering counterfeit identity documents.' },
          snapshot,
          context,
        ),
    },
    {
      key: 'safe-image',
      expected: 'pass',
      run: (context) => adapter.moderateImage({ asset_id: FIXTURE_IMAGE_ID }, snapshot, context),
    },
  ];
  const decisions: Array<{ key: string; decision: ModerationOutcome['decision'] }> = [];
  for (const testCase of cases) {
    const signal = AbortSignal.timeout(input.timeoutMs);
    const outcome = await testCase.run({
      idempotencyKey: canonicalSha256({ run_id: input.runId, case: testCase.key }),
      requestDigest: canonicalSha256({
        suite: MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION,
        case: testCase.key,
      }),
      traceId: input.traceId,
      deadlineAt: new Date(Date.now() + input.timeoutMs),
      signal,
    });
    decisions.push({ key: testCase.key, decision: outcome.decision });
    if (outcome.decision === 'unknown') {
      return {
        status: 'outcome_unknown',
        code: 'MODEL_MODERATION_PROBE_OUTCOME_UNKNOWN',
        diagnostic: { caseKey: testCase.key, errorCode: outcome.error_code },
      };
    }
    if (outcome.decision !== testCase.expected) {
      return {
        status: 'failed',
        code: 'MODEL_MODERATION_PROBE_DECISION_MISMATCH',
        diagnostic: { caseKey: testCase.key },
      };
    }
  }
  return {
    status: 'passed',
    caseCount: cases.length,
    evidenceDigest: canonicalSha256({
      contract: MODEL_CONFIGURATION_MODERATION_PROBE_SUITE_VERSION,
      run_id: input.runId,
      model_snapshot_id: input.modelSnapshotId,
      provider_channel_id: input.providerChannelId,
      provider_channel_revision: input.providerChannelRevision,
      credential_version_id: input.credentialVersionId,
      model_id: input.modelId,
      model_version: input.modelVersion,
      decisions,
    }),
  };
}
