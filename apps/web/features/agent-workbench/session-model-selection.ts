import type { ComposerValue } from '@/features/agent-workbench/composer-types';
import type { ModelCatalogItem, PublicTurn } from '@/lib/agent-api';

type ModelChoices = Pick<
  ComposerValue,
  | 'selectedBrainModelId'
  | 'selectedBrainModelVersion'
  | 'selectedImageModelId'
  | 'selectedImageModelVersion'
>;

export function restoreSessionModelSelection(input: {
  brainModels: ModelCatalogItem[];
  composer: ModelChoices;
  imageModels: ModelCatalogItem[];
  turns: Pick<PublicTurn, 'model_selection'>[];
}): { choices: ModelChoices; requireExplicitSelection: boolean } {
  const selection = input.turns.at(-1)?.model_selection;
  function restore(
    cachedId: string | null,
    cachedVersion: number | null | undefined,
    previous: { catalog_entry_id: string; version_no: number } | undefined,
    models: ModelCatalogItem[],
  ) {
    const id = cachedId ?? previous?.catalog_entry_id;
    if (!id) return { id: null, version: null, invalid: false };
    const model = models.find((item) => item.id === id);
    const version =
      cachedVersion ??
      (previous?.catalog_entry_id === id ? previous.version_no : model?.version_no);
    const available = model?.availability === 'available' && model.version_no === version;
    // Retain invalid choices so a refresh cannot silently replace them with defaults.
    return { id, version: version ?? null, invalid: !available };
  }

  const brain = restore(
    input.composer.selectedBrainModelId,
    input.composer.selectedBrainModelVersion,
    selection?.brain,
    input.brainModels,
  );
  const image = restore(
    input.composer.selectedImageModelId,
    input.composer.selectedImageModelVersion,
    selection?.image,
    input.imageModels,
  );
  return {
    choices: {
      selectedBrainModelId: brain.id,
      selectedBrainModelVersion: brain.version,
      selectedImageModelId: image.id,
      selectedImageModelVersion: image.version,
    },
    requireExplicitSelection: brain.invalid || image.invalid,
  };
}
