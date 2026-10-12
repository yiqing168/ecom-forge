import {
  parseCreativeDirectionSelection,
  parseSessionCreativeDirectionSnapshot,
} from '@ecom-forge/shared/creative-direction';
import type { ComposerValue } from './composer-types';
import type { PublicTurn } from '@/lib/agent-api';

export function restoreSessionCreativeDirection(
  _cached: ComposerValue['creativeDirection'],
  turns: Pick<PublicTurn, 'generation_preferences'>[],
  snapshot?: unknown,
): ComposerValue['creativeDirection'] {
  const previous = turns.at(-1)?.generation_preferences?.creative_direction;
  if (snapshot !== undefined)
    return parseSessionCreativeDirectionSnapshot(snapshot)?.selection ?? null;
  return parseCreativeDirectionSelection(previous !== undefined ? previous : { mode: 'native' });
}
