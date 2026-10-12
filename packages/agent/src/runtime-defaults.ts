// Storage format bounds, not creative-prompt targets or activation switches.
export const AGENT_TRANSCRIPT_LIMITS = Object.freeze({
  envelopeBytes: 64 * 1024,
  privatePayloadBytes: 8 * 1024 * 1024,
});
