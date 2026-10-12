import { describe, expect, it } from 'vitest';

import { isModelCatalogRolloutVisible } from './model-catalog.service.js';

const entryId = '11111111-1111-4111-8111-111111111111';

describe('model catalog rollout', () => {
  it('keeps zero-percent entries hidden and makes full local previews visible', () => {
    expect(
      isModelCatalogRolloutVisible({
        appEnv: 'local',
        entryId,
        userId: 'user-a',
        rollout: { stage: 'beta', percentage: 0 },
      }),
    ).toBe(false);
    expect(
      isModelCatalogRolloutVisible({
        appEnv: 'local',
        entryId,
        userId: 'user-a',
        rollout: { stage: 'beta', percentage: 100 },
      }),
    ).toBe(true);
  });

  it('fails closed when a deployed environment does not match the rollout stage', () => {
    expect(
      isModelCatalogRolloutVisible({
        appEnv: 'production',
        entryId,
        userId: 'user-a',
        rollout: { stage: 'beta', percentage: 100 },
      }),
    ).toBe(false);
    expect(
      isModelCatalogRolloutVisible({
        appEnv: 'beta',
        entryId,
        userId: 'user-a',
        rollout: { stage: 'beta', percentage: 100 },
      }),
    ).toBe(true);
  });

  it('assigns partial rollout buckets deterministically per user and entry', () => {
    const visibleUsers = Array.from({ length: 200 }, (_, index) =>
      isModelCatalogRolloutVisible({
        appEnv: 'beta',
        entryId,
        userId: `user-${index}`,
        rollout: { stage: 'beta', percentage: 25 },
      }),
    );
    expect(visibleUsers).toContain(true);
    expect(visibleUsers).toContain(false);
    expect(
      isModelCatalogRolloutVisible({
        appEnv: 'beta',
        entryId,
        userId: 'stable-user',
        rollout: { stage: 'beta', percentage: 25 },
      }),
    ).toBe(
      isModelCatalogRolloutVisible({
        appEnv: 'beta',
        entryId,
        userId: 'stable-user',
        rollout: { stage: 'beta', percentage: 25 },
      }),
    );
  });
});
