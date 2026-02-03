// bna/brain/detectMode.js
function detectMode(text) {
  const t = text.toLowerCase();

  if (t.includes('passo') || t.includes('como faço')) return 'step';
  if (t.includes('exercício') || t.includes('treinar')) return 'train';
  if (t.includes('revisa') || t.includes('confere')) return 'review';
  if (t.includes('erro') || t.includes('onde errei')) return 'common_errors';
  if (t.includes('prova') || t.includes('simulado')) return 'test';

  return 'explain';
}

module.exports = detectMode;