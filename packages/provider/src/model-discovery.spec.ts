import { describe, expect, it, vi } from 'vitest';

import { discoverRelayModels } from './model-discovery.js';

describe('discoverRelayModels', () => {
  it('keeps Google discovery on OpenAI models and Bearer authentication', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'gemini-test' }] }), { status: 200 }),
      );
    const result = await discoverRelayModels({
      apiKey: 'test-key-123456',
      baseUrl: 'https://relay.test.invalid',
      allowedRelayOrigins: ['https://relay.test.invalid'],
      protocolFamily: 'google',
      abortSignal: new AbortController().signal,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://relay.test.invalid/v1/models',
      expect.objectContaining({ headers: { authorization: 'Bearer test-key-123456' } }),
    );
    expect(result).toMatchObject({ status: 'passed', models: [{ id: 'gemini-test' }] });
  });
  it('adds the protocol path and returns a sorted unique model list', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'gpt-z', display_name: null },
              { id: 'gpt-a', display_name: 'A model' },
              { id: 'provider@image+preview', name: 'Image preview' },
              { object: 'model-without-id' },
              { id: 'gpt-z' },
            ],
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const result = await discoverRelayModels({
      apiKey: 'test-key-123456',
      baseUrl: 'https://relay.test.invalid',
      allowedRelayOrigins: ['https://relay.test.invalid'],
      protocolFamily: 'openai',
      abortSignal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://relay.test.invalid/v1/models',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(result).toMatchObject({
      status: 'passed',
      baseUrl: 'https://relay.test.invalid/v1',
      models: [
        { id: 'gpt-a', label: 'A model' },
        { id: 'gpt-z', label: 'gpt-z' },
        { id: 'provider@image+preview', label: 'Image preview' },
      ],
    });
  });

  it('does not append v1 twice when the configured address already includes it', async () => {
    let requestedUrl: string | URL | Request | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = url;
      requestedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), { status: 200 }),
      );
    });
    await discoverRelayModels({
      apiKey: 'test-key-123456',
      baseUrl: 'https://relay.test.invalid/v1/',
      allowedRelayOrigins: ['https://relay.test.invalid'],
      protocolFamily: 'anthropic',
      abortSignal: new AbortController().signal,
      fetchImpl,
    });

    expect(requestedUrl).toBe('https://relay.test.invalid/v1/models');
    expect(requestedInit?.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'test-key-123456',
    });
  });

  it('rejects credential failures without exposing the response body', async () => {
    const result = await discoverRelayModels({
      apiKey: 'test-key-123456',
      baseUrl: 'https://relay.test.invalid',
      allowedRelayOrigins: ['https://relay.test.invalid'],
      protocolFamily: 'openai',
      abortSignal: new AbortController().signal,
      fetchImpl: vi.fn(() =>
        Promise.resolve(new Response('secret provider error', { status: 401 })),
      ),
    });
    expect(result).toEqual({ status: 'failed', code: 'PROVIDER_CREDENTIAL_REJECTED' });
  });
});
