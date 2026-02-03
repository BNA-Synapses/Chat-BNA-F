// =======================================
// feedbackClassifier.js — Classificação Cognitiva (A2)
// BrainMode V1
// =======================================

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function classifyFeedback(rawSignals = {}) {
  const text = rawSignals.text || {};
  const timing = rawSignals.timing || {};

  const confusion = !!text.confusion;
  const acknowledged = !!text.acknowledged;
  const repeated = !!text.repeatedQuestion;

  const timingSignal = timing.timingSignal || 'UNKNOWN';

  // TRAVADO vence
  if (
    (confusion && timingSignal === 'SLOW') ||
    (repeated && timingSignal !== 'OK') ||
    (repeated && confusion)
  ) {
    let strength = 0.9;
    if (confusion && repeated) strength += 0.1;
    return { outcome: 'TRAVADO', strength: clamp01(strength) };
  }

  // CONFUSO
  if (confusion || timingSignal === 'FAST') {
    let strength = 0.7;
    if (confusion && timingSignal === 'FAST') strength += 0.1;
    return { outcome: 'CONFUSO', strength: clamp01(strength) };
  }

  // FLUIDO
  let strength = 0.6;
  if (acknowledged && timingSignal === 'OK') strength += 0.1;
  return { outcome: 'FLUIDO', strength: clamp01(strength) };
}

module.exports = { classifyFeedback };
