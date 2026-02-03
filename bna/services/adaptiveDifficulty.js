// bna/adaptiveDifficulty.js
// Bloco B6 — Ajuste adaptativo de dificuldade (suave, anti-frustração)
// Usa desempenho RECENTE para subir/descer a dificuldade alvo.
//
// Estratégia:
// - Lê últimos N attempts do usuário (janela curta)
// - Calcula taxa de acerto recente
// - Ajusta o range de difficulty recomendado
//
// Saída:
// { min, max, reason }

async function recentAccuracy(pool, userId, opts = {}) {
  const limit = Number(opts.limit ?? 10);
  const [rows] = await pool.query(
    `SELECT is_correct
     FROM attempts
     WHERE user_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [userId, limit]
  );
  if (!rows || rows.length === 0) return null;
  let ok = 0;
  for (const r of rows) ok += Number(r.is_correct) ? 1 : 0;
  return ok / rows.length;
}

function adjustRange(baseRange, acc) {
  if (!Number.isFinite(acc)) return baseRange;
  // suave: não dá saltos grandes
  if (acc >= 0.85) return { min: baseRange.min + 1, max: baseRange.max + 1, trend: "up" };
  if (acc <= 0.40) return { min: Math.max(1, baseRange.min - 1), max: Math.max(1, baseRange.max - 1), trend: "down" };
  return { ...baseRange, trend: "hold" };
}

async function adaptDifficulty(pool, userId, baseRange) {
  const acc = await recentAccuracy(pool, userId, { limit: 10 });
  const adj = adjustRange(baseRange, acc);
  return { ...adj, recent_accuracy: acc };
}

module.exports = { adaptDifficulty };
