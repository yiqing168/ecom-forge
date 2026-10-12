import type { AgentBrainDiagnostic } from '@ecom-forge/agent';
import {
  AGENT_BRAIN_FAILURE_SUMMARIES as SUMMARIES,
  type AgentPublicSummary,
} from '@ecom-forge/shared';

export function agentBrainPublicFailure(
  errorCode: string,
  diagnostic?: AgentBrainDiagnostic,
): AgentPublicSummary {
  const code = diagnostic?.providerErrorCode;
  const type = diagnostic?.providerErrorType;
  const status = diagnostic?.statusCode;
  // A specific upstream reason takes precedence over a generic HTTP or stream failure.
  if (code === 'insufficient_quota' || type === 'insufficient_quota') return SUMMARIES.quota;
  if (code === 'context_length_exceeded') return SUMMARIES.context;
  if (code === 'content_filter') return SUMMARIES.content;
  if (
    code === 'invalid_api_key' ||
    code === 'model_not_found' ||
    type === 'authentication_error' ||
    type === 'permission_error'
  ) {
    return SUMMARIES.configuration;
  }
  if (code === 'rate_limit_exceeded' || type === 'rate_limit_error') return SUMMARIES.rateLimit;
  if (code === 'timeout' || code === 'request_timeout' || type === 'timeout_error') {
    return SUMMARIES.timeout;
  }
  if (
    ['internal_error', 'server_error', 'overloaded_error'].includes(code ?? '') ||
    ['server_error', 'api_error', 'internal_server_error', 'overloaded_error'].includes(type ?? '')
  ) {
    return SUMMARIES.service;
  }
  if (status === 429) return SUMMARIES.rateLimit;
  if (status === 401 || status === 403) return SUMMARIES.configuration;
  if (status === 408 || status === 504) return SUMMARIES.timeout;
  if (status !== undefined && status >= 500 && status <= 599) return SUMMARIES.service;
  if (status === 400 || status === 422 || type === 'invalid_request_error')
    return SUMMARIES.request;
  if (diagnostic?.code === 'AGENT_BRAIN_PROVIDER_TIMEOUT') return SUMMARIES.timeout;
  if (diagnostic?.code === 'AGENT_BRAIN_PROVIDER_NETWORK_FAILED') return SUMMARIES.network;
  if (
    ['AGENT_BRAIN_PROVIDER_RESPONSE_INVALID', 'AGENT_BRAIN_PROVIDER_TOOL_INVALID'].includes(
      diagnostic?.code ?? '',
    ) ||
    [
      'AGENT_BRAIN_USAGE_UNTRUSTED',
      'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
      'AGENT_SESSION_SUMMARY_INVALID',
    ].includes(errorCode)
  ) {
    return SUMMARIES.response;
  }
  if (diagnostic?.code === 'AGENT_BRAIN_PROVIDER_STREAM_FAILED') return SUMMARIES.stream;
  return SUMMARIES.unknown;
}
