/**
 * Personal extractor (heuristic) – v3.5
 *
 * Goal: pull lightweight, low-risk facts from chat text without depending on the LLM.
 * This reduces cost/rate-limit risk and keeps the system stable.
 */

function norm(s) {
  return String(s || '').trim();
}

function lower(s) {
  return norm(s).toLowerCase();
}

function hasAny(text, needles) {
  const t = lower(text);
  return needles.some((n) => t.includes(n));
}

function detectConsentIntent(text) {
  const t = lower(text);
  const enable = hasAny(t, [
    'pode salvar',
    'pode guardar',
    'salva isso',
    'registra isso',
    'anota isso',
    'lembra disso',
    'memoriza isso',
    'guarda isso',
  ]);

  const story = enable && hasAny(t, ['história', 'desabafo', 'desabafar', 'vou contar', 'aconteceu']);
  return { enablePersonal: enable, enableStory: story };
}

function extractFacts(text) {
  const t = norm(text);
  const facts = [];

  // Name
  {
    const m = t.match(/\b(?:meu nome é|eu me chamo|pode me chamar de)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-\s]{1,60})/i);
    if (m && m[1]) {
      facts.push({ key: 'name', value: norm(m[1]).replace(/[\s]+$/g, ''), confidence: 0.92 });
    }
  }

  // Age
  {
    const m = t.match(/\b(?:tenho|to com|estou com)\s+(\d{1,3})\s*(?:anos)?\b/i);
    if (m && m[1]) {
      const age = Number(m[1]);
      if (Number.isFinite(age) && age >= 5 && age <= 120) {
        facts.push({ key: 'age', value: String(age), confidence: 0.86 });
      }
    }
  }

  // Profession / role
  {
    const m = t.match(/\b(?:sou|trabalho como|atuo como)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-\s]{2,60})/i);
    if (m && m[1]) {
      const v = norm(m[1]);
      // Avoid over-capturing full sentences
      if (v.length <= 60 && v.split(' ').length <= 8) {
        facts.push({ key: 'role', value: v, confidence: 0.74 });
      }
    }
  }

  // Goal
  {
    const m = t.match(/\b(?:meu objetivo é|quero|pretendo|estou tentando)\s+([^\.\n]{5,120})/i);
    if (m && m[1]) {
      const v = norm(m[1]);
      if (v.length <= 120) facts.push({ key: 'goal', value: v, confidence: 0.68 });
    }
  }

  // Likes
  {
    const m = t.match(/\b(?:gosto de|curto|adoro)\s+([^\.\n]{3,80})/i);
    if (m && m[1]) {
      const v = norm(m[1]);
      if (v.length <= 80) facts.push({ key: 'likes', value: v, confidence: 0.65 });
    }
  }

  // Dislikes
  {
    const m = t.match(/\b(?:não gosto de|odeio)\s+([^\.\n]{3,80})/i);
    if (m && m[1]) {
      const v = norm(m[1]);
      if (v.length <= 80) facts.push({ key: 'dislikes', value: v, confidence: 0.65 });
    }
  }

  // De-duplicate by key, keep highest confidence
  const best = new Map();
  for (const f of facts) {
    const cur = best.get(f.key);
    if (!cur || f.confidence > cur.confidence) best.set(f.key, f);
  }

  return Array.from(best.values());
}

function extractStory(text, minChars) {
  const t = norm(text);
  if (!t) return null;
  if (t.length < (minChars || 240)) return null;

  // Very rough heuristic: if it contains narrative cues.
  const cues = ['hoje', 'ontem', 'aconteceu', 'eu fui', 'eu estava', 'senti', 'quando', 'daí'];
  const score = cues.reduce((acc, c) => (lower(t).includes(c) ? acc + 1 : acc), 0);
  if (score < 2) return null;

  return {
    title: null,
    content: t,
    mood: null,
    topics: [],
  };
}

module.exports = {
  detectConsentIntent,
  extractFacts,
  extractStory,
};
