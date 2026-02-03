// bna/engine.js

const { callLLM } = require('../llmClient');
const config = require('../config/config');
const persona = require('./persona'); // se você usa em outro lugar, mantém

// 🧠 BrainMode
const BrainContext = require('../brain/BrainContext');
const BrainStates = require('../brain/BrainState');

// 🧠 STM (RAM)
const memory = require('../memory/memory');

/**
 * 🔒 Normaliza QUALQUER formato possível de resposta de LLM
 * (mantido por segurança — NÃO remover sem auditoria)
 */
function extractText(res) {
  if (!res) return null;

  if (typeof res === 'string') return res;
  if (typeof res === 'number') return String(res);

  if (res.text && typeof res.text === 'string') return res.text;
  if (res.content && typeof res.content === 'string') return res.content;

  if (res.message?.content && typeof res.message.content === 'string') {
    return res.message.content;
  }

  if (Array.isArray(res.choices)) {
    const choice = res.choices[0];
    if (choice?.message?.content) return choice.message.content;
    if (choice?.text) return choice.text;
  }

  for (const key of ['output', 'result', 'data', 'response']) {
    if (typeof res[key] === 'string') return res[key];
    if (res[key]?.text) return res[key].text;
    if (res[key]?.content) return res[key].content;
  }

  return JSON.stringify(res, null, 2);
}

/**
 * 🧩 Prompt base do sistema (identidade + regras globais)
 * Agora recebe (state) pra ficar coerente com o BrainContext.
 */
function buildSystemPrompt(state = 'auto', meta = {}) {
  const personality = config.personality || {};
  const tone = personality.tone || 'humorado leve';
  const style = personality.style || 'professor firme, claro, rápido e sagaz';
  const adaptation = personality.adaptation ? 'ligada' : 'desligada';

  const STATE_RULES = {
    explicacao: `
MODO ATIVO: EXPLICAÇÃO
- Explique com calma e clareza.
- Use blocos curtos e exemplos.
- Antes de avançar, confirme se a ideia central ficou clara.
`.trim(),

    passo_a_passo: `
MODO ATIVO: PASSO A PASSO
- Quebre em passos numerados.
- Um passo por vez; só avance depois que o passo atual estiver resolvido.
- Se faltar dado, faça UMA pergunta objetiva.
`.trim(),

    treino: `
MODO ATIVO: TREINO
- Dê 2–4 exercícios graduais.
- Depois de cada tentativa do aluno, corrija e dê a próxima variação.
- Não entregue a resposta final de cara; priorize o caminho.
`.trim(),

    revisao: `
MODO ATIVO: REVISÃO
- Resuma o que foi visto em bullets.
- Aponte os 2 erros mais prováveis e como evitar.
- Dê um mini-checklist final.
`.trim(),

    prova: `
MODO ATIVO: PROVA
- Seja direto, sem “dicas extras” desnecessárias.
- Se o usuário pedir solução: dê a solução com justificativa curta e limpa.
- Não invente passos; seja preciso.
`.trim(),

    erro_comum: `
MODO ATIVO: ERRO COMUM
- Identifique o erro típico e por que ele acontece.
- Mostre a correção e um contraexemplo rápido.
`.trim(),

    aplicacao: `
MODO ATIVO: APLICAÇÃO
- Conecte o conteúdo a uso prático (física, economia, computação, etc.).
- Mostre como modelar e quais suposições estão sendo feitas.
`.trim(),

    auto: `
MODO ATIVO: AUTO
- Detecte a intenção do usuário (explicar vs treino vs revisão vs prova).
- Se estiver ambíguo, escolha o modo mais útil e siga.
`.trim(),
  };

  const stateBlock = STATE_RULES[state] || STATE_RULES.auto;

  const metaLine =
    meta && Object.keys(meta).length
      ? `META (curta): mode=${meta.mode || 'n/a'}; source=${meta.source || 'n/a'}.`
      : '';

  return `
${persona || ''}

Você é o BNA — Breno Neural Assistant.
Seu papel é atuar como um assistente cognitivo disciplinado baseado no método BrainMode.

Regras fundamentais:
1. Explicar com clareza, usando blocos curtos.
2. Identificar onde o aluno se perdeu.
3. Manter leveza sem piada forçada.
4. Incentivar papel e raciocínio ativo.
5. Focar na lógica, não na verborragia.
6. Corrigir mostrando o raciocínio provável do aluno.
7. Ser adaptativo, humano, estilo Jarvis.
8. Ensinar matemática como sistema.

Personalidade:
- Tom: ${tone}
- Estilo: ${style}
- Adaptação: ${adaptation}

Diretriz de identidade:
- Não fique repetindo "BNA" no texto a cada resposta. Use naturalmente, sem assinatura.

ESTADO COGNITIVO ATUAL: ${state}
${metaLine}

${stateBlock}
`.trim();
}

/**
 * 🧠 Prompt Mortal — varia conforme estado cognitivo
 * (esse é o “gatilho fino”)
 */
function buildModePrompt(state) {
  switch (state) {
    case BrainStates.EXPLICACAO:
      return `
Diretriz do modo:
- Explique o conceito com clareza.
- Use analogias simples.
- Valide entendimento antes de avançar.
`.trim();

    case BrainStates.PASSO_A_PASSO:
      return `
Diretriz do modo:
- Resolva passo a passo (numerado).
- Explique cada decisão.
- Aponte erro comum se aparecer.
`.trim();

    case BrainStates.TREINO:
      return `
Diretriz do modo:
- Proponha 2–4 exercícios graduais.
- Espere tentativa do aluno (se ele não tentar, peça uma tentativa).
- Corrija e avance.
`.trim();

    case BrainStates.REVISAO:
      return `
Diretriz do modo:
- Faça síntese em bullets.
- Conecte ideias.
- Feche com mini-checklist.
`.trim();

    case BrainStates.PROVA:
      return `
Diretriz do modo:
- Seja direto.
- Justificativa curta e limpa.
- Sem “dicas extras” desnecessárias.
`.trim();

    case BrainStates.ERRO_COMUM:
      return `
Diretriz do modo:
- Identifique o erro típico.
- Explique por que ele parece correto.
- Dê um contraexemplo rápido.
`.trim();

    case BrainStates.APLICACAO:
      return `
Diretriz do modo:
- Mostre aplicação prática.
- Diga suposições do modelo.
- Conecte com contexto real.
`.trim();

    default:
      return '';
  }
}

/* ======================================================
   ✅ BLOCO 1 — FUNÇÃO COGNITIVA (3 funções)
   detectIntent -> decideStrategy -> buildInstruction
====================================================== */

/**
 * 1) Detecta a intenção do usuário a partir do texto.
 * Retorna uma "intenção" (string) e um pouco de confiança (0..1)
 */
function detectIntent(text = '') {
  const t = String(text || '').toLowerCase().trim();

  if (!t) return { intent: 'explicacao', confidence: 0.2 };

  const has = (...words) => words.some(w => t.includes(w));
  const matchRegex = (re) => re.test(t);

  // sinais fortes
  if (has('passo a passo', 'passo-a-passo', 'etapa', 'primeiro', 'segundo', 'terceiro')) {
    return { intent: 'passo_a_passo', confidence: 0.85 };
  }

  if (has('treinar', 'exercício', 'exercicios', 'lista', 'manda questões', 'manda questoes', 'me dá questões', 'me da questoes')) {
    return { intent: 'treino', confidence: 0.85 };
  }

  if (has('resumo', 'revisão', 'revisao', 'revisar', 'checkpoint', 'checklist')) {
    return { intent: 'revisao', confidence: 0.8 };
  }

  if (has('só a resposta', 'so a resposta', 'gabarito', 'resultado final', 'sem explicar', 'direto ao ponto')) {
    return { intent: 'prova', confidence: 0.9 };
  }

  if (has('onde eu errei', 'erro', 'errei', 'não entendi porque', 'por que deu errado', 'pq deu errado', 'corrige meu')) {
    return { intent: 'erro_comum', confidence: 0.75 };
  }

  if (has('aplicação', 'aplicacao', 'na vida real', 'pra que serve', 'em física', 'em economia', 'em computação', 'no mundo real')) {
    return { intent: 'aplicacao', confidence: 0.75 };
  }

  // heurística: pergunta conceitual “o que é / como funciona”
  if (matchRegex(/\b(o que é|oq é|como funciona|explique|me explica|me explique|conceito)\b/)) {
    return { intent: 'explicacao', confidence: 0.7 };
  }

  // padrão default
  return { intent: 'explicacao', confidence: 0.45 };
}

/**
 * 2) Decide a estratégia (estado BrainMode) a partir da intenção + estado atual.
 * Isso cria um "effectiveState" por turno.
 */
function decideStrategy({ intent, currentState }) {
  // se o state já foi explicitamente setado fora, respeita
  const explicitStates = new Set([
    BrainStates.EXPLICACAO,
    BrainStates.PASSO_A_PASSO,
    BrainStates.TREINO,
    BrainStates.REVISAO,
    BrainStates.PROVA,
    BrainStates.ERRO_COMUM,
    BrainStates.APLICACAO,
  ]);

  if (explicitStates.has(currentState) && currentState !== BrainStates.AUTO && currentState !== 'auto') {
    return { state: currentState, source: 'explicit' };
  }

  // auto: mapeia intenção -> estado
  const map = {
    explicacao: BrainStates.EXPLICACAO,
    passo_a_passo: BrainStates.PASSO_A_PASSO,
    treino: BrainStates.TREINO,
    revisao: BrainStates.REVISAO,
    prova: BrainStates.PROVA,
    erro_comum: BrainStates.ERRO_COMUM,
    aplicacao: BrainStates.APLICACAO,
  };

  return { state: map[intent] || BrainStates.EXPLICACAO, source: 'auto' };
}

/**
 * 3) Constrói uma instrução curta adicional pro LLM (por turno).
 */
function buildInstruction({ state, intentInfo }) {
  const conf = Math.round((intentInfo?.confidence || 0) * 100);
  const header = `INSTRUÇÃO (curta): intenção=${intentInfo?.intent || 'n/a'} (${conf}%), state=${state}.`;

  switch (state) {
    case BrainStates.TREINO:
      return `
${header}
- Faça 2–4 questões graduais e peça tentativa.
- Se o usuário travar, dê uma dica mínima e espere nova tentativa.
- Valide a resposta e avance.
`.trim();

    case BrainStates.PASSO_A_PASSO:
      return `
${header}
- Resolva em passos numerados.
- Um passo por mensagem, se possível.
- Antes de seguir, confirme o passo atual.
`.trim();

    case BrainStates.REVISAO:
      return `
${header}
- Resuma em bullets.
- Diga 2 erros comuns + como evitar.
- Feche com checklist final.
`.trim();

    case BrainStates.PROVA:
      return `
${header}
- Responda direto.
- Justificativa curta e precisa.
- Sem enrolação.
`.trim();

    case BrainStates.ERRO_COMUM:
      return `
${header}
- Identifique o erro típico.
- Mostre o raciocínio que leva ao erro.
- Corrija com contraexemplo rápido.
`.trim();

    case BrainStates.APLICACAO:
      return `
${header}
- Dê uma aplicação real.
- Declare suposições do modelo.
- Conecte com a prática.
`.trim();

    case BrainStates.EXPLICACAO:
    default:
      return `
${header}
- Explique com clareza e blocos curtos.
- Use 1 exemplo simples.
- Cheque entendimento antes de avançar.
`.trim();
  }
}

/**
 * Resolve userId usando BrainContext.meta quando disponível.
 * Se não tiver, cai no 1.
 */
function resolveUserId(meta = {}, fallback = 1) {
  const candidate = meta?.userId ?? meta?.uid ?? meta?.user_id;
  const num = Number(candidate);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * 🧬 Monta o prompt final com estado + meta + histórico (STM)
 */
function buildMessages(msg, history = [], opts = {}) {
  const currentState = BrainContext.getState ? BrainContext.getState() : 'auto';
  const meta = BrainContext.getMeta ? BrainContext.getMeta() : {};
  const userId = resolveUserId(meta, opts.userId ?? 1);

  // 1) detecta intenção
  const intentInfo = detectIntent(msg);

  // 2) decide estado efetivo do turno
  const strategy = decideStrategy({ intent: intentInfo.intent, currentState });
  const effectiveState = strategy.state;

  // 3) instrução curta (refino)
  const instruction = buildInstruction({ state: effectiveState, intentInfo });

  const systemPrompt = buildSystemPrompt(effectiveState, {
    ...meta,
    mode: meta?.mode || (typeof currentState === 'string' ? currentState : 'auto'),
    source: strategy.source,
  });

  const modePrompt = buildModePrompt(effectiveState);

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  if (modePrompt) messages.push({ role: 'system', content: modePrompt });
  if (instruction) messages.push({ role: 'system', content: instruction });

  // ✅ HISTÓRICO: se vier vazio, puxa da STM
  let effectiveHistory = Array.isArray(history) ? history : [];
  if (!effectiveHistory.length) {
    // regra V1: mistura global + por estado (global primeiro)
    const globalHist = memory.getGlobal(userId);
    const stateHist = memory.get(userId, effectiveState);
    effectiveHistory = [...globalHist, ...stateHist].slice(-30);
  }

  if (effectiveHistory.length) {
    messages.push(...effectiveHistory);
  }

  messages.push({ role: 'user', content: msg });

  messages._brain = { intentInfo, strategy, effectiveState, userId };

  return messages;
}

/**
 * 🧠 Função principal do BNA
 * Agora integra STM (memory.js).
 */
async function think(msg, history = [], opts = {}) {
  try {
    const messages = buildMessages(msg, history, opts);

    const userId = messages?._brain?.userId ?? 1;
    const effectiveState =
      messages?._brain?.effectiveState ||
      (BrainContext.getState ? BrainContext.getState() : 'auto');

    const rawResponse = await callLLM(messages);
    const text = extractText(rawResponse);

    // ✅ grava STM (global + por estado)
    memory.addGlobal(userId, { role: 'user', content: msg });
    memory.add(userId, { role: 'user', content: msg }, effectiveState);

    memory.addGlobal(userId, { role: 'assistant', content: text });
    memory.add(userId, { role: 'assistant', content: text }, effectiveState);

    // ✅ atualiza estado do usuário
    memory.setUserState(userId, effectiveState);

    return {
      ok: true,
      state: effectiveState,
      response: text,
    };
  } catch (err) {
    console.error('Erro no BNA.think:', err);
    return {
      ok: false,
      response: 'Erro interno ao processar a resposta do BNA.',
    };
  }
}

module.exports = {
  think,
};