// bna/memoryPack.js
// V2 — Reino 4 (READ PATH) — Memory Pack Unificado
//
// Objetivo:
// - Ler user_ltm + MTM (via persistenceChat) e devolver um pack curto e útil
// - Filtrar chaves técnicas (sys:* etc.)
// - Soft budget por seção (não explode contexto)
// - Funciona para 'chat' e 'exercise'
//
// Dependências opcionais:
// - ./db/connection (pool/query)
// - ./persistenceChat (para MTM/Contexto recente, se existir)

const DEFAULTS = {
  ltmLimit: 30,
  mtmRecentTurns: 6,
  // Soft budgets em caracteres
  budget: {
    ltm: 450,
    skills: 450,
    patterns: 350,
    goals: 250,
    mtm: 900
  }
};

function normalizeDbRows(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  if (Array.isArray(result)) return result;
  return [];
}

function getDb() {
  try {
    const conn = require('../../db/connection');
    if (conn && typeof conn.query === 'function') return conn;
    if (conn && conn.pool && typeof conn.pool.query === 'function') {
      return { query: (...args) => conn.pool.query(...args) };
    }
  } catch (_) {}
  return null;
}

function clampText(s, max) {
  const t = String(s || '').trim();
  if (!max || t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function takeBudgetedLines(lines, maxChars) {
  const out = [];
  let used = 0;
  for (const ln of lines) {
    const add = ln.length + 1;
    if (used + add > maxChars) break;
    out.push(ln);
    used += add;
  }
  return out;
}

function allowedKey(key) {
  if (!key) return false;
  if (key.startsWith('sys:')) return false;
  // allowlist
  return (
    key.startsWith('pref:') ||
    key.startsWith('goal:') ||
    key.startsWith('skill:') ||
    key.startsWith('pattern:') ||
    key.startsWith('difficulty:') ||
    key.startsWith('mtm:')
  );
}

function bucketKey(key) {
  if (key.startsWith('pref:')) return 'prefs';
  if (key.startsWith('goal:')) return 'goals';
  if (key.startsWith('skill:') || key.startsWith('difficulty:')) return 'skills';
  if (key.startsWith('pattern:')) return 'patterns';
  if (key.startsWith('mtm:')) return 'mtm';
  return 'other';
}

async function fetchUserLtm(db, userId, limit) {
  const res = await db.query(
    `SELECT mem_key, mem_value, confidence, source, updated_at
     FROM user_ltm
     WHERE user_id = ?
     ORDER BY updated_at DESC, confidence DESC
     LIMIT ?`,
    [userId, Number(limit) || DEFAULTS.ltmLimit]
  );
  return normalizeDbRows(res) || [];
}

// Preferimos usar a loadUserContext do persistenceChat para MTM porque ela já respeita TTL e fallback.
async function tryLoadMtmContext(userId, mode, opts) {
  try {
    const persistenceChat = require('../persistenceChat');
    if (persistenceChat && typeof persistenceChat.loadUserContext === 'function') {
      // Para exercise, ainda faz sentido usar o MTM do chat (estado recente do usuário)
      return await persistenceChat.loadUserContext(userId, {
        ltmLimit: 14,
        recentTurns: Number(opts.mtmRecentTurns || DEFAULTS.mtmRecentTurns)
      });
    }
  } catch (_) {}
  return null;
}

function formatSection(title, lines) {
  if (!lines || !lines.length) return null;
  return `${title}:\n${lines.join('\n')}`;
}

async function buildMemoryPack(userId, mode = 'chat', options = {}) {
  const db = getDb();
  const opts = { ...DEFAULTS, ...(options || {}) };
  const budget = { ...DEFAULTS.budget, ...(opts.budget || {}) };

  const blocks = [];

  // 1) LTM/skills/patterns/goals via user_ltm
  if (db) {
    try {
      const rows = await fetchUserLtm(db, userId, opts.ltmLimit);

      const buckets = { prefs: [], goals: [], skills: [], patterns: [] };

      for (const r of rows) {
        const key = String(r.mem_key || '');
        if (!allowedKey(key)) continue;

        const b = bucketKey(key);
        if (b === 'mtm') continue; // MTM vem pelo loader (TTL + fallback)
        if (!buckets[b]) continue;

        // Humaniza linha (sem chave técnica crua quando não precisa)
        let label = key;
        if (key.startsWith('pref:explanation_style')) label = 'preferência';
        else if (key.startsWith('pref:')) label = key.replace('pref:', 'pref ');
        else if (key.startsWith('goal:primary')) label = 'objetivo';
        else if (key.startsWith('goal:')) label = key.replace('goal:', 'meta ');
        else if (key.startsWith('skill:')) label = key.replace('skill:', '');
        else if (key.startsWith('difficulty:')) label = key.replace('difficulty:', 'dificuldade ');
        else if (key.startsWith('pattern:')) label = key.replace('pattern:', 'padrão ');

        const value = clampText(r.mem_value, 140);
        const line = `- ${label}: ${value}`;
        buckets[b].push(line);
      }

      // Aplica budgets por bucket
      const prefs = takeBudgetedLines(buckets.prefs, budget.ltm);
      const goals = takeBudgetedLines(buckets.goals, budget.goals);
      const skills = takeBudgetedLines(buckets.skills, budget.skills);
      const patterns = takeBudgetedLines(buckets.patterns, budget.patterns);

      // Ordenação de seções: prefs/goals primeiro (definem "como"), skills/patterns depois (definem "o quê")
      const s1 = formatSection('MEMÓRIA DO USUÁRIO (uso interno)', [...prefs, ...goals].slice(0, 20));
      if (s1) blocks.push(s1);

      const s2 = formatSection('PERFIL DE APRENDIZADO', [...skills, ...patterns].slice(0, 30));
      if (s2) blocks.push(s2);
    } catch (_) {
      // silêncio: pack ainda pode ter MTM via loader
    }
  }

  // 2) MTM/Contexto recente (TTL + fallback)
  const mtmCtx = await tryLoadMtmContext(userId, mode, opts);
  if (mtmCtx) {
    // mtmCtx já vem formatado com seções; só cortar no budget mtm
    blocks.push(clampText(mtmCtx, budget.mtm));
  }

  if (!blocks.length) return '';

  // 3) Pack final — não mencionar MTM/LTM explicitamente pro usuário (é interno)
  // O engine deve usar isso como system/internal context.
  return blocks.join('\n\n');
}

module.exports = { buildMemoryPack };
