// mods/recommended.js
// ======================================
// 🧭 RECOMMENDED MOD
// - Sugere próximos passos
// - Orienta estudo, prática ou decisão
// - Usa estado APLICACAO / REVISAO conforme contexto
// ======================================

const BrainContext = require('../brain/BrainContext');
const BrainStates = require('../brain/BrainState');
const memory = require('../memory/memory');
const { think } = require('../services/engine');

async function recommended(userId, text) {
  // 1️⃣ Estado cognitivo: recomendação é aplicação orientada
  BrainContext.setState(BrainStates.APLICACAO);

  // 2️⃣ Recupera histórico desse estado
  const history = memory.get(userId, BrainStates.APLICACAO);

  // 3️⃣ Gera resposta pelo engine
  const result = await think(text, history);

  // 4️⃣ Armazena interação na memória
  memory.add(userId, { role: 'user', content: text }, BrainStates.APLICACAO);
  memory.add(
    userId,
    { role: 'assistant', content: result.response },
    BrainStates.APLICACAO
  );

  // 5️⃣ Retorna somente a resposta final
  return result.response;
}

module.exports = {
  recommended,
};