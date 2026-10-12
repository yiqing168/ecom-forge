import { describe, expect, it } from 'vitest';

import type { ComposerValue } from '@/features/agent-workbench/composer-types';
import type { ModelCatalogItem } from '@/lib/agent-api';

import { catalogDefaultChanges } from './catalog-defaults';

const composer: ComposerValue = {
  agentMode: 'image',
  aspectRatio: '1:1',
  attachmentRoles: {},
  attachments: [],
  prompt: '',
  referencedAttachmentIds: [],
  resolutionTier: '1k',
  selectedBrainModelId: null,
  selectedImageModelId: null,
  selectedPresetIds: {},
  selectedSkillId: null,
  videoDuration: '5 秒',
  videoResolution: '1080P',
};

describe('catalogDefaultChanges', () => {
  it('does not dispatch null selections when ready catalogs are empty', () => {
    expect(
      catalogDefaultChanges({
        brainModels: [],
        composer,
        imageModels: [],
        requireExplicitSelection: false,
        videoModels: [],
      }),
    ).toEqual({});
  });

  it('selects the available defaults without replacing an explicit selection', () => {
    expect(
      catalogDefaultChanges({
        brainModels: [model('brain-default', 'brain', true)],
        composer: { ...composer, selectedImageModelId: 'chosen-image' },
        imageModels: [model('image-default', 'image', true)],
        requireExplicitSelection: false,
        videoModels: [],
      }),
    ).toEqual({ selectedBrainModelId: 'brain-default', selectedBrainModelVersion: 1 });
  });
});

function model(id: string, category: ModelCatalogItem['category'], isDefault: boolean) {
  return {
    id,
    public_slug: id,
    version_no: 1,
    category,
    display_name: id,
    description: '',
    public_capabilities: {},
    user_selectable: true,
    is_default: isDefault,
    availability: 'available' as const,
    pricing_summary: [],
  } satisfies ModelCatalogItem;
}
