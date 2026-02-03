// bna/mtmManager.js
// V2.1 — MTM hardening: multi-slot + TTL real + dedup + smarter continuation detection.

const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }

function isGreeting(msg) {
  const t = String(msg||'').trim().toLowerCase();
  return /^(oi|olá|ola|eai|e aí|bom dia|boa tarde|boa noite)(\b|!|\.)/.test(t) ||
         /tudo bem\??$/.test(t) ||
         t.length <= 4;
}

function explicitContinue(msg) {
  const t = String(msg||'').toLowerCase();
  return /(vamos continuar|retomar|onde paramos|voltando|continua|continuar|retoma|retomar|segue|prosseguir)/.test(t);
}

function implicitContinue(msg) {
  // sem LLM: heurística barata
  const t = String(msg||'').trim().toLowerCase();
  if (t.length <= 18 && /^(entendi|ok|beleza|certo|e aí\??|e agora\??|mas\??|como\??)/.test(t)) return true;
  if (/(isso|aquilo|dessa parte|daquilo|como falei|como você disse|sobre isso|sobre aquilo)/.test(t)) return true;
  if (/\b(daí|então)\b/.test(t) && t.length < 40) return true;
  return false;
}

function hasTema(msg) {
  return /^\s*tema\s*:\s*/i.test(String(msg||''));
}

function wantsRetake(msg) {
  return explicitContinue(msg) || hasTema(msg) || implicitContinue(msg);
}

function topicFromMessage(msg) {
  const s = String(msg||'').trim();
  const m = s.match(/^\s*tema\s*:\s*(.+)$/i);
  if (m?.[1]) return m[1].trim().slice(0,120);
  // fallback: primeira frase
  return s.split(/[.\n!?]/)[0].trim().slice(0,120) || s.slice(0,120);
}

function lowQualityForTopic(msg) {
  const t = String(msg||'').trim().toLowerCase();
  if (isGreeting(t)) return true;
  if (/^(ok|beleza|valeu|kkk|hmm+|não entendi|nao entendi|entendi)$/i.test(t)) return true;
  if (t.length < 10) return true;
  return false;
}

function summaryFromTurn(userMsg, assistantMsg) {
  const a = String(userMsg||'').trim().replace(/\s+/g,' ').slice(0,160);
  const b = String(assistantMsg||'').trim().replace(/\s+/g,' ').slice(0,260);
  return `U:${a} | A:${b}`;
}

function hashText(s) {
  return crypto.createHash('sha1').update(String(s||''),'utf8').digest('hex');
}

async function getKey(pool, userId, key) {
  const [rows] = await pool.query(
    `SELECT mem_value, updated_at FROM user_ltm WHERE user_id=? AND mem_key=? LIMIT 1`,
    [userId, key]
  );
  if (!rows || !rows.length) return null;
  return { value: rows[0].mem_value, updated_at: rows[0].updated_at };
}

async function upsert(pool, userId, key, value, confidence=0.7, source='chat') {
  const v = String(value ?? '').slice(0,4000);
  const [upd] = await pool.query(
    `UPDATE user_ltm SET mem_value=?, confidence=?, source=?, updated_at=NOW() WHERE user_id=? AND mem_key=? LIMIT 1`,
    [v, confidence, source, userId, key]
  );
  if (!upd || upd.affectedRows===0) {
    await pool.query(
      `INSERT INTO user_ltm (user_id, mem_key, mem_value, confidence, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, key, v, confidence, source]
    );
  }
}

function ageHoursFromUpdated(updatedAt) {
  if (!updatedAt) return Infinity;
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 36e5;
}

async function readMTM(pool, userId) {
  const keys = [
    'mtm:focus_topic','mtm:secondary_topic','mtm:open_threads','mtm:session_goal',
    'mtm:last_summary','mtm:last_state','mtm:last_topic','mtm:last_summary_hash'
  ];
  const out = {};
  for (const k of keys) {
    try { const r = await getKey(pool,userId,k); if (r) out[k]=r; } catch(_) {}
  }
  return out;
}

function buildMTMContext(mtmObj, allowFull) {
  // mtmObj: {key:{value,updated_at}}
  const safe = (k)=> String(mtmObj?.[k]?.value||'').trim();
  const age = (k)=> ageHoursFromUpdated(mtmObj?.[k]?.updated_at);

  // TTL real: se >24h, só entra se allowFull
  const ttlOk = (k)=> allowFull || age(k) <= 24;

  const focus = ttlOk('mtm:focus_topic') ? safe('mtm:focus_topic') : '';
  const secondary = ttlOk('mtm:secondary_topic') ? safe('mtm:secondary_topic') : '';
  const goal = ttlOk('mtm:session_goal') ? safe('mtm:session_goal') : '';
  const state = ttlOk('mtm:last_state') ? safe('mtm:last_state') : '';
  const summary = (allowFull && safe('mtm:last_summary')) ? safe('mtm:last_summary') : '';

  let threads = '';
  if (ttlOk('mtm:open_threads')) {
    try {
      const arr = JSON.parse(safe('mtm:open_threads')||'[]');
      if (Array.isArray(arr) && arr.length) threads = arr.slice(0,3).join(', ');
    } catch(_) {}
  }

  const lines = [];
  if (focus) lines.push(`Focus: ${focus}`);
  if (secondary) lines.push(`Secondary: ${secondary}`);
  if (threads) lines.push(`Threads: ${threads}`);
  if (goal) lines.push(`SessionGoal: ${goal}`);
  if (state) lines.push(`Mode: ${state}`);
  if (summary) lines.push(`LastSummary: ${summary}`);

  return lines.join('\n');
}

async function updateMTMAfterTurn(pool, userId, userMsg, assistantMsg, finalState) {
  // state always
  if (finalState) await upsert(pool,userId,'mtm:last_state',finalState,0.85,'chat');

  // Topic slots
  if (!lowQualityForTopic(userMsg)) {
    const newTopic = topicFromMessage(userMsg);

    // focus topic update only if explicit Tema: or no focus yet
    const focusRow = await getKey(pool,userId,'mtm:focus_topic');
    const hasFocus = Boolean(focusRow?.mem_value || focusRow?.value);
    const shouldSetFocus = hasTema(userMsg) || !hasFocus;

    if (shouldSetFocus) {
      // shift old focus to secondary
      if (hasFocus) {
        const oldFocus = String(focusRow.value || '').trim();
        if (oldFocus && oldFocus.toLowerCase() !== newTopic.toLowerCase()) {
          await upsert(pool,userId,'mtm:secondary_topic',oldFocus,0.6,'chat');
        }
      }
      await upsert(pool,userId,'mtm:focus_topic',newTopic,0.7,'chat');
      await upsert(pool,userId,'mtm:last_topic',newTopic,0.7,'chat'); // compat
    } else {
      // if message clearly indicates a new topic, store as secondary/thread
      const focus = String(focusRow.value || '').trim();
      if (focus && focus.toLowerCase() !== newTopic.toLowerCase()) {
        await upsert(pool,userId,'mtm:secondary_topic',newTopic,0.6,'chat');
      }
    }
  }

  // Summary dedup
  const sum = summaryFromTurn(userMsg, assistantMsg);
  const h = hashText(sum);
  const prev = await getKey(pool,userId,'mtm:last_summary_hash');
  const prevH = String(prev?.value || '').trim();
  if (h && h !== prevH) {
    await upsert(pool,userId,'mtm:last_summary',sum,0.65,'chat');
    await upsert(pool,userId,'mtm:last_summary_hash',h,0.95,'chat');
  }
}

module.exports = {
  isGreeting,
  wantsRetake,
  buildMTMContext,
  readMTM,
  updateMTMAfterTurn,
};
