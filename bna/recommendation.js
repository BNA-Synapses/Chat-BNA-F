// bna/recommendation.js
// Bloco B5 — Recomendação inteligente de exercício (skills/patterns -> selection)
// Objetivo: quando /exercises-random é chamado SEM filtros, escolher um exercício
// que ataca a fraqueza principal (skill:* fraco/medio) com dificuldade adequada.
//
// Estratégia:
// 1) Ler top skills do user_ltm (skill:*)
// 2) Selecionar bucket mais fraco (menor accuracy) com amostra mínima
// 3) Mapear bucket -> tipo/topic (usa o nome do bucket)
// 4) Escolher difficulty alvo baseado em label/accuracy
// 5) Query exercises com (type = bucket OR topic = bucket) e difficulty alvo,
//    com fallback para qualquer difficulty com aquele bucket, e fallback total.

function parseSkillValue(v) {
  try {
    const obj = JSON.parse(v);
    if (obj && typeof obj === "object") return obj;
  } catch (_) {}
  return null;
}

function pickTargetDifficulty(skill) {
  // Retorna { min, max } para filtrar.
  const acc = Number(skill?.accuracy ?? NaN);
  const label = String(skill?.label ?? "").toLowerCase();

  if (label === "fraco" || (Number.isFinite(acc) && acc < 0.65)) return { min: 1, max: 2 };
  if (label === "medio" || (Number.isFinite(acc) && acc < 0.85)) return { min: 2, max: 3 };
  return { min: 3, max: 5 };
}

async function getWeakestSkillBucket(pool, userId, opts = {}) {
  const minSample = Number(opts.minSample ?? 4);
  const limit = Number(opts.limit ?? 30);

  const [rows] = await pool.query(
    `SELECT mem_key, mem_value, updated_at
     FROM user_ltm
     WHERE user_id = ? AND mem_key LIKE 'skill:%'
     ORDER BY updated_at DESC
     LIMIT ?`,
    [userId, limit]
  );

  const candidates = [];
  for (const r of rows || []) {
    const v = parseSkillValue(r.mem_value);
    if (!v) continue;
    const sample = Number(v.sample ?? 0);
    const acc = Number(v.accuracy ?? NaN);
    if (sample < minSample) continue;
    if (!Number.isFinite(acc)) continue;

    const bucket = String(r.mem_key || "").slice("skill:".length);
    candidates.push({ bucket, acc, sample, label: v.label || "medio" });
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => a.acc - b.acc); // menor acc primeiro
  return candidates[0];
}

async function recommendExercise(pool, userId, opts = {}) {
  const weakest = await getWeakestSkillBucket(pool, userId, opts);
  if (!weakest) return null;

  const bucket = weakest.bucket;
  const diff = pickTargetDifficulty(weakest);

  // 1) tente com difficulty (se colunas existirem)
  try {
    const [rows] = await pool.query(
      `SELECT *
       FROM exercises
       WHERE (LOWER(type) = LOWER(?) OR LOWER(topic) = LOWER(?))
         AND difficulty BETWEEN ? AND ?
       ORDER BY RAND()
       LIMIT 1`,
      [bucket, bucket, diff.min, diff.max]
    );
    if (rows && rows.length) return { exercise: rows[0], reason: { bucket, weakest, diff, mode: "bucket+diff" } };
  } catch (_) {}

  // 2) tente bucket sem difficulty
  try {
    const [rows] = await pool.query(
      `SELECT *
       FROM exercises
       WHERE (LOWER(type) = LOWER(?) OR LOWER(topic) = LOWER(?))
       ORDER BY RAND()
       LIMIT 1`,
      [bucket, bucket]
    );
    if (rows && rows.length) return { exercise: rows[0], reason: { bucket, weakest, diff, mode: "bucket_only" } };
  } catch (_) {}

  return null;
}

module.exports = { recommendExercise };
