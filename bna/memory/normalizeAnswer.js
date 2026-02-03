// bna/normalizeAnswer.js
// Normalização robusta de respostas de Cálculo 1 (V3)

function stripDiacritics(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeCommon(s) {
  if (s == null) return "";
  let t = String(s).trim();
  t = t.replace(/\u2212/g, "-");
  t = stripDiacritics(t.toLowerCase());
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function normalizeMathy(s) {
  let t = normalizeCommon(s);

  t = t
    .replace(/\bnao existe\b/g, "dne")
    .replace(/\bindefinid[ao]\b/g, "dne")
    .replace(/\bsem solucao\b/g, "dne")
    .replace(/∞/g, "infty");

  if (/[0-9],[0-9]/.test(t)) {
    t = t.replace(/\./g, "");
    t = t.replace(/,/g, ".");
  }

  t = t.replace(/\s*([+\-*/^=()])\s*/g, "$1");
  t = t.replace(/×|·|∙/g, "*");
  t = t.replace(/\*\*/g, "^");
  t = t.replace(/π/g, "pi");
  t = t.replace(/\s+/g, "");
  return t;
}

function tryParseNumber(s) {
  const t = normalizeMathy(s);
  const frac = t.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (frac) {
    const a = Number(frac[1]);
    const b = Number(frac[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
  }
  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

function isNumericEquivalent(a, b, eps = 1e-6) {
  const na = tryParseNumber(a);
  const nb = tryParseNumber(b);
  if (na == null || nb == null) return false;
  return Math.abs(na - nb) <= eps * Math.max(1, Math.abs(na), Math.abs(nb));
}

function isAnswerMatch(user, expected) {
  const u = normalizeMathy(user);
  const expList = String(expected).includes("||")
    ? expected.split("||")
    : [expected];

  for (const e of expList) {
    const en = normalizeMathy(e);
    if (u === en) return { ok: true, reason: "exact" };
    if (isNumericEquivalent(user, e)) return { ok: true, reason: "numeric" };
  }
  return { ok: false, reason: "no_match" };
}

module.exports = { normalizeMathy, isAnswerMatch };
