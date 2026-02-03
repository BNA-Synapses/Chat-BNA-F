// bna/ltmPolicy.js
// V2.1 — LTM hardening: confiança dinâmica + conflitos de preferência + orçamento de leitura.

function safeJsonParse(v) {
  try { return JSON.parse(v); } catch(_) { return null; }
}

function computeConfidenceFromSample(sample) {
  const s = Number(sample||0);
  if (s >= 20) return 0.9;
  if (s >= 10) return 0.8;
  if (s >= 5) return 0.7;
  return 0.6;
}

async function getLTM(pool, userId, key) {
  const [rows] = await pool.query(
    `SELECT mem_value, confidence, updated_at FROM user_ltm WHERE user_id=? AND mem_key=? LIMIT 1`,
    [userId, key]
  );
  if (!rows || !rows.length) return null;
  return rows[0];
}

async function upsert(pool, userId, key, value, confidence=0.7, source='policy') {
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

async function appendPrefHistory(pool, userId, prefKey, newValue) {
  const histKey = `pref:history:${prefKey}`;
  const row = await getLTM(pool, userId, histKey);
  let arr = [];
  if (row?.mem_value) {
    const parsed = safeJsonParse(row.mem_value);
    if (Array.isArray(parsed)) arr = parsed;
  }
  arr = arr.filter(x => x && x.value !== newValue);
  arr.unshift({ value: newValue, at: new Date().toISOString() });
  arr = arr.slice(0,3);
  await upsert(pool, userId, histKey, JSON.stringify(arr), 0.6, 'policy');
}

async function setPreference(pool, userId, prefKey, newValue) {
  // resolve conflitos: sempre o mais recente vence, mas guardamos histórico curto
  await upsert(pool, userId, `pref:${prefKey}`, newValue, 0.85, 'policy');
  await appendPrefHistory(pool, userId, prefKey, newValue);
}

async function updateSkillConfidence(pool, userId, bucket, skillObj) {
  // skillObj: {label, accuracy, sample}
  const key = `skill:${bucket}`;
  const prev = await getLTM(pool, userId, key);
  const base = computeConfidenceFromSample(skillObj?.sample);

  let newConf = base;
  if (prev && prev.confidence != null) {
    const old = Number(prev.confidence);
    if (Number.isFinite(old)) newConf = 0.7*old + 0.3*base;
  }
  await upsert(pool, userId, key, JSON.stringify(skillObj), Math.max(0.55, Math.min(0.95, newConf)), 'consolidation');
}

module.exports = { setPreference, updateSkillConfidence };
