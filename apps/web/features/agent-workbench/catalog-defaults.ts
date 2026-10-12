import type { ComposerValue } from '@/features/agent-workbench/composer-types';
import type { ModelCatalogItem } from '@/lib/agent-api';

function defaultAvailable(items: ModelCatalogItem[]): ModelCatalogItem | undefined {
  return (
    items.find((item) => item.is_default && item.availability === 'available') ??
    items.find((item) => item.availability === 'available')
  );
}

export function catalogDefaultChanges(input: {
  brainModels: ModelCatalogItem[];
  composer: ComposerValue;
  imageModels: ModelCatalogItem[];
  requireExplicitSelection: boolean;
  videoModels: ModelCatalogItem[];
}): Partial<ComposerValue> {
  const changes: Partial<ComposerValue> = {};

  if (!input.requireExplicitSelection) {
    const brainModel = defaultAvailable(input.brainModels);
    const imageModel = defaultAvailable(input.imageModels);
    if (!input.composer.selectedBrainModelId && brainModel) {
      changes.selectedBrainModelId = brainModel.id;
      changes.selectedBrainModelVersion = brainModel.version_no;
    }
    if (!input.composer.selectedImageModelId && imageModel) {
      changes.selectedImageModelId = imageModel.id;
      changes.selectedImageModelVersion = imageModel.version_no;
    }
  }

  if (input.videoModels.length === 0 && input.composer.agentMode === 'video') {
    changes.agentMode = 'image';
  }

  return changes;
}
