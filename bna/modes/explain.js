// mods/explain.js
// ======================================
// 📘 EXPLAIN MOD — módulo de explicação
// - Define o estado EXPLICACAO no BrainContext
// - Reaproveita memória e engine para gerar a resposta
// ======================================s

const BrainContext = require('../brain/BrainContext');
const BrainStates = require('../brain/BrainState');
const memory = require('../memory/memory');
const { think } = require('../services/engine');

async function explain(userId, text) {
  // 1️⃣ Define o estado cognitivo como "explicação"
  BrainContext.setState(BrainStates.EXPLICACAO);

  // 2️⃣ Recupera o histórico do usuário
  const history = memory.get(userId, BrainStates.EXPLICACAO);

  // 3️⃣ Gera a resposta via engine
  const result = await think(text, history);

  // 4️⃣ Salva o turno na memória (para contexto futuro)
  memory.add(userId, { role: 'user', content: text }, BrainStates.EXPLICACAO);
  memory.add(userId, { role: 'assistant', content: result.response }, BrainStates.EXPLICACAO);

  // 5️⃣ Retorna a resposta processada
  return result.response;
}

module.exports = {
  explain,
};