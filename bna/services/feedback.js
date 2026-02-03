// =======================================
// feedback.js — Feedback Loop Interno (A1)
// BrainMode V1
// =======================================

const sessionState = {
  lastAssistantTs: null,
  lastUserTs: null,
  deltas: [],           // últimos deltas (ms)
  lastUserText: '',
  prevUserText: ''
};

const MAX_DELTAS = 5;

function now() {
  return Date.now();
}

function pushDelta(delta) {
  sessionState.deltas.push(delta);
  if (sessionState.deltas.length > MAX_DELTAS) {
    sessionState.deltas.shift();
  }
}

function average(arr) {
  if (!arr.length) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return sum / arr.length;
}

function normalizeText(t = '') {
  return String(t || '')
    .toLowerCase()
    .replace(/[^\w\sáéíóúãõâêîôûç]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function onAssistantResponse() {
  sessionState.lastAssistantTs = now();
}

function onUserMessage(userText = '') {
  const t = now();

  if (sessionState.lastAssistantTs) {
    const delta = t - sessionState.lastAssistantTs;
    pushDelta(delta);
  }

  sessionState.lastUserTs = t;

  sessionState.prevUserText = sessionState.lastUserText;
  sessionState.lastUserText = String(userText || '');
}

function getRawSignals() {
  const deltas = sessionState.deltas;
  const deltaLast = deltas.length ? deltas[deltas.length - 1] : null;
  const avgDelta = average(deltas);

  let timingSignal = 'UNKNOWN';

  if (deltaLast != null && avgDelta != null) {
    const ratio = avgDelta > 0 ? deltaLast / avgDelta : 1;

    if (deltaLast < 2000) timingSignal = 'FAST';
    else if (deltaLast > 90000) timingSignal = 'SLOW';
    else if (ratio < 0.4) timingSignal = 'FAST';
    else if (ratio > 1.6) timingSignal = 'SLOW';
    else timingSignal = 'OK';
  }

  const text = (sessionState.lastUserText || '').toLowerCase();

  const acknowledged =
    text.includes('entendi') ||
    text.includes('faz sentido') ||
    text === 'ok' ||
    text === 'beleza' ||
    text === 'certo';

  const confusion =
    text.includes('não entendi') ||
    text.includes('nao entendi') ||
    text.includes('como assim') ||
    text.includes('por quê') ||
    text.includes('por que') ||
    text.includes('pq');

  const repeatedQuestion =
    normalizeText(sessionState.lastUserText) !== '' &&
    normalizeText(sessionState.lastUserText) === normalizeText(sessionState.prevUserText);

  return {
    timing: { timingSignal, deltaLast, avgDelta },
    text: { acknowledged, confusion, repeatedQuestion }
  };
}

function reset() {
  sessionState.lastAssistantTs = null;
  sessionState.lastUserTs = null;
  sessionState.deltas = [];
  sessionState.lastUserText = '';
  sessionState.prevUserText = '';
}

module.exports = {
  onAssistantResponse,
  onUserMessage,
  getRawSignals,
  reset
};
