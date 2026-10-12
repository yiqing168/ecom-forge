import { describe, expect, it, vi } from 'vitest';

import { AgentPublicDraft } from './agent-public-draft.js';

describe('AgentPublicDraft', () => {
  it('streams ordinary ratios, mentions and separators instead of treating them as secrets', async () => {
    const append = vi.fn().mockResolvedValue(true);
    const draft = new AgentPublicDraft([], append, vi.fn());
    await draft.accept('使用 @1 的人物，画幅为 3:4，可以先讨论构图/色彩。'.repeat(10));
    expect(append).toHaveBeenCalled();
    expect(draft.published).toBe(true);
  });

  it.each(['https://example.test/' + 'x'.repeat(180), 'api_key' + ' '.repeat(180)])(
    'holds incomplete sensitive prefixes even when they exceed the safety tail',
    async (prefix) => {
      const append = vi.fn().mockResolvedValue(true);
      const draft = new AgentPublicDraft([], append, vi.fn());
      await draft.accept(prefix);
      await draft.accept(prefix + '?token=abcdefghijklmnopqrstuv');
      expect(append).not.toHaveBeenCalled();
    },
  );
  it('publishes bounded real prefixes while retaining a safety tail', async () => {
    const chunks: string[] = [];
    const append = vi.fn((_sequence: number, delta: string) => {
      chunks.push(delta);
      return Promise.resolve(true);
    });
    const draft = new AgentPublicDraft([], append, vi.fn());
    await draft.accept('创意'.repeat(35));
    expect(chunks).toHaveLength(0);
    await draft.accept('创意'.repeat(40));
    expect(chunks).toEqual(['创意'.repeat(8)]);
    await draft.accept('创意'.repeat(130));
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe('创意'.repeat(64));
    expect(draft.published).toBe(true);
    await draft.accept('创意'.repeat(200));
    expect(append.mock.calls.map(([sequence]) => sequence)).toEqual([1, 2, 3]);
    expect(chunks.join('').length).toBeLessThan('创意'.repeat(200).length);
  });

  it('clears a published preview when later input reveals unsafe content', async () => {
    const clear = vi.fn().mockResolvedValue(undefined);
    const append = vi.fn().mockResolvedValue(true);
    const draft = new AgentPublicDraft([], append, clear);
    const safe = '画面'.repeat(130);
    await draft.accept(safe);
    expect(draft.published).toBe(true);
    await draft.accept(`${safe} api_key=abcdefghijklmnopqrstuv`);
    expect(clear).toHaveBeenCalledOnce();
    expect(draft.published).toBe(false);
    await draft.accept(`${safe} more text`);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('never emits private skill overlap or non-monotone partial JSON repairs', async () => {
    const append = vi.fn().mockResolvedValue(true);
    const clear = vi.fn().mockResolvedValue(undefined);
    const privateText = '独立出版物中的雪海与人物比例'.repeat(12);
    const draft = new AgentPublicDraft([privateText], append, clear);
    await draft.accept(privateText);
    expect(append).not.toHaveBeenCalled();
    const other = new AgentPublicDraft([], append, clear);
    await other.accept('方向'.repeat(130));
    await other.accept('另一段不同内容'.repeat(30));
    expect(clear).toHaveBeenCalledOnce();
  });

  it('does not publish a short private quotation embedded before a long safe suffix', async () => {
    const chunks: string[] = [];
    const append = vi.fn((_sequence: number, delta: string) => {
      chunks.push(delta);
      return Promise.resolve(true);
    });
    const privateText = '原始照片中的关键叙事关系应始终保持清晰可辨'.repeat(4);
    const quote = privateText.slice(3, 35);
    const draft = new AgentPublicDraft([privateText], append, vi.fn());
    await draft.accept('正常构图建议。'.repeat(20) + quote + '继续讨论配色。'.repeat(20));
    expect(chunks.join('')).not.toContain(quote);
    expect(append).not.toHaveBeenCalled();
  });

  it('retains enough normalized text to detect private overlap across whitespace-heavy chunks', async () => {
    const append = vi.fn().mockResolvedValue(true);
    const privateText = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
    const draft = new AgentPublicDraft([privateText], append, vi.fn());
    const prefix = 'word0' + ' '.repeat(200) + 'word1' + ' '.repeat(200);
    await draft.accept(prefix);
    expect(append).not.toHaveBeenCalled();
    await draft.accept(prefix + privateText.slice('word0 word1 '.length));
    expect(append).not.toHaveBeenCalled();
  });
});
