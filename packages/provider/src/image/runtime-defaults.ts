export const OPENAI_IMAGES_RUNTIME_DEFAULTS = Object.freeze({
  quality: 'high' as const,
  edgeStep: 16,
  maxEdge: 3_840,
  minPixels: 655_360,
  pixelBudgets: Object.freeze({
    '1k': 1_024 * 1_024,
    '2k': 2_048 * 2_048,
    '4k': 3_840 * 2_160,
  }),
});
