import { describe, expect, it } from 'vitest';
import { restoreSessionCreativeDirection } from './session-creative-direction';

describe('session creative direction recovery', () => {
  it('uses the latest frozen turn, with native behavior for older sessions', () => {
    expect(restoreSessionCreativeDirection(undefined, [])).toEqual({ mode: 'native' });
    expect(
      restoreSessionCreativeDirection(undefined, [
        { generation_preferences: { creative_direction: { mode: 'auto', version: 1 } } },
        {
          generation_preferences: {
            creative_direction: { mode: 'profile', profile_id: 'human-story', version: 1 },
          },
        },
      ]),
    ).toEqual({ mode: 'profile', profile_id: 'human-story', version: 1 });
  });
  it('ignores a stale manual cache in favor of the submitted session selection', () => {
    expect(
      restoreSessionCreativeDirection({ mode: 'native' }, [
        { generation_preferences: { creative_direction: { mode: 'auto', version: 1 } } },
      ]),
    ).toEqual({ mode: 'auto', version: 1 });
  });
  it('restores the submitted v2 even when the cache still has v1', () => {
    const turns = [
      {
        generation_preferences: {
          creative_direction: { mode: 'auto' as const, version: 2 as const },
        },
      },
    ];
    expect(restoreSessionCreativeDirection(undefined, turns)).toEqual({ mode: 'auto', version: 2 });
    expect(restoreSessionCreativeDirection({ mode: 'auto', version: 1 }, turns)).toEqual({
      mode: 'auto',
      version: 2,
    });
  });
  it('ignores corrupt cache but rejects a corrupt authoritative snapshot', () => {
    expect(restoreSessionCreativeDirection(null, [])).toEqual({ mode: 'native' });
    expect(
      restoreSessionCreativeDirection(undefined, [
        { generation_preferences: { creative_direction: { mode: 'auto', version: 4 } } },
      ]),
    ).toBeNull();
    expect(restoreSessionCreativeDirection(undefined, [], { schema_version: 2 })).toBeNull();
    expect(
      restoreSessionCreativeDirection({ mode: 'native' }, [], {
        schema_version: 1,
        selection: { mode: 'auto', version: 3 },
      }),
    ).toEqual({ mode: 'auto', version: 3 });
  });
});
