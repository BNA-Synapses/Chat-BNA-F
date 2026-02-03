// ================================
//  MEMÓRIA (STM/RAM)
//  - histórico estilo chat: [{ role, content }]
//  - por estado: key = ${userId}:${state}
//  - global: key = ${userId}:global
// ================================

const STORE = new Map();       // key -> [{ role, content, ts }]
const USER_STATE = new Map();  // userId -> lastState

const TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_ITEMS = 30;          // limite por key

function now() {
  return Date.now();
}

function normalizeState(state) {
  return (state && String(state).trim()) ? String(state).trim() : 'auto';
}

function normalizeUserId(userId) {
  const uid = Number(userId);
  return Number.isFinite(uid) ? uid : 1;
}

function makeKey(userId, state = 'auto') {
  const uid = normalizeUserId(userId);
  return `${uid}:${normalizeState(state)}`;
}

function makeGlobalKey(userId) {
  const uid = normalizeUserId(userId);
  return `${uid}:global`;
}

function cleanupKey(key) {
  const list = STORE.get(key);
  if (!list || list.length === 0) return;

  const t = now();
  const filtered = list.filter(item => (t - item.ts) <= TTL_MS);

  if (filtered.length === 0) STORE.delete(key);
  else STORE.set(key, filtered.slice(-MAX_ITEMS));
}

function cleanupAll() {
  for (const key of STORE.keys()) cleanupKey(key);
}

function normalizeChatItem(item) {
  if (typeof item === 'string') {
    return { role: 'user', content: item };
  }
  if (!item || typeof item !== 'object') {
    return { role: 'user', content: String(item ?? '') };
  }
  const role = item.role || item.type || 'user';
  const content = item.content ?? item.message ?? item.text ?? '';
  return { role, content: String(content) };
}

// ---------- API por KEY ----------
function addByKey(key, item) {
  if (!key) return;
  cleanupKey(key);

  const msg = normalizeChatItem(item);
  const list = STORE.get(key) || [];
  list.push({ ...msg, ts: now() });

  STORE.set(key, list.slice(-MAX_ITEMS));
}

function getByKey(key) {
  if (!key) return [];
  cleanupKey(key);
  const list = STORE.get(key) || [];
  return list.map(({ role, content }) => ({ role, content }));
}

function clearByKey(key) {
  if (!key) return;
  STORE.delete(key);
}

// ---------- API por USER (por estado) ----------
function add(userId, item, state = 'auto') {
  const key = makeKey(userId, state);
  addByKey(key, item);
}

function get(userId, state = 'auto') {
  const key = makeKey(userId, state);
  return getByKey(key);
}

function clear(userId, state = 'auto') {
  const key = makeKey(userId, state);
  clearByKey(key);
}

// ---------- GLOBAL ----------
function addGlobal(userId, item) {
  const key = makeGlobalKey(userId);
  addByKey(key, item);
}

function getGlobal(userId) {
  const key = makeGlobalKey(userId);
  return getByKey(key);
}

function clearGlobal(userId) {
  const key = makeGlobalKey(userId);
  clearByKey(key);
}

// ---------- Controle do estado ----------
function setUserState(userId, state) {
  const uid = normalizeUserId(userId);
  USER_STATE.set(uid, normalizeState(state));
}

function getUserState(userId) {
  const uid = normalizeUserId(userId);
  return USER_STATE.get(uid) || 'auto';
}

// ================================
//  MEMORY PACK (MTM + LTM)
// ================================

const { getMPT } = require('./memoryMid');
const { getLTM } = require('./memoryLong');

async function buildMemoryPack(userId) {
  const uid = normalizeUserId(userId);

  let mtm = '';
  let ltm = '';

  try { mtm = (await getMPT(uid)) || ''; } catch (_) {}
  try { ltm = (await getLTM(uid)) || ''; } catch (_) {}

  mtm = String(mtm).trim();
  ltm = String(ltm).trim();

  if (!mtm && !ltm) return '';

  return `
🧠 MEMÓRIA DO ALUNO (uso interno — não mencionar explicitamente)

MTM (hoje):
${mtm || '(sem dados hoje)'}

LTM (histórico):
${ltm || '(sem histórico suficiente)'}

Diretriz de uso:
- Use essas informações apenas para ajustar nível, exemplos, ritmo e escolha de exercícios.
- Se não for relevante para a pergunta atual, ignore completamente.
- Não invente fatos além do que está escrito aqui. Se faltar dado, pergunte.
`.trim();
}

module.exports = {
  add,
  get,
  clear,
  addGlobal,
  getGlobal,
  clearGlobal,
  makeKey,
  addByKey,
  getByKey,
  clearByKey,
  setUserState,
  getUserState,
  cleanupAll,
  buildMemoryPack,
};
