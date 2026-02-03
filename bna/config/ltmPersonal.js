/**
 * LTM Personal Memory – v3.5
 *
 * Two operational presets (keeping both, selectable by env):
 *   1) STRICT_OPT_IN (default): only store personal memory after explicit consent.
 *   2) SOFT_OPT_IN: allow implicit consent triggers (e.g., "lembra disso", "pode salvar")
 *      and store minimal facts; stories still depend on allow_story_storage.
 */

const PRESETS = {
  STRICT_OPT_IN: {
    mode: 'STRICT_OPT_IN',
    allowImplicitConsent: false,
    maxFactsPerDay: 12,
    minFactConfidence: 0.72,
    // Stories are never stored unless consent allows story storage.
    allowStoryWithoutExplicitStoryConsent: false,
    storyMinChars: 240,
  },
  SOFT_OPT_IN: {
    mode: 'SOFT_OPT_IN',
    allowImplicitConsent: true,
    maxFactsPerDay: 12,
    minFactConfidence: 0.62,
    // Still requires allow_story_storage = 1.
    allowStoryWithoutExplicitStoryConsent: false,
    storyMinChars: 240,
  },
};

function getPreset() {
  const key = String(process.env.LTM_PERSONAL_MODE || 'STRICT_OPT_IN').toUpperCase();
  return PRESETS[key] || PRESETS.STRICT_OPT_IN;
}

module.exports = {
  PRESETS,
  getPreset,
};
