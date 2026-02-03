// bna/memoryBudget.js
// V2.1 — Memory Pack budget/TopK por categoria, com relevância baseada em tema.

function norm(s) {
  return String(s||'').toLowerCase().trim();
}

async function topKeys(pool, userId, likePattern, limit=5) {
  const [rows] = await pool.query(
    `SELECT mem_key, mem_value, confidence, updated_at
     FROM user_ltm
     WHERE user_id=? AND mem_key LIKE ?
     ORDER BY confidence DESC, updated_at DESC
     LIMIT ?`,
    [userId, likePattern, limit]
  );
  return rows || [];
}

async function topRecent(pool, userId, prefix, limit=5) {
  const [rows] = await pool.query(
    `SELECT mem_key, mem_value, confidence, updated_at
     FROM user_ltm
     WHERE user_id=? AND mem_key LIKE ?
     ORDER BY updated_at DESC, confidence DESC
     LIMIT ?`,
    [userId, `${prefix}%`, limit]
  );
  return rows || [];
}

function filterRelevant(rows, topicHint) {
  if (!topicHint) return rows;
  const t = norm(topicHint);
  return rows.filter(r => norm(r.mem_key).includes(t) || norm(r.mem_value).includes(t));
}

function formatRows(title, rows, max=5) {
  if (!rows || !rows.length) return '';
  const lines = rows.slice(0,max).map(r => `- ${r.mem_key}: ${String(r.mem_value).slice(0,240)}`);
  return `${title}\n${lines.join('\n')}`;
}

async function buildBudgetedPack(pool, userId, topicHint) {
  // prefs/goals/profile: top recents
  const prefs = await topRecent(pool, userId, 'pref:', 8);
  const goals = await topRecent(pool, userId, 'goal:', 6);
  const profile = await topRecent(pool, userId, 'profile:', 6);

  // skills/patterns: relevant to topic hint if possible, else top by confidence
  let skills = await topKeys(pool, userId, 'skill:%', 12);
  let patterns = await topKeys(pool, userId, 'pattern:%', 12);

  const relSkills = filterRelevant(skills, topicHint);
  const relPatterns = filterRelevant(patterns, topicHint);

  skills = (relSkills.length ? relSkills : skills).slice(0,5);
  patterns = (relPatterns.length ? relPatterns : patterns).slice(0,5);

  const chunks = [];
  const p1 = formatRows('Prefs:', prefs, 3);
  const p2 = formatRows('Goals:', goals, 3);
  const p3 = formatRows('Profile:', profile, 3);
  const p4 = formatRows('Skills:', skills, 5);
  const p5 = formatRows('Patterns:', patterns, 5);

  for (const p of [p1,p2,p3,p4,p5]) if (p) chunks.push(p);
  return chunks.join('\n\n');
}

module.exports = { buildBudgetedPack };
