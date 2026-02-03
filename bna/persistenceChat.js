// =======================================
// persistenceChat.js — V2 Persistência (CHAT) — REINO 2 (MTM robusto)
// BrainMode
// =======================================
//
// MTM (24h TTL):
// - mtm:last_topic
// - mtm:last_summary (resumo rolante curto)
//
// READ PATH (Memory Pack):
// - LTM: pref:* / goal:*
// - MTM: last_topic/last_summary (se atual <= TTL)
// - Fallback: últimos N turnos do chat_events (se MTM ausente)
//
// Compat:
// - Usa ./db/connection (se existir). Se não existir, falha "soft".
//

const MTM_TTL_HOURS = 24;

function normalizeDbRows(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  if (Array.isArray(result)) return result;
  return [];
}

function getDb() {
  try {
    const conn = require('../db/connection');
    if (conn && typeof conn.query === 'function') return conn;
    if (conn && conn.pool && typeof conn.pool.query === 'function') {
      return { query: (...args) => conn.pool.query(...args) };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function ensureChatTables(db) {
  const createChatEvents = `
    CREATE TABLE IF NOT EXISTS chat_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      user_text TEXT NOT NULL,
      assistant_text TEXT NOT NULL,
      meta_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_chat_events_user_time (user_id, created_at)
    );
  `;
  await db.query(createChatEvents);

  // Garante unicidade de (user_id, mem_key) em user_ltm pra UPSERT ser estável.
  try {
    await db.query(`ALTER TABLE user_ltm ADD UNIQUE KEY uq_user_mem (user_id, mem_key);`);
  } catch (_) {}
}

function extractLtmCandidates(userText = '') {
  const low = String(userText || '').trim().toLowerCase();
  const out = [];

  if (
    low.includes('prefiro passo a passo') ||
    low.includes('prefiro passo-a-passo') ||
    low.includes('explica passo a passo') ||
    low.includes('passo a passo')
  ) {
    out.push({ mem_key: 'pref:explanation_style', mem_value: 'prefere passo a passo', confidence: 0.75, source: 'chat' });
  }

  if (low.includes('prefiro exemplos') || low.includes('me dá exemplos') || low.includes('me de exemplos')) {
    out.push({ mem_key: 'pref:examples', mem_value: 'prefere exemplos', confidence: 0.70, source: 'chat' });
  }

  const goalMatch = low.match(/(quero|objetivo|meta)\s+(aprender|estudar|dominar)\s+(.{3,80})/i);
  if (goalMatch) {
    out.push({ mem_key: 'goal:primary', mem_value: goalMatch[3].trim(), confidence: 0.70, source: 'chat' });
  }

  return out.slice(0, 5);
}

function looksLikePreference(userText='') {
  const low = String(userText||'').toLowerCase();
  return (
    low.includes('prefiro') ||
    low.includes('passo a passo') ||
    low.includes('me dá exemplos') ||
    low.includes('me de exemplos')
  );
}

function inferLastTopic(userText='') {
  const t = String(userText||'').trim();
  if (!t || t.length < 6) return null;

  if (looksLikePreference(t)) return null;

  const first = t.split(/[.?!\n]/)[0].trim();
  const topic = (first || t).replace(/\s+/g,' ').slice(0, 80);

  if (/^(oi|ol[áa]|tudo bem|e[ae]i)\b/i.test(topic)) return null;
  return topic;
}

function buildRollingSummary(prevSummary, userText, assistantText) {
  const u = String(userText||'').trim().replace(/\s+/g,' ').slice(0, 160);
  const a = String(assistantText||'').trim().replace(/\s+/g,' ').slice(0, 160);
  const chunk = `U: ${u}\nA: ${a}`;
  const base = prevSummary ? String(prevSummary).trim() : '';
  const combined = base ? (base + '\n' + chunk) : chunk;
  return combined.slice(-800); // mantém curto
}

async function upsertUserMem(db, userId, { mem_key, mem_value, confidence = 0.6, source = 'chat' }) {
  const sql = `
    INSERT INTO user_ltm (user_id, mem_key, mem_value, confidence, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      mem_value = VALUES(mem_value),
      confidence = GREATEST(confidence, VALUES(confidence)),
      source = VALUES(source),
      updated_at = NOW();
  `;
  await db.query(sql, [userId, mem_key, mem_value, confidence, source]);
}

async function getUserMemValue(db, userId, memKey) {
  try {
    const result = await db.query(
      `SELECT mem_value FROM user_ltm WHERE user_id = ? AND mem_key = ? LIMIT 1`,
      [userId, memKey]
    );
    const rows = normalizeDbRows(result);
    return rows && rows[0] ? rows[0].mem_value : null;
  } catch (_) {
    return null;
  }
}

async function fetchUserMemRows(db, userId, limit = 14) {
  const result = await db.query(
    `SELECT mem_key, mem_value, confidence, source, updated_at,
            TIMESTAMPDIFF(HOUR, updated_at, NOW()) AS age_hours
     FROM user_ltm
     WHERE user_id = ?
     ORDER BY
       CASE
         WHEN mem_key LIKE 'pref:%' THEN 0
         WHEN mem_key LIKE 'goal:%' THEN 1
         WHEN mem_key LIKE 'mtm:%' THEN 2
         ELSE 3
       END,
       updated_at DESC
     LIMIT ?`,
    [userId, Number(limit) || 14]
  );
  return normalizeDbRows(result) || [];
}

async function fetchRecentTurns(db, userId, turns = 6) {
  const result = await db.query(
    `SELECT user_text, assistant_text, created_at
     FROM chat_events
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, Number(turns) || 6]
  );
  const rows = normalizeDbRows(result) || [];
  return rows.reverse();
}

// -----------------------------
// Public API
// -----------------------------
async function storeChatTurn(userId, userText, assistantText, meta = {}) {
  const db = getDb();
  if (!db) return { ok: false, reason: 'db_not_configured' };

  await ensureChatTables(db);

  const metaJson = meta && Object.keys(meta).length ? JSON.stringify(meta) : null;

  // 1) Evento bruto (histórico)
  await db.query(
    `INSERT INTO chat_events (user_id, user_text, assistant_text, meta_json) VALUES (?, ?, ?, ?)`,
    [userId, String(userText || ''), String(assistantText || ''), metaJson]
  );

  // 2) LTM (preferências/metas)
  const ltm = extractLtmCandidates(userText);
  for (const c of ltm) await upsertUserMem(db, userId, c);

  // 3) MTM (último assunto + resumo rolante)
  const topic = inferLastTopic(userText);
  if (topic) {
    await upsertUserMem(db, userId, { mem_key: 'mtm:last_topic', mem_value: topic, confidence: 0.55, source: 'chat' });
  }

  const prev = await getUserMemValue(db, userId, 'mtm:last_summary');
  const summary = buildRollingSummary(prev, userText, assistantText);
  await upsertUserMem(db, userId, { mem_key: 'mtm:last_summary', mem_value: summary, confidence: 0.55, source: 'chat' });

  return { ok: true, ltm_written: ltm.length, mtm_topic: topic ? 1 : 0, mtm_summary: 1 };
}

async function loadUserContext(userId, opts = {}) {
  const db = getDb();
  if (!db) return null;

  const ltmLimit = Number(opts.ltmLimit || 14);
  const recentTurns = Number(opts.recentTurns || 6);

  try {
    const rows = await fetchUserMemRows(db, userId, ltmLimit);

    // Separar LTM e MTM (com TTL)
    const ltmLines = [];
    let mtmTopic = null;
    let mtmSummary = null;

    for (const r of rows) {
      const key = String(r.mem_key || '');
      const age = Number(r.age_hours ?? 9999);

      if (key === 'mtm:last_topic' && age <= MTM_TTL_HOURS) mtmTopic = String(r.mem_value || '');
      else if (key === 'mtm:last_summary' && age <= MTM_TTL_HOURS) mtmSummary = String(r.mem_value || '');
      else if (key.startsWith('pref:') || key.startsWith('goal:')) {
        ltmLines.push(`- ${key}: ${String(r.mem_value || '').slice(0, 140)} (conf ${Number(r.confidence || 0).toFixed(2)})`);
      }
    }

    // fallback se MTM expirou
    let recentBlock = null;
    if (!mtmSummary) {
      const turns = await fetchRecentTurns(db, userId, recentTurns);
      if (turns.length) {
        const parts = turns.map(t => {
          const u = String(t.user_text || '').trim().replace(/\s+/g,' ').slice(0, 160);
          const a = String(t.assistant_text || '').trim().replace(/\s+/g,' ').slice(0, 160);
          return `U: ${u}\nA: ${a}`;
        });
        recentBlock = `CONTEXTO RECENTE (últimos turnos):\n${parts.join('\n\n')}`;
      }
    }

    const blocks = [];

    if (ltmLines.length) {
      blocks.push(`MEMÓRIA DO USUÁRIO (uso interno):\n${ltmLines.join('\n')}`);
    }

    if (mtmTopic || mtmSummary) {
      const b = [];
      if (mtmTopic) b.push(`TÓPICO ATUAL: ${mtmTopic}`);
      if (mtmSummary) b.push(`RESUMO RECENTE:\n${mtmSummary.slice(0, 900)}`);
      blocks.push(`ESTADO RECENTE (24h):\n${b.join('\n')}`);
    } else if (recentBlock) {
      blocks.push(recentBlock);
    }

    if (!blocks.length) return null;
    return blocks.join('\n\n');
  } catch (_) {
    return null;
  }
}

module.exports = { storeChatTurn, loadUserContext, MTM_TTL_HOURS };
