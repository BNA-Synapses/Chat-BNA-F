const pool = require('../../db/connection');
const { getPreset } = require('../config/ltmPersonal');
const { extractPersonalFromText, inferConsentIntent } = require('./personalExtractor');

const PRESET = getPreset();

async function getConsent(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return null;
  const [rows] = await pool.query(
    'SELECT user_id, allow_personal_memory, allow_story_storage, allow_sensitive, retention_days, updated_at FROM ltm_consent WHERE user_id = ? LIMIT 1',
    [uid]
  );
  if (!rows || rows.length === 0) {
    return {
      user_id: uid,
      allow_personal_memory: 0,
      allow_story_storage: 0,
      allow_sensitive: 0,
      retention_days: 365,
      updated_at: null,
    };
  }
  return rows[0];
}

async function upsertConsent(userId, patch) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return false;
  const allow_personal_memory = patch.allow_personal_memory != null ? Number(!!patch.allow_personal_memory) : null;
  const allow_story_storage = patch.allow_story_storage != null ? Number(!!patch.allow_story_storage) : null;
  const allow_sensitive = patch.allow_sensitive != null ? Number(!!patch.allow_sensitive) : null;
  const retention_days = patch.retention_days != null ? Number(patch.retention_days) : null;

  // Build dynamic update
  const sets = [];
  const vals = [];
  if (allow_personal_memory != null) { sets.push('allow_personal_memory = ?'); vals.push(allow_personal_memory); }
  if (allow_story_storage != null) { sets.push('allow_story_storage = ?'); vals.push(allow_story_storage); }
  if (allow_sensitive != null) { sets.push('allow_sensitive = ?'); vals.push(allow_sensitive); }
  if (retention_days != null && Number.isFinite(retention_days)) { sets.push('retention_days = ?'); vals.push(retention_days); }
  if (sets.length === 0) return true;

  const sql = `INSERT INTO ltm_consent (user_id, allow_personal_memory, allow_story_storage, allow_sensitive, retention_days)
               VALUES (?, COALESCE(?,0), COALESCE(?,0), COALESCE(?,0), COALESCE(?,365))
               ON DUPLICATE KEY UPDATE ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP`;

  // For insert placeholders, we pass all 4 values (possibly null) so COALESCE works.
  const insertVals = [uid, allow_personal_memory, allow_story_storage, allow_sensitive, retention_days];
  await pool.query(sql, [...insertVals, ...vals]);
  return true;
}

async function upsertFact(userId, factKey, factValue, source, confidence) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return false;
  const k = String(factKey || '').trim();
  const v = String(factValue || '').trim();
  if (!k || !v) return false;
  const src = source ? String(source).slice(0, 60) : 'chat';
  const conf = confidence != null && Number.isFinite(Number(confidence)) ? Number(confidence) : null;

  // Read current to fill history if changed
  const [rows] = await pool.query(
    'SELECT id, fact_value FROM ltm_facts WHERE user_id = ? AND fact_key = ? LIMIT 1',
    [uid, k]
  );
  const prev = rows && rows.length ? rows[0] : null;
  if (prev && prev.fact_value !== v) {
    await pool.query(
      'INSERT INTO ltm_fact_history (user_id, fact_id, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [uid, prev.id, prev.fact_value, v]
    );
  }

  await pool.query(
    `INSERT INTO ltm_facts (user_id, fact_key, fact_value, source, confidence)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       fact_value = VALUES(fact_value),
       source = VALUES(source),
       confidence = VALUES(confidence),
       updated_at = CURRENT_TIMESTAMP`,
    [uid, k, v, src, conf]
  );
  return true;
}

async function insertStory(userId, title, content, mood, topics, source) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return false;
  const c = String(content || '').trim();
  if (!c) return false;
  const t = title ? String(title).slice(0, 180) : null;
  const m = mood ? String(mood).slice(0, 80) : null;
  const top = Array.isArray(topics) ? JSON.stringify(topics.slice(0, 12)) : null;
  const src = source ? String(source).slice(0, 60) : 'chat';
  await pool.query(
    'INSERT INTO ltm_stories (user_id, title, content, mood, topics_json, source) VALUES (?, ?, ?, ?, ?, ?)',
    [uid, t, c, m, top, src]
  );
  return true;
}

async function getPersonalMemoryPack(userId, opts) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return '';
  const maxFacts = opts?.maxFacts ?? 10;
  const maxStories = opts?.maxStories ?? 1;

  const consent = await getConsent(uid);
  if (!consent || !Number(consent.allow_personal_memory)) return '';

  const [facts] = await pool.query(
    'SELECT fact_key, fact_value, confidence, updated_at FROM ltm_facts WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',[uid, maxFacts]
  );
  const storyAllowed = Number(consent.allow_story_storage) === 1;
  const [stories] = storyAllowed
    ? await pool.query('SELECT title, content, updated_at FROM ltm_stories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?', [uid, maxStories])
    : [[], []];

  let out = '';
  if (facts && facts.length) {
    out += 'Personal facts (user-consented):\n';
    for (const f of facts) {
      out += `- ${f.fact_key}: ${f.fact_value}\n`;
    }
  }

  if (storyAllowed && stories && stories.length) {
    out += '\nPersonal notes/stories (user-consented):\n';
    for (const s of stories) {
      const title = s.title ? `(${s.title}) ` : '';
      // Keep it short in prompt
      const snippet = String(s.content || '').slice(0, 480);
      out += `- ${title}${snippet}${s.content && s.content.length > 480 ? '…' : ''}\n`;
    }
  }

  return out.trim();
}

async function maybePersistPersonalFromChat(userId, text) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return false;
  const msg = String(text || '').trim();
  if (!msg) return false;

  // Read consent
  let consent = await getConsent(uid);

  // Option 1 (STRICT_OPT_IN): only proceed if allow_personal_memory already enabled
  // Option 2 (SOFT_OPT_IN): if message contains explicit triggers, enable minimal consent
  if (!Number(consent.allow_personal_memory)) {
    if (PRESET.allowImplicitConsent) {
      const intent = inferConsentIntent(msg);
      if (intent.enablePersonal) {
        await upsertConsent(uid, {
          allow_personal_memory: true,
          allow_story_storage: !!intent.enableStory,
        });
        consent = await getConsent(uid);
      }
    }
  }

  if (!Number(consent.allow_personal_memory)) {
    // No consent – do nothing.
    return false;
  }

  // Extract facts/stories
  const extracted = extractPersonalFromText(msg, {
    minStoryChars: PRESET.minStoryChars,
  });

  // Facts
  if (extracted.facts && extracted.facts.length) {
    for (const f of extracted.facts) {
      // Safety: avoid storing "sensitive" if consent disallows
      if (f.sensitive && !Number(consent.allow_sensitive)) continue;
      await upsertFact(uid, f.key, f.value, f.source || 'chat', f.confidence);
    }
  }

  // Story
  if (extracted.story && extracted.story.content) {
    const storyAllowed = Number(consent.allow_story_storage) === 1;
    if (storyAllowed) {
      await insertStory(uid, extracted.story.title, extracted.story.content, extracted.story.mood, extracted.story.topics, 'chat');
    }
  }

  return true;
}

async function getPersonalContextForPrompt(userId) {
  const pack = await getPersonalMemoryPack(userId, {
    maxFacts: PRESET.maxFactsInPrompt,
    maxStories: PRESET.maxStoriesInPrompt,
  });
  if (!pack) return '';
  return `# Personal Context (LTM – consented)\n${pack}`;
}

module.exports = {
  getConsent,
  upsertConsent,
  upsertFact,
  insertStory,
  getPersonalMemoryPack,
  maybePersistPersonalFromChat,
  getPersonalContextForPrompt,
};
