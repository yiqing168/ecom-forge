export const WORKER_RUNTIME_DEFAULTS = {
  apiPort: 3001,
  localRedisPrefix: 'ecom-forge',
  localUploadRoot: '../../uploads',
  heartbeatIntervalMs: 15_000,
  heartbeatStaleMs: 45_000,
  dispatchLeaseMs: 30_000,
  dispatchLeaseRenewMs: 10_000,
  dispatchPollMs: 1_000,
  dispatchBatchSize: 100,
  dispatchBackoffBaseMs: 1_000,
  dispatchBackoffMaxMs: 60_000,
  drainTimeoutMs: 30_000,
  providerRequestTimeoutMs: 30_000,
  imageProviderRequestTimeoutMs: 600_000,
  imageNotDispatchedMaxRetries: 3,
  imageNotDispatchedRetryBaseMs: 250,
  // One slow Provider request must not serialize unrelated image tasks. The model quota
  // remains an independent gate, so effective concurrency is the lower of both limits.
  providerImageTaskConcurrency: 9,
  agentRequestTimeoutMs: 240_000,
  agentProcessingLeaseMs: 300_000,
  agentProcessingRenewMs: 20_000,
  // 4 total queue executions = up to 3 retries for transient pre-loop failures
  // (product directive: transient errors retry 3 times).
  agentProcessingRetryAttempts: 4,
  agentProcessingRetryBaseMs: 1_000,
  agentMaxLlmRounds: 6,
  agentMaxToolCalls: 12,
  // Compatibility name retained for the public config shape. This is the effective active
  // context window, not a cumulative per-turn input budget.
  agentMaxInputTokens: 272_000,
  agentAutoCompactTokenLimit: 217_600,
  // Absolute operator ceiling, independent of task-sized rounds and inspection batching.
  // Larger tasks can receive more rounds without increasing this cumulative output ceiling.
  agentMaxOutputTokens: 44 * 8_192,
  agentBrainStepMaxOutputTokens: 8_192,
  agentBrainImageMaxEdge: 4_096,
  agentBrainRetryBaseDelayMs: 1_000,
  agentBrainRetryMaxDelayMs: 8_000,
  agentBrainImageMaterializationConcurrency: 2,
  // Fixed product policy forwarded only to OpenAI-family Brain models.
  agentBrainReasoningEffort: 'medium',
  // One turn may materialize several authorized references, but must stay bounded in worker memory.
  agentBrainMaxMaterializedImageBytes: 64 * 1024 * 1024,
  agentMaxEstimatedCostCny: '0.15',
  agentMaxReferences: 12,
  compilerQuoteTtlSeconds: 600,
  storageMaxImageBytes: 20 * 1024 * 1024,
  storageMaxImageWidth: 16_384,
  storageMaxImageHeight: 16_384,
  storageMaxImagePixels: 100_000_000,
  contentReviewDeadlineSeconds: 86_400,
  contentReviewSweepBatchSize: 50,
  outcomeUnknownReleaseDeadlineSeconds: 30 * 60,
  outcomeUnknownReleaseSweepBatchSize: 50,
  databasePoolMax: 10,
  databaseStatementTimeoutMs: 15_000,
  databaseTransactionTimeoutMs: 10_000,
  agentTranscriptLockTimeoutMs: 1_000,
  agentTranscriptTransactionTimeoutMs: 5_000,
  agentTranscriptRollbackReserveMs: 50,
  agentTranscriptAppendMaxItems: 16,
  agentTranscriptAppendEnvelopeBytes: 1024 * 1024,
  agentTranscriptAppendPayloadBytes: 64 * 1024 * 1024,
  agentTranscriptAppendTailItems: 200,
  agentTranscriptReadPageItems: 200,
  agentTranscriptReadMaxItems: 2048,
  agentTranscriptReadMaxBytes: 128 * 1024 * 1024,
  // Readiness metadata (version enums only, never content). This is the single source of truth
  // for the only execution/capture format this worker accepts.
  supportedAgentExecutionFormats: ['transcript_v1'],
  supportedTranscriptSchemaVersions: [1],
  // Audit snapshot retention window for archived sessions (`08` §4.1). Version-enum shape only.
  transcriptArchivePhysicalRetentionDays: 180,
  transcriptArchiveBackupRetentionDays: 365,
  transcriptArchiveSweepBatchSize: 50,
  realProviderMode: 'real',
  fakeProviderMode: 'fake',
  realProviderAdapter: 'disabled',
  fakeProviderAdapter: 'fake',
  testProcessorMode: 'disabled',
  testAgentBrainAdapter: 'fake',
  localAgentBrainAdapter: 'approved',
  productionAgentBrainAdapter: 'approved',
  testAgentProcessorEnabled: true,
  agentExecutionPolicyVersion: 'agent-execution-policy-v1',
} as const;

export type SupportedAgentExecutionFormat =
  (typeof WORKER_RUNTIME_DEFAULTS.supportedAgentExecutionFormats)[number];

/**
 * Fail closed on an unknown frozen execution format instead of guessing a legacy path.
 * Reuses the existing internal `TURN_STATE_INVALID` identifier (no new error code).
 */
export function assertSupportedAgentExecutionFormat(
  executionFormat: string,
): SupportedAgentExecutionFormat {
  const formats = WORKER_RUNTIME_DEFAULTS.supportedAgentExecutionFormats as readonly string[];
  if (!formats.includes(executionFormat)) {
    throw new Error('TURN_STATE_INVALID');
  }
  return executionFormat as SupportedAgentExecutionFormat;
}
