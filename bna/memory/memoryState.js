// bna/memoryState.js
// Memória por estado (V1 simples, funcional e segura)

const memory = require('./memory'); // seu módulo atual (o que já lê/grava)
const BrainContext = require('../brain/BrainContext');

const STATE_KEY = (uid, state) => `brain:state:${uid}:${state}`;
const GLOBAL_KEY = (uid) => `brain:global:${uid}`;

// limites simples pra V1
const LIMIT_GLOBAL = 6;
const LIMIT_STATE = 10;

function normalizeTurn(role, content) {
  return { role, content: String(content ?? '').slice(0, 2000) };
}

async function pushGlobal(uid, role, content) {
  const key = GLOBAL_KEY(uid);
  const list = (await memory.get(key)) || [];
  list.push(normalizeTurn(role, content));
  await memory.set(key, list.slice(-LIMIT_GLOBAL));
}

async function pushState(uid, role, content, stateOverride = null) {
  const state = stateOverride || BrainContext.getState() || 'auto';
  const key = STATE_KEY(uid, state);
  const list = (await memory.get(key)) || [];
  list.push(normalizeTurn(role, content));
  await memory.set(key, list.slice(-LIMIT_STATE));
}

async function readGlobal(uid) {
  return (await memory.get(GLOBAL_KEY(uid))) || [];
}

async function readState(uid, stateOverride = null) {
  const state = stateOverride || BrainContext.getState() || 'auto';
  return (await memory.get(STATE_KEY(uid, state))) || [];
}

/**
 * Monta o history final:
 * - pega global
 * - pega state atual
 * - concatena (global primeiro, state depois)
 */
async function buildHistory(uid, stateOverride = null) {
  const [g, s] = await Promise.all([readGlobal(uid), readState(uid, stateOverride)]);
  return [...g, ...s];
}

module.exports = {
  pushGlobal,
  pushState,
  readGlobal,
  readState,
  buildHistory,
};