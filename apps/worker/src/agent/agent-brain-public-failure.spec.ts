import type { AgentBrainDiagnostic } from '@ecom-forge/agent';
import { describe, expect, it } from 'vitest';

import { agentBrainPublicFailure } from './agent-brain-public-failure.js';

describe('agentBrainPublicFailure', () => {
  it.each<{ diagnostic: AgentBrainDiagnostic; expected: string }>([
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 429 },
      expected: '请求过于频繁',
    },
    { diagnostic: { code: 'AGENT_BRAIN_PROVIDER_TIMEOUT' }, expected: '响应超时' },
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 504 },
      expected: '响应超时',
    },
    { diagnostic: { code: 'AGENT_BRAIN_PROVIDER_NETWORK_FAILED' }, expected: '连接异常' },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED',
        providerErrorCode: 'context_length_exceeded',
        statusCode: 400,
      },
      expected: '超过推理模型容量',
    },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED',
        providerErrorCode: 'insufficient_quota',
        statusCode: 429,
      },
      expected: '通道额度不足',
    },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED',
        providerErrorCode: 'invalid_api_key',
        statusCode: 400,
      },
      expected: '通道配置异常',
    },
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_AUTH_FAILED', statusCode: 403 },
      expected: '通道配置异常',
    },
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 400 },
      expected: '未接受本次请求',
    },
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED', statusCode: 502 },
      expected: '服务暂时异常',
    },
    { diagnostic: { code: 'AGENT_BRAIN_PROVIDER_RESPONSE_INVALID' }, expected: '不完整或格式异常' },
    { diagnostic: { code: 'AGENT_BRAIN_PROVIDER_TOOL_INVALID' }, expected: '不完整或格式异常' },
    { diagnostic: { code: 'AGENT_BRAIN_PROVIDER_STREAM_FAILED' }, expected: '响应中途异常结束' },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_STREAM_FAILED',
        providerErrorType: 'rate_limit_error',
      },
      expected: '请求过于频繁',
    },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_STREAM_FAILED',
        providerErrorType: 'overloaded_error',
      },
      expected: '服务暂时异常',
    },
    {
      diagnostic: { code: 'AGENT_BRAIN_PROVIDER_STREAM_FAILED', providerErrorCode: 'timeout' },
      expected: '响应超时',
    },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED',
        providerErrorCode: 'model_not_found',
        statusCode: 404,
      },
      expected: '通道配置异常',
    },
    {
      diagnostic: {
        code: 'AGENT_BRAIN_PROVIDER_HTTP_FAILED',
        providerErrorCode: 'content_filter',
        statusCode: 400,
      },
      expected: '内容检查',
    },
  ])('projects only an actionable safe reason: $expected', ({ diagnostic, expected }) => {
    const summary = agentBrainPublicFailure('AGENT_BRAIN_CALL_OUTCOME_UNKNOWN', diagnostic);
    expect(summary).toContain(expected);
    expect(summary).toContain('请');
    expect(summary).not.toContain('AGENT_');
  });

  it.each([
    'AGENT_BRAIN_USAGE_UNTRUSTED',
    'AGENT_BRAIN_TERMINAL_OUTPUT_INVALID',
    'AGENT_SESSION_SUMMARY_INVALID',
  ])('explains an incomplete response without inventing a transport cause: %s', (code) => {
    expect(agentBrainPublicFailure(code)).toContain('不完整或格式异常');
  });

  it('does not infer context overflow from 400, or billing credit from channel quota', () => {
    expect(agentBrainPublicFailure('unknown', { code: 'unknown', statusCode: 400 })).not.toContain(
      '容量',
    );
    expect(
      agentBrainPublicFailure('unknown', {
        code: 'unknown',
        providerErrorCode: 'insufficient_quota',
      }),
    ).not.toContain('积分');
  });

  it('does not parse arbitrary error text or expose private diagnostic values', () => {
    const summary = agentBrainPublicFailure('private-error', {
      code: 'private-code',
      providerErrorCode: 'private-provider-code',
      providerErrorType: 'private-provider-type',
      networkErrorCode: 'private-network-code',
      detail: 'rate_limit_exceeded context_length_exceeded ETIMEDOUT private-message',
    });
    expect(summary).toBe(
      '未取得推理模型的完整响应，具体原因尚未确认；请稍后重新发送，或更换推理模型',
    );
    expect(agentBrainPublicFailure('AGENT_CALL_OUTCOME_UNKNOWN')).toBe(summary);
  });
});
