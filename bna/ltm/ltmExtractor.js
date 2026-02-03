/**
 * BNA - LTM A5.2
 * Extraction rules (candidates) from:
 *  - chat / summaries text
 *  - exercise attempts (optional structured signals)
 *
 * Output: candidates ready for DB upsert.
 *
 * Candidate shape:
 * {
 *   mem_type: "prefs" | "profile" | "learning_style" | "knowledge_gaps" | "goals" | "system_rules",
 *   mem_key: "prefs.response_style",
 *   value: {...},               // JS object (later JSON.stringify)
 *   confidence: 0.0..1.0,
 *   evidence: { source_type:"summary"|"event"|"attempt"|"manual", source_id:"...", note?: string }
 * }
 */

function clamp01(x) {
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normText(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Extract PROFILE facts (name/role/context).
 */
function extractProfileFromText(text, evidence) {
  const t = normText(text);
  const out = [];

  // "meu nome é X" / "eu me chamo X"
  const nameMatch =
    t.match(/\bmeu nome (?:é|eh)\s+([a-zà-ú][a-zà-ú'\- ]{1,40})\b/i) ||
    t.match(/\beu me chamo\s+([a-zà-ú][a-zà-ú'\- ]{1,40})\b/i);

  if (nameMatch && nameMatch[1]) {
    const name = nameMatch[1].trim().split(" ").slice(0, 4).join(" ");
    out.push({
      mem_type: "profile",
      mem_key: "profile.name",
      value: { name },
      confidence: 0.92,
      evidence,
    });
  }

  // "sou estudante de X" / "faço X"
  const roleMatch =
    t.match(/\bsou\s+(?:um|uma)?\s*(estudante|aluno|professor|professora|dev|desenvolvedor|desenvolvedora)\b/i);

  if (roleMatch && roleMatch[1]) {
    out.push({
      mem_type: "profile",
      mem_key: "profile.role",
      value: { role: roleMatch[1].toLowerCase() },
      confidence: 0.80,
      evidence,
    });
  }

  return out;
}

/**
 * Extract PREFERENCES (style/tone/step-by-step).
 */
function extractPrefsFromText(text, evidence) {
  const t = normText(text);
  const out = [];

  // step-by-step preference
  if (/\bpasso a passo\b|\bexplica passo a passo\b/.test(t)) {
    out.push({
      mem_type: "prefs",
      mem_key: "prefs.step_by_step_default",
      value: { step_by_step_default: true },
      confidence: 0.85,
      evidence,
    });
  }

  // short responses preference
  if (/\b(resposta|responde)\s+(curta|curtinho)\b|\bsem firula\b|\bobjetiv[oa]\b/.test(t)) {
    out.push({
      mem_type: "prefs",
      mem_key: "prefs.response_length",
      value: { response_length: "short_when_possible" },
      confidence: 0.82,
      evidence,
    });
  }

  // human-friendly tone preference
  if (/\bmais humano\b|\bcomo whatsapp\b|\bconversa natural\b/.test(t)) {
    out.push({
      mem_type: "prefs",
      mem_key: "prefs.tone",
      value: { tone: "human_friendly" },
      confidence: 0.78,
      evidence,
    });
  }

  return out;
}

/**
 * Extract GOALS (long-term).
 */
function extractGoalsFromText(text, evidence) {
  const t = normText(text);
  const out = [];

  // "quero dominar cálculo 1", "meta é ..."
  const calcGoal = t.match(/\b(quero|meta|objetivo)\b[\s\S]{0,40}\b(c[aá]lculo\s*1|calculo\s*1)\b/);
  if (calcGoal) {
    out.push({
      mem_type: "goals",
      mem_key: "goals.primary",
      value: { goal: "dominar_calculo_1" },
      confidence: 0.85,
      evidence,
    });
  }

  // generic goal: "meta é X"
  const goalMatch = t.match(/\bmeta (?:é|eh)\s+(.{3,80})$/i);
  if (goalMatch && goalMatch[1]) {
    const goalText = goalMatch[1].trim();
    if (goalText.length <= 80) {
      out.push({
        mem_type: "goals",
        mem_key: "goals.custom",
        value: { goal: goalText },
        confidence: 0.75,
        evidence,
      });
    }
  }

  return out;
}

/**
 * Extract KNOWLEDGE GAPS from structured attempts signals.
 * Attempt signal shape (recommended):
 * {
 *   topic: "trigonometria",
 *   subtopic: "angulos_notaveis",
 *   pattern: "confunde seno e cosseno",  // optional
 *   is_correct: false,
 *   severity?: 0..1,
 * }
 */
function extractGapsFromAttemptSignal(signal, evidence) {
  if (!signal || !signal.topic) return [];
  const topic = normText(signal.topic).replace(/\s+/g, "_");
  const sub = normText(signal.subtopic || "geral").replace(/\s+/g, "_");
  const isCorrect = !!signal.is_correct;

  // Only create gaps on incorrect attempts (you can refine later)
  if (isCorrect) return [];

  const severity = clamp01(signal.severity ?? 0.6);
  const pattern = String(signal.pattern || "").trim();

  return [{
    mem_type: "knowledge_gaps",
    mem_key: `gaps.${topic}.${sub}`,
    value: {
      topic,
      subtopic: sub,
      pattern: pattern || null,
      severity
    },
    confidence: 0.70 + Math.min(0.25, severity * 0.25),
    evidence,
  }];
}

/**
 * Public API:
 * - extractFromSummaryText(text, summaryId)
 * - extractFromEventText(text, eventId)
 * - extractFromAttemptSignal(signal, attemptId)
 */
function extractFromSummaryText(text, summaryId) {
  const evidence = { source_type: "summary", source_id: String(summaryId || ""), note: null };
  return [
    ...extractProfileFromText(text, evidence),
    ...extractPrefsFromText(text, evidence),
    ...extractGoalsFromText(text, evidence),
  ];
}

function extractFromEventText(text, eventId) {
  const evidence = { source_type: "event", source_id: String(eventId || ""), note: null };
  return [
    ...extractProfileFromText(text, evidence),
    ...extractPrefsFromText(text, evidence),
    ...extractGoalsFromText(text, evidence),
  ];
}

function extractFromAttemptSignal(signal, attemptId) {
  const evidence = { source_type: "attempt", source_id: String(attemptId || ""), note: null };
  return extractGapsFromAttemptSignal(signal, evidence);
}

module.exports = {
  extractFromSummaryText,
  extractFromEventText,
  extractFromAttemptSignal,
};
