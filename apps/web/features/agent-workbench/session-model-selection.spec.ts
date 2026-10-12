import { describe, expect, it } from 'vitest';

import type { ModelCatalogItem, PublicTurn } from '@/lib/agent-api';

import { restoreSessionModelSelection } from './session-model-selection';

const emptyChoices = { selectedBrainModelId: null, selectedImageModelId: null };
const brainModels = [model('brain-a', 'brain'), model('brain-b', 'brain')];
const imageModels = [model('image-a', 'image'), model('image-b', 'image')];

describe('restoreSessionModelSelection', () => {
  it('restores the most recent turn, not catalog defaults or an earlier turn', () => {
    const result = restoreSessionModelSelection({
      brainModels,
      imageModels,
      composer: emptyChoices,
      turns: [turn('a'), turn('b')],
    });
    expect(result).toEqual({
      choices: {
        selectedBrainModelId: 'brain-b',
        selectedBrainModelVersion: 1,
        selectedImageModelId: 'image-b',
        selectedImageModelVersion: 1,
      },
      requireExplicitSelection: false,
    });
  });

  it('prefers an unsent local choice while restoring the other category from the turn', () => {
    const result = restoreSessionModelSelection({
      brainModels,
      imageModels,
      composer: { ...emptyChoices, selectedBrainModelId: 'brain-b', selectedBrainModelVersion: 1 },
      turns: [turn('a')],
    });
    expect(result.choices.selectedBrainModelId).toBe('brain-b');
    expect(result.choices.selectedImageModelId).toBe('image-a');
    expect(result.requireExplicitSelection).toBe(false);
  });

  it.each(['unavailable', 'removed', 'version-changed'])(
    'requires explicit re-selection for a %s model without discarding its identity',
    (failure) => {
      const items =
        failure === 'removed'
          ? [brainModels[1]!]
          : [
              {
                ...brainModels[0]!,
                availability:
                  failure === 'unavailable' ? ('unavailable' as const) : ('available' as const),
                version_no: failure === 'version-changed' ? 2 : 1,
              },
              brainModels[1]!,
            ];
      const result = restoreSessionModelSelection({
        brainModels: items,
        imageModels,
        composer: emptyChoices,
        turns: [turn('a')],
      });
      expect(result.requireExplicitSelection).toBe(true);
      expect(result.choices.selectedBrainModelId).toBe('brain-a');
      expect(result.choices.selectedBrainModelVersion).toBe(1);
    },
  );

  it('keeps the cached version check even when the server snapshot has changed', () => {
    const result = restoreSessionModelSelection({
      brainModels: [model('brain-b', 'brain', 2)],
      imageModels,
      composer: { ...emptyChoices, selectedBrainModelId: 'brain-b', selectedBrainModelVersion: 1 },
      turns: [turn('a')],
    });
    expect(result.requireExplicitSelection).toBe(true);
    expect(result.choices.selectedBrainModelVersion).toBe(1);
  });

  it.each([{ turns: [] }, { turns: [{ model_selection: null }] }])(
    'allows defaults for a legacy session: %j',
    ({ turns }) => {
      const result = restoreSessionModelSelection({
        brainModels,
        imageModels,
        composer: emptyChoices,
        turns,
      });
      expect(result.choices.selectedBrainModelId).toBeNull();
      expect(result.choices.selectedImageModelId).toBeNull();
      expect(result.requireExplicitSelection).toBe(false);
    },
  );
});

function turn(suffix: string): Pick<PublicTurn, 'model_selection'> {
  return {
    model_selection: {
      catalog_revision: 7,
      brain: { catalog_entry_id: `brain-${suffix}`, version_no: 1, display_name: suffix },
      image: { catalog_entry_id: `image-${suffix}`, version_no: 1, display_name: suffix },
    },
  };
}

function model(id: string, category: ModelCatalogItem['category'], version = 1): ModelCatalogItem {
  return {
    id,
    public_slug: id,
    version_no: version,
    category,
    display_name: id,
    description: '',
    public_capabilities: {},
    user_selectable: true,
    is_default: true,
    availability: 'available',
    pricing_summary: [],
  };
}
