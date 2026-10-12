import type { AgentBrainModelSnapshot, AgentBrainStepInput } from '@ecom-forge/agent';
import { describe, expect, it } from 'vitest';
import { estimateBrainImageTokens, estimateBrainTextTokens } from './brain-token-estimate.js';
import {
  estimateAgentBrainInputTokens,
  estimateAgentSessionCompactionInputTokens,
} from './vercel-ai-agent-brain.js';

const model = (protocol_family: string, model_id: string) =>
  ({ protocol_family, model_id }) as AgentBrainModelSnapshot;
describe('model-aware Brain token estimates', () => {
  it('counts Chinese text with a tokenizer rather than bytes/4 for known OpenAI models', () => {
    const text = '\u9f98'.repeat(1000);
    expect(estimateBrainTextTokens(text, model('openai', 'gpt-5.2'))).toBeGreaterThan(1000);
    expect(
      estimateBrainTextTokens('A short English sentence.', model('openai', 'gpt-4o')),
    ).toBeLessThan(20);
    expect(estimateBrainTextTokens('<|endoftext|>', model('openai', 'gpt-5.2'))).toBeGreaterThan(0);
  });
  it('uses a UTF-8 byte upper bound for unknown tokenizers, including Chinese and emoji', () => {
    const text = '\u6444\u5f71\u521b\u4f5c\u{1F600}';
    expect(estimateBrainTextTokens(text, model('google', 'gemini-3-flash'))).toBe(
      Buffer.byteLength(text),
    );
  });
  it.each([
    ['gpt-4o', 765],
    ['gpt-4.1', 765],
    ['gpt-4o-mini', 25501],
    ['gpt-5.1', 630],
    ['gpt-5.2', 4917],
    ['gpt-5.4', 3001],
    ['gpt-5.5', 12001],
    ['gpt-5.6-sol', 19662],
    ['gpt-4.1-mini', 6637],
  ])('uses published auto-detail rules for %s, not one universal tile cost', (id, expected) => {
    expect(estimateBrainImageTokens(4096, 4096, model('openai', id))).toBe(expected);
  });
  it('bounds Gemini and Anthropic images separately and retains unknown-model fallback', () => {
    expect(estimateBrainImageTokens(4096, 4096, model('google', 'gemini-3-flash'))).toBe(2240);
    expect(estimateBrainImageTokens(384, 384, model('google', 'gemini-2.5-flash'))).toBe(258);
    expect(
      estimateBrainImageTokens(4096, 4096, model('anthropic', 'claude-sonnet-4')),
    ).toBeLessThan(5000);
    expect(estimateBrainImageTokens(4096, 4096, model('openai', 'unknown-relay'))).toBe(33792);
  });
  it.each([
    ['openai', 'gpt-5.2'],
    ['openai', 'gpt-4o'],
    ['google', 'gemini-3-flash'],
  ])('does not reject nine detailed images from tile inflation: %s/%s', (protocol, id) => {
    const images = Array.from({ length: 9 }, (_, i) => ({
      binding_key: `source:${i}`,
      width: 4096,
      height: 4096,
    }));
    const input = {
      authorized_images: images,
      materialized_image_binding_keys: images.map((image) => image.binding_key),
      materialized_image_details: Object.fromEntries(
        images.map((image) => [image.binding_key, 'detail']),
      ),
    } as unknown as AgentBrainStepInput;
    expect(estimateAgentBrainInputTokens(input, model(protocol, id))).toBeLessThan(272000);
    expect(estimateAgentBrainInputTokens(input)).toBeGreaterThan(272000);
  });
  it('uses the same text policy for summary and normal calls', () => {
    const input = { messages: [] };
    expect(
      estimateAgentSessionCompactionInputTokens(input, model('openai', 'gpt-5.2')),
    ).toBeLessThan(estimateAgentSessionCompactionInputTokens(input));
  });
});
