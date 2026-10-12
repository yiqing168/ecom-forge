import { describe, expect, it } from 'vitest';

import { contextActivitySummary } from './agent-turn-activity.repository.js';

describe('contextActivitySummary', () => {
  it('describes the first Brain round as understanding the request', () => {
    expect(contextActivitySummary({ completedBrainRounds: 0, followsImageInspection: false })).toBe(
      '正在理解你的需求',
    );
  });

  it('describes a Brain round after image inspection as image analysis', () => {
    expect(contextActivitySummary({ completedBrainRounds: 1, followsImageInspection: true })).toBe(
      '正在分析参考图片',
    );
  });

  it('describes a non-image follow-up round as continued thinking', () => {
    expect(contextActivitySummary({ completedBrainRounds: 1, followsImageInspection: false })).toBe(
      '正在继续思考',
    );
  });
});
