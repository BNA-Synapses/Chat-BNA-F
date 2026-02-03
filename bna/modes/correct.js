// mods/correct.js
// ======================================
// ❌ CORRECT MOD — correção de erro
// - Estado: ERRO_COMUMs
// - Identifica erro, explica por que acontece
// - Mostra correção e contraexemplo
// ======================================

const BrainContext = require('../brain/BrainContext');
const BrainStates = require('../brain/BrainState');
const memory = require('../memory/memory');
const { think } = require('../services/engine');

async function correct(userId, text) {
  // 1️⃣ Define estado cognitivo
  BrainContext.setState(BrainStates.ERRO_COMUM);

  // 2️⃣ Recupera histórico específico desse estado
  const history = memory.get(userId, BrainStates.ERRO_COMUM);

  // 3️⃣ Processa via engine
  const result = await think(text, history);

  // 4️⃣ Persiste na memória
  memory.add(userId, { role: 'user', content: text }, BrainStates.ERRO_COMUM);
  memory.add(
    userId,
    { role: 'assistant', content: result.response },
    BrainStates.ERRO_COMUM
  );

  // 5️⃣ Retorna resposta final
  return result.response;
}

module.exports = {
  correct,
};