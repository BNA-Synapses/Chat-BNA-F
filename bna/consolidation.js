// bna/consolidation.js
// Bloco B3 — Consolidação forte: attempts -> user_ltm (skill:* / pattern:* / topic:*)
// Foco: robusto, sem quebrar se colunas não existirem.
// Estratégia:
// - Lê attempts recentes desde o último checkpoint sys:last_consolidation_attempt_id
// - Agrupa por tópico (se existir exercises.topic/type) ou por answer_type como fallback
// - Calcula acurácia e salva skill:<bucket> e topic:last_practiced:<bucket>
// - Padrões (pattern) aqui são "padrões estatísticos" (ex.: baixa acurácia, queda, etc.).
//
// Requisitos:
// - pool.query MySQL
// - Tabelas: attempts, exercises, user_ltm

async function upsertUserLTM(pool, userId, key, value, confidence = 0.7, source = "consolidation") {
  const v = String(value ?? "").slice(0, 4000);

  const [upd] = await pool.query(
    `UPDATE user_ltm
       SET mem_value = ?, confidence = ?, source = ?, updated_at = NOW()
     WHERE user_id = ? AND mem_key = ?
     LIMIT 1`,
    [v, confidence, source, userId, key]
  );

  if (!upd || upd.affectedRows === 0) {
    await pool.query(
      `INSERT INTO user_ltm (user_id, mem_key, mem_value, confidence, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [userId, key, v, confidence, source]
    );
  }
}

async function getLastConsolidationAttemptId(pool, userId) {
  const [rows] = await pool.query(
    `SELECT mem_value FROM user_ltm WHERE user_id = ? AND mem_key = 'sys:last_consolidation_attempt_id' LIMIT 1`,
    [userId]
  );
  if (!rows || rows.length === 0) return 0;
  const n = Number(rows[0].mem_value);
  return Number.isFinite(n) ? n : 0;
}

function bucketFromRow(r) {
  // Prefer topic, then type, then answer_type
  const t = (r.topic || "").trim();
  const ty = (r.type || r.exercise_type || "").trim();
  const at = (r.answer_type || "").trim();

  const raw = t || ty || at || "geral";
  // normalize key-safe
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_\-áàâãéêíóôõúç ]/gi, "")
    .replace(/\s+/g, "_")
    .slice(0, 60) || "geral";
}

function skillLabel(acc) {
  if (acc >= 0.85) return "forte";
  if (acc >= 0.65) return "medio";
  return "fraco";
}

async function consolidateUser(pool, userId, opts = {}) {
  const minNewAttempts = Number(opts.minNewAttempts ?? 5);
  const maxScan = Number(opts.maxScan ?? 80);

  const lastId = await getLastConsolidationAttemptId(pool, userId);

  // Puxa attempts recentes do usuário. Tentamos join com exercises para topic/type/difficulty.
  // Mantemos query resiliente: se colunas não existirem, cai no fallback.
  let rows = [];
  try {
    const [r] = await pool.query(
      `SELECT a.id AS attempt_id, a.exercise_id, a.is_correct, a.created_at,
              e.topic, e.type, e.difficulty, e.answer_type AS exercise_type, e.answer_type
       FROM attempts a
       LEFT JOIN exercises e ON e.id = a.exercise_id
       WHERE a.user_id = ? AND a.id > ?
       ORDER BY a.id ASC
       LIMIT ?`,
      [userId, lastId, maxScan]
    );
    rows = r || [];
  } catch (e) {
    // fallback sem join
    const [r] = await pool.query(
      `SELECT id AS attempt_id, exercise_id, is_correct, created_at
       FROM attempts
       WHERE user_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [userId, lastId, maxScan]
    );
    rows = r || [];
  }

  if (!rows.length || rows.length < minNewAttempts) {
    return { ok: true, consolidated: false, scanned: rows.length, reason: "not_enough_new_attempts" };
  }

  // Agrega
  const agg = new Map();
  let maxAttemptId = lastId;

  for (const r of rows) {
    const bucket = bucketFromRow(r);
    if (!agg.has(bucket)) {
      agg.set(bucket, { total: 0, correct: 0, last_at: null, difficulty: r.difficulty ?? null });
    }
    const a = agg.get(bucket);
    a.total += 1;
    a.correct += Number(r.is_correct) ? 1 : 0;
    a.last_at = r.created_at || a.last_at;
    if (r.difficulty != null && r.difficulty !== "") a.difficulty = r.difficulty;

    const id = Number(r.attempt_id || 0);
    if (id > maxAttemptId) maxAttemptId = id;
  }

  // Salva por bucket
  for (const [bucket, a] of agg.entries()) {
    const acc = a.total ? a.correct / a.total : 0;
    const label = skillLabel(acc);

    // skill:<bucket>
    await upsertUserLTM(pool, userId, `skill:${bucket}`, JSON.stringify({
      label,
      accuracy: Number(acc.toFixed(3)),
      sample: a.total,
      last_at: a.last_at || null
    }), 0.75, "consolidation");

    // difficulty signal (se houver)
    if (a.difficulty != null && a.difficulty !== "") {
      await upsertUserLTM(pool, userId, `difficulty:${bucket}`, String(a.difficulty), 0.60, "consolidation");
    }

    // topic:last_practiced:<bucket>
    await upsertUserLTM(pool, userId, `topic:last_practiced:${bucket}`, String(a.last_at || ""), 0.55, "consolidation");

    // pattern:low_accuracy:<bucket> se fraco
    if (label === "fraco" && a.total >= 4) {
      await upsertUserLTM(pool, userId, `pattern:low_accuracy:${bucket}`, JSON.stringify({
        accuracy: Number(acc.toFixed(3)),
        sample: a.total
      }), 0.70, "consolidation");
    }
  }

  // Checkpoint técnico
  await upsertUserLTM(pool, userId, "sys:last_consolidation_attempt_id", String(maxAttemptId), 0.95, "consolidation");
  await upsertUserLTM(pool, userId, "sys:last_consolidation_ts", new Date().toISOString(), 0.95, "consolidation");

  return { ok: true, consolidated: true, buckets: agg.size, scanned: rows.length, new_last_attempt_id: maxAttemptId };
}

module.exports = { consolidateUser };
