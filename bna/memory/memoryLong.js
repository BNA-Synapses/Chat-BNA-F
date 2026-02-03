// bna/memoryLong.js
// Long-Term Memory (LTM) + Consolidação (LTMD)
// - Mantém compatibilidade com user_topic_stats (se existir)
// - Adiciona bna_ltm_memories / bna_ltm_evidence (se existirem)

const pool = require('../../db/connection');

// ------------------------------
// Compat: estatísticas por tópico (antigo)
// ------------------------------
async function updateTopicStats({ userId, topic, isCorrect }) {
  if (!userId || !topic) return;

  try {
    const [rows] = await pool.query(
      'SELECT id, total_attempts, correct_attempts FROM user_topic_stats WHERE user_id = ? AND topic = ?',
      [userId, topic]
    );

    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO user_topic_stats (user_id, topic, total_attempts, correct_attempts)
         VALUES (?, ?, 1, ?)`,
        [userId, topic, isCorrect ? 1 : 0]
      );
    } else {
      await pool.query(
        `UPDATE user_topic_stats
           SET total_attempts = total_attempts + 1,
               correct_attempts = correct_attempts + ?
         WHERE id = ?`,
        [isCorrect ? 1 : 0, rows[0].id]
      );
    }
  } catch (e) {
    // tabela pode não existir em algumas versões
  }
}

// ------------------------------
// Helpers: LTM tables existence
// ------------------------------
async function hasTable(tableName) {
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) as c
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = ?`,
      [tableName]
    );
    return (rows?.[0]?.c || 0) > 0;
  } catch (e) {
    return false;
  }
}

function slugTopic(topic) {
  return String(topic || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\/]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "");
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function confidenceFromAttempts(n){
  // 6 -> ~0.72, 12 -> ~0.82, 25 -> ~0.92
  const base = 0.62 + (1 - Math.exp(-n / 12)) * 0.35;
  return clamp(Number(base.toFixed(3)), 0.62, 0.95);
}

// ------------------------------
// LTMD (Bloco A): Consolidação heurística de exercícios
// ------------------------------
async function upsertLTMFromMTM(userId, opts = {}) {
  const uid = Number(userId);
  if (!uid) return { ok: false, reason: "no_user" };

  const days = Number(opts.windowDays || 14);
  const minAttempts = Number(opts.minAttempts || 6);

  const hasMem = await hasTable("bna_ltm_memories");
  if (!hasMem) return { ok: false, reason: "missing_bna_ltm_memories" };

  // Pega desempenho por tópico no período
  const [rows] = await pool.query(
    `
    SELECT
      e.topic AS topic,
      COUNT(*) AS attempts,
      SUM(CASE WHEN a.is_correct = 1 THEN 1 ELSE 0 END) AS corrects,
      MAX(a.created_at) AS last_attempt_at
    FROM attempts a
    JOIN exercises e ON e.id = a.exercise_id
    WHERE a.user_id = ?
      AND a.created_at >= (NOW() - INTERVAL ? DAY)
    GROUP BY e.topic
    ORDER BY attempts DESC
    `,
    [uid, days]
  );

  const results = [];

  for (const r of rows) {
    const topic = r.topic || "geral";
    const attempts = Number(r.attempts || 0);
    const corrects = Number(r.corrects || 0);
    if (attempts < minAttempts) continue;

    const acc = attempts ? (corrects / attempts) : 0;
    const accPct = Math.round(acc * 100);

    // Heurística simples:
    // gap <= 45% ; strength >= 80%
    let mem_type = null;
    if (acc <= 0.45) mem_type = "knowledge_gaps";
    else if (acc >= 0.80) mem_type = "strengths";
    else continue; // neutro, não vira LTM

    const mem_key = `${mem_type}.${slugTopic(topic)}`;

    const value = {
      topic,
      window_days: days,
      attempts,
      corrects,
      accuracy: Number(acc.toFixed(3)),
      accuracy_pct: accPct,
      last_attempt_at: r.last_attempt_at ? new Date(r.last_attempt_at).toISOString() : null,
      derived_from: "attempts+exercises (heuristic)",
      rule: (mem_type === "knowledge_gaps")
        ? `acc<=45% e attempts>=${minAttempts} nos últimos ${days} dias`
        : `acc>=80% e attempts>=${minAttempts} nos últimos ${days} dias`,
    };

    const confidence = confidenceFromAttempts(attempts);

    // upsert
    await pool.query(
      `
      INSERT INTO bna_ltm_memories
        (user_id, mem_type, mem_key, value_json, confidence, recurrence_count, status, last_confirmed_at)
      VALUES
        (?, ?, ?, CAST(? AS JSON), ?, 1, 'active', NOW())
      ON DUPLICATE KEY UPDATE
        value_json = CAST(? AS JSON),
        confidence = GREATEST(confidence, VALUES(confidence)),
        recurrence_count = recurrence_count + 1,
        status = 'active',
        last_confirmed_at = NOW()
      `,
      [uid, mem_type, mem_key, JSON.stringify(value), confidence, JSON.stringify(value)]
    );

    // Evidence (best-effort)
    try {
      const hasEvi = await hasTable("bna_ltm_evidence");
      if (hasEvi) {
        // pega o id do LTM recém upsertado
        const [ltmRows] = await pool.query(
          `SELECT id FROM bna_ltm_memories WHERE user_id=? AND mem_type=? AND mem_key=? LIMIT 1`,
          [uid, mem_type, mem_key]
        );
        const ltmId = ltmRows?.[0]?.id;
        if (ltmId) {
          await pool.query(
            `INSERT INTO bna_ltm_evidence (ltm_id, source_type, source_id, note)
             VALUES (?, 'attempt', ?, ?)`,
            [ltmId, `topic:${topic}:last${days}d`, `auto-derivado (${attempts} tentativas, ${accPct}% acerto)`]
          );
        }
      }
    } catch (e) {}

    results.push({ topic, mem_type, mem_key, attempts, corrects, acc: Number(acc.toFixed(3)), confidence });
  }

  // marca timestamp de consolidação
  await upsertSystemMarker(uid, "system.ltm.last_consolidation", { at: new Date().toISOString(), window_days: days, min_attempts: minAttempts });

  return { ok: true, window_days: days, min_attempts: minAttempts, items: results };
}

async function upsertSystemMarker(userId, key, valueObj) {
  const uid = Number(userId);
  if (!uid) return;

  const hasMem = await hasTable("bna_ltm_memories");
  if (!hasMem) return;

  await pool.query(
    `
    INSERT INTO bna_ltm_memories
      (user_id, mem_type, mem_key, value_json, confidence, recurrence_count, status, last_confirmed_at)
    VALUES
      (?, 'system_rules', ?, CAST(? AS JSON), 0.900, 1, 'active', NOW())
    ON DUPLICATE KEY UPDATE
      value_json = CAST(? AS JSON),
      confidence = 0.900,
      recurrence_count = recurrence_count + 1,
      status = 'active',
      last_confirmed_at = NOW()
    `,
    [uid, key, JSON.stringify(valueObj), JSON.stringify(valueObj)]
  );
}

async function maybeConsolidateLTM(userId, opts = {}) {
  const uid = Number(userId);
  if (!uid) return { ok: false, reason: "no_user" };

  const hasMem = await hasTable("bna_ltm_memories");
  if (!hasMem) return { ok: false, reason: "missing_bna_ltm_memories" };

  const intervalHours = Number(opts.intervalHours || 24);

  // lê último marker
  try {
    const [rows] = await pool.query(
      `SELECT value_json FROM bna_ltm_memories WHERE user_id=? AND mem_type='system_rules' AND mem_key='system.ltm.last_consolidation' LIMIT 1`,
      [uid]
    );
    if (rows?.length) {
      const v = rows[0].value_json;
      const at = v?.at ? new Date(v.at) : null;
      if (at && Number.isFinite(at.getTime())) {
        const diffH = (Date.now() - at.getTime()) / (1000 * 60 * 60);
        if (diffH < intervalHours && !opts.force) {
          return { ok: true, skipped: true, reason: "interval_not_reached", diff_hours: Number(diffH.toFixed(2)) };
        }
      }
    }
  } catch (e) {
    // se falhar, consolida mesmo
  }

  return await upsertLTMFromMTM(uid, opts);
}

// ------------------------------
// getLTM: string curta para prompt
// ------------------------------
async function getLTM(userId) {
  const uid = Number(userId);
  if (!uid) return '';

  const lines = [];

  // 1) Novo LTM (memories)
  try {
    const hasMem = await hasTable("bna_ltm_memories");
    if (hasMem) {
      const [rows] = await pool.query(
        `
        SELECT mem_type, mem_key, value_json, confidence, recurrence_count
          FROM bna_ltm_memories
         WHERE user_id=?
           AND status='active'
           AND mem_type IN ('knowledge_gaps','strengths','prefs','learning_style','goals')
         ORDER BY
           CASE mem_type
             WHEN 'knowledge_gaps' THEN 1
             WHEN 'strengths' THEN 2
             WHEN 'prefs' THEN 3
             WHEN 'learning_style' THEN 4
             WHEN 'goals' THEN 5
             ELSE 9
           END,
           confidence DESC,
           recurrence_count DESC
         LIMIT 8
        `,
        [uid]
      );

      for (const r of rows) {
        const v = r.value_json || {};
        if (r.mem_type === "knowledge_gaps") {
          lines.push(`• Gap (${v.topic}): ${v.accuracy_pct}% acerto (últ. ${v.window_days}d, ${v.attempts} tentativas).`);
        } else if (r.mem_type === "strengths") {
          lines.push(`• Força (${v.topic}): ${v.accuracy_pct}% acerto (últ. ${v.window_days}d, ${v.attempts} tentativas).`);
        } else if (r.mem_type === "prefs") {
          lines.push(`• Preferência: ${r.mem_key} = ${JSON.stringify(v)}`);
        } else if (r.mem_type === "learning_style") {
          lines.push(`• Estilo: ${r.mem_key} = ${JSON.stringify(v)}`);
        } else if (r.mem_type === "goals") {
          lines.push(`• Meta: ${r.mem_key} = ${JSON.stringify(v)}`);
        }
      }
    }
  } catch (e) {}

  // 2) Compat antigo (user_topic_stats)
  try {
    const [rows] = await pool.query(
      `SELECT topic, total_attempts, correct_attempts
         FROM user_topic_stats
        WHERE user_id = ?
        ORDER BY total_attempts DESC
        LIMIT 4`,
      [uid]
    );
    if (rows?.length) {
      for (const row of rows) {
        const acc = row.total_attempts > 0
          ? Math.round((row.correct_attempts / row.total_attempts) * 100)
          : 0;
        lines.push(`• Histórico (${row.topic}): ${row.correct_attempts}/${row.total_attempts} (${acc}%).`);
      }
    }
  } catch (e) {}

  return lines.join('\n');
}

module.exports = {
  updateTopicStats,
  getLTM,
  upsertLTMFromMTM,
  maybeConsolidateLTM,
};
