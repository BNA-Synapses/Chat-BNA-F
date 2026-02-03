const _cache = new Map();

async function resolveTableName(pool, candidates) {
  const key = candidates.join("|");
  if (_cache.has(key)) return _cache.get(key);

  const placeholders = candidates.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name IN (${placeholders})`,
    candidates
  );

  const chosen = rows && rows.length ? rows[0].table_name : candidates[0];
  _cache.set(key, chosen);
  return chosen;
}

module.exports = { resolveTableName };
