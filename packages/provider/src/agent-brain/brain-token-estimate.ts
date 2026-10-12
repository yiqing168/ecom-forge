import type { AgentBrainModelSnapshot } from '@ecom-forge/agent';
import { getEncoding } from 'js-tiktoken';

let openAiEncoding: ReturnType<typeof getEncoding> | undefined;

/** Unknown tokenizers must not inherit an English-only bytes/4 assumption. */
export function estimateBrainTextTokens(text: string, model?: AgentBrainModelSnapshot): number {
  if (
    model?.protocol_family === 'openai' &&
    /^(?:gpt-(?:4\.1|4o|5)(?:[.-]|$)|o[134](?:-|$))/.test(model.model_id)
  ) {
    openAiEncoding ??= getEncoding('o200k_base');
    return openAiEncoding.encode(text, [], []).length;
  }
  return Buffer.byteLength(text, 'utf8');
}

function fit(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))] as const;
}

/** Auto image detail is the wire default; inspection detail only controls payload dimensions. */
export function estimateBrainImageTokens(
  width: number,
  height: number,
  model?: AgentBrainModelSnapshot,
): number {
  const id = model?.model_id ?? '';
  if (model?.protocol_family === 'google' && /^gemini-/.test(id)) {
    if (width <= 384 && height <= 384 && !/^gemini-3/.test(id)) return 258;
    const crop = Math.max(1, Math.floor(Math.min(width, height) / 1.5));
    // Gemini 3 also has resolution-based image budgets; reserve the higher allowance.
    return Math.max(2_240, Math.ceil(width / crop) * Math.ceil(height / crop) * 258);
  }
  if (model?.protocol_family === 'anthropic' && /^claude-/.test(id)) {
    const [w, h] = fit(width, height, 1_568);
    return 1_024 + Math.ceil((w * h) / 750);
  }
  if (model?.protocol_family === 'openai') {
    const tile = /^gpt-4o-mini(?:-|$)/.test(id)
      ? { base: 2_833, tokens: 5_667 }
      : /^gpt-(?:4o|4\.1)(?:-|$)/.test(id) && !/^gpt-4\.1-(?:mini|nano)/.test(id)
        ? { base: 85, tokens: 170 }
        : /^gpt-(?:5|5\.1)(?:-|$)/.test(id) && !/^gpt-5-(?:mini|nano)/.test(id)
          ? { base: 70, tokens: 140 }
          : /^o[13](?:-|$)/.test(id)
            ? { base: 75, tokens: 150 }
            : undefined;
    if (tile) {
      let [w, h] = fit(width, height, 2_048);
      const scale = Math.min(1, 768 / Math.min(w, h));
      w = Math.max(1, Math.floor(w * scale));
      h = Math.max(1, Math.floor(h * scale));
      return tile.base + Math.ceil(w / 512) * Math.ceil(h / 512) * tile.tokens;
    }
    const patch = /^gpt-(?:5\.6-(?:sol|terra|luna)|6-astra)(?:-|$)/.test(id)
      ? { edge: 65_535, budget: 30_000, multiplier: 1.2 }
      : /^gpt-5\.5(?:-|$)/.test(id)
        ? { edge: 6_000, budget: 10_000, multiplier: 1.2 }
        : /^gpt-5\.4(?:-|$)/.test(id)
          ? { edge: 2_048, budget: 2_500, multiplier: 1.2 }
          : /^gpt-5\.2(?:-|$)/.test(id)
            ? { edge: 2_048, budget: 6_144, multiplier: 1.2 }
            : /^gpt-4\.1-mini(?:-|$)/.test(id)
              ? { edge: 2_048, budget: 6_144, multiplier: 1.62 }
              : /^gpt-4\.1-nano(?:-|$)/.test(id)
                ? { edge: 2_048, budget: 1_536, multiplier: 2.46 }
                : /^o4-mini(?:-|$)/.test(id)
                  ? { edge: 2_048, budget: 1_536, multiplier: 1.72 }
                  : /^gpt-5-(?:mini|nano)(?:-|$)/.test(id)
                    ? { edge: 2_048, budget: 1_536, multiplier: id.includes('-nano') ? 1.5 : 1.2 }
                    : undefined;
    if (patch) {
      const [w, h] = fit(width, height, patch.edge);
      const patches = Math.min(patch.budget, Math.ceil(w / 32) * Math.ceil(h / 32));
      // Capping at the published patch budget is conservative when resize rounding reduces it.
      return Math.ceil(patches * patch.multiplier) + 1;
    }
  }
  // Unknown relay model: keep a conservative fallback instead of assuming another model's fees.
  return 1_024 + Math.ceil(width / 512) * Math.ceil(height / 512) * 512;
}
