/**
 * BNA - LTM Consolidator (skeleton)
 * Glue layer:
 * - takes summaries/events/attempt signals
 * - extracts candidates (A5.2)
 * - upserts into DB (A5.1)
 */

const { extractFromSummaryText, extractFromEventText, extractFromAttemptSignal } = require("./ltmExtractor");
const { upsertLtmCandidate } = require("./ltmRepository");

/**
 * Consolidate from a summary row
 * summaryRow: { id, user_id, summary_text }
 */
async function consolidateSummary(pool, summaryRow) {
  const candidates = extractFromSummaryText(summaryRow.summary_text, summaryRow.id);
  for (const c of candidates) {
    await upsertLtmCandidate(pool, summaryRow.user_id, c);
  }
  return candidates.length;
}

/**
 * Consolidate from an event row
 * eventRow: { id, user_id, text }
 */
async function consolidateEvent(pool, eventRow) {
  const candidates = extractFromEventText(eventRow.text, eventRow.id);
  for (const c of candidates) {
    await upsertLtmCandidate(pool, eventRow.user_id, c);
  }
  return candidates.length;
}

/**
 * Consolidate from an attempt signal
 * attemptRow: { id, user_id, topic, subtopic, is_correct, pattern? }
 */
async function consolidateAttempt(pool, attemptRow) {
  const signal = {
    topic: attemptRow.topic,
    subtopic: attemptRow.subtopic,
    pattern: attemptRow.pattern || null,
    is_correct: !!attemptRow.is_correct,
    severity: attemptRow.severity ?? 0.6,
  };
  const candidates = extractFromAttemptSignal(signal, attemptRow.id);
  for (const c of candidates) {
    await upsertLtmCandidate(pool, attemptRow.user_id, c);
  }
  return candidates.length;
}

module.exports = {
  consolidateSummary,
  consolidateEvent,
  consolidateAttempt,
};
