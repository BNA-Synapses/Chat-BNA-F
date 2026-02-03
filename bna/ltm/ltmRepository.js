/**
 * BNA - LTM Repository (MySQL)
 * Requires a mysql2/promise connection pool.
 *
 * Tables:
 *  - bna_ltm_memories
 *  - bna_ltm_evidence
 */

const UPSERT_LTM_SQL = `
INSERT INTO bna_ltm_memories
  (user_id, mem_type, mem_key, value_json, confidence, recurrence_count, last_confirmed_at, status)
VALUES
  (?, ?, ?, CAST(? AS JSON), ?, 1, NOW(), 'active')
ON DUPLICATE KEY UPDATE
  value_json = VALUES(value_json),
  confidence = LEAST(1.000, GREATEST(confidence, VALUES(confidence))),
  recurrence_count = recurrence_count + 1,
  last_confirmed_at = NOW(),
  status = 'active'
`;

const GET_LTM_ID_SQL = `
SELECT id
FROM bna_ltm_memories
WHERE user_id=? AND mem_type=? AND mem_key=?
LIMIT 1
`;

const INSERT_EVIDENCE_SQL = `
INSERT INTO bna_ltm_evidence (ltm_id, source_type, source_id, note)
VALUES (?, ?, ?, ?)
`;

async function upsertLtmCandidate(pool, userId, candidate) {
  const memType = candidate.mem_type;
  const memKey = candidate.mem_key;
  const valueJson = JSON.stringify(candidate.value ?? {});
  const confidence = Number(candidate.confidence ?? 0.7);

  await pool.execute(UPSERT_LTM_SQL, [userId, memType, memKey, valueJson, confidence]);

  const [rows] = await pool.execute(GET_LTM_ID_SQL, [userId, memType, memKey]);
  const ltmId = rows?.[0]?.id;
  if (!ltmId) return null;

  const ev = candidate.evidence || { source_type: "manual", source_id: "unknown", note: null };
  await pool.execute(INSERT_EVIDENCE_SQL, [ltmId, ev.source_type, ev.source_id, ev.note ?? null]);

  return ltmId;
}

async function getActiveLtmForUser(pool, userId, memTypes = null, limit = 100) {
  const params = [userId];
  let where = "WHERE user_id=? AND status='active'";
  if (Array.isArray(memTypes) && memTypes.length) {
    where += ` AND mem_type IN (${memTypes.map(() => "?").join(",")})`;
    params.push(...memTypes);
  }
  params.push(limit);

  const sql = `
    SELECT id, mem_type, mem_key, value_json, confidence, recurrence_count, last_confirmed_at
    FROM bna_ltm_memories
    ${where}
    ORDER BY last_confirmed_at DESC
    LIMIT ?
  `;
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = {
  upsertLtmCandidate,
  getActiveLtmForUser,
};
