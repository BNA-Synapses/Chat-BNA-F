const express = require('express');
const app = express();
const PORT = 3000;

// ------------------------------
// MCQ helper (A-E) para respostas numericas
// Retorna { options: [{letter,value}], correct_value }
// ------------------------------
function buildMCQNumeric(correctRaw){
  const n = Number(String(correctRaw).replace(',', '.'));
  if (!Number.isFinite(n)) return null;

  const candidates = new Set();
  candidates.add(String(n));

  const bumps = [1,2,3];
  for (const b of bumps){
    candidates.add(String(n + b));
    candidates.add(String(n - b));
  }
  candidates.add(String(-n));
  candidates.add(String(n * 2));
  if (n !== 0) candidates.add(String(n / 2));

  const arr = [...candidates].filter(v => v !== String(n));

  for (let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  const distractors = arr.slice(0,4);
  if (distractors.length < 4) return null;

  const optionsValues = [String(n), ...distractors];
  for (let i=optionsValues.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [optionsValues[i],optionsValues[j]]=[optionsValues[j],optionsValues[i]];
  }
  const letters = ['A','B','C','D','E'];
  const options = optionsValues.map((v,idx)=>({ letter: letters[idx], value: v }));
  return { options, correct_value: String(n) };
}

const pool = require('./db/connection');
const path = require('path');
const BNA = require('./bna/services/engine');
const axios = require('axios');
const memory = require('./bna/memory/memory');

// Compat: some builds export saveSTM/getSTM/clearSTM; others export add/get/clear.
// We wrap to avoid crashing when a symbol is missing.
function _pickFn(...fns) { return fns.find(fn => typeof fn === 'function'); }
const _saveSTM = _pickFn(memory.saveSTM, memory.add, memory.save, memory.set, memory.setSTM);
const _getSTM = _pickFn(memory.getSTM, memory.get, memory.loadSTM, memory.readSTM);
const _clearSTM = _pickFn(memory.clearSTM, memory.clear, memory.resetSTM);

async function saveSTM(userId, msg) {
  if (!_saveSTM) return false;
  return await _saveSTM(userId, msg);
}
async function getSTM(userId) {
  if (!_getSTM) return [];
  const r = await _getSTM(userId);
  if (Array.isArray(r)) return r;
  if (r == null) return [];
  return [String(r)];
}
async function clearSTM(userId) {
  if (!_clearSTM) return false;
  return await _clearSTM(userId);
}
const { registerSolve, getMPT } = require('./bna/memory/memoryMid');
// NOTE: memoryLong module lives inside ./bna/memory/
const { updateTopicStats, getLTM } = require('./bna/memory/memoryLong');
const persona = require('./bna/services/persona');

// ------------------------------
// Last Solve Context (per user) — usado pelo modo FEEDBACK_COACH
// ------------------------------
const LAST_SOLVE = new Map(); // userId -> payload
function setLastSolve(userId, payload) { LAST_SOLVE.set(String(userId || 'anon'), payload); }
function getLastSolve(userId) { return LAST_SOLVE.get(String(userId || 'anon')) || null; }

// Gera um feedback mais “coach” (curto, direto e acionável) após /solve
async function makeCoachFeedback({ userId, exercise, userAnswer, correctAnswer, isCorrect, topic, difficulty }) {
  const exObj = (exercise && typeof exercise === "object") ? exercise : null;
  const statement = exObj ? (exObj.statement || exObj.prompt || exObj.question || "") : String(exercise || "");
  const exTopic = (topic !== undefined && topic !== null) ? topic : (exObj ? exObj.topic : "");
  const exDiff = (difficulty !== undefined && difficulty !== null) ? difficulty : (exObj ? exObj.difficulty : "");

  const quickReplies = isCorrect
    ? [
        { id: 'why', label: 'Por que tá certo?', msg: 'Por que minha resposta está correta? Explica rapidinho.' },
        { id: 'harder', label: 'Mais difícil', msg: 'Me dá um exercício parecido, só que um pouco mais difícil.' },
        { id: 'tip', label: 'Dica geral', msg: 'Qual é a dica geral/atalho pra esse tipo de questão?' },
      ]
    : [
        { id: 'where', label: 'Onde errei?', msg: 'Em qual passo eu provavelmente errei? Me dá um diagnóstico.' },
        { id: 'steps', label: 'Passo-a-passo', msg: 'Mostra um passo-a-passo curto de como resolver.' },
        { id: 'hint', label: 'Só uma dica', msg: 'Me dá só uma dica, sem entregar tudo.' },
      ];

  const prompt = [
    'Você é o BNA no modo FEEDBACK_COACH.',
    'Objetivo: dar um feedback curto, prático e específico do exercício e da resposta do aluno.',
    'Regras:',
    '- Não seja “chat livre”; seja coach (direto).',
    '- Se estiver errado: aponte o tipo de erro mais provável (sinal, conceito, álgebra, interpretação) e dê 1 dica acionável.',
    '- Se estiver certo: valide e dê 1 generalização/atalho.',
    '- Máximo 6 linhas.',
    '',
    `Tópico: ${topic || 'n/a'} | Dificuldade: ${difficulty ?? 'n/a'}`,
    `Enunciado: ${exercise || ''}`,
    `Resposta do aluno: ${userAnswer || ''}`,
    `Gabarito/esperado: ${correctAnswer ?? 'n/a'}`,
    `Resultado: ${isCorrect ? 'CORRETO' : 'ERRADO'}`,
  ].join('\n');

  try {
    const out = await BNA.think({
      userId,
      msg: prompt,
      mode: 'FEEDBACK_COACH',
    });

    const text = (out && (out.text || out.answer || out.response)) ? String(out.text || out.answer || out.response) : String(out || '');
    return { text: text.trim(), quickReplies };
  } catch (e) {
    return {
      text: isCorrect ? '✅ Certo. Boa! Quer um desafio parecido?' : '❌ Errou. Quer uma dica ou um passo-a-passo?',
      quickReplies,
      error: String(e && e.message ? e.message : e),
    };
  }
}



function normalizeReply(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;

  // casos comuns de SDKs/LLMs
  if (typeof x.text === "string") return x.text;
  if (typeof x.content === "string") return x.content;
  if (typeof x.message?.content === "string") return x.message.content;
  if (Array.isArray(x.choices) && typeof x.choices?.[0]?.message?.content === "string") {
    return x.choices[0].message.content;
  }

  // último fallback: serializa bonito
  try { return JSON.stringify(x, null, 2); }
  catch { return String(x); }
}

// Função utilitária para normalizar respostas de texto
function normalizeAnswer(ans) {
  return String(ans || '')
    .trim()          // tira espaços do começo/fim
    .toLowerCase()   // ignora maiúscula/minúscula
    .replace(/\s+/g, ''); // remove todos os espaços internos
}

//Função de mensagem
function detectMode(msg) {
  const t = String(msg || '').toLowerCase();

  const hasMathSignals =
    /deriv|integra|limite|funç|f\(x\)|equação|calcule|resolva|simplifique|mostre|prove|determine/.test(t);

  const looksLikeExercise =
    /calcule|resolva|derive|integre|encontre|determine|passo a passo/.test(t);

  if (!hasMathSignals) return 'casual';
  if (looksLikeExercise) return 'pratica';
  return 'teoria';
}

// Função de determinação de tempo sem BD
function buildTimeContext() {
  const now = new Date();
  const hour = now.getHours();

  const dayPart =
    hour < 12 ? 'manhã' :
    hour < 18 ? 'tarde' : 'noite';

  const weekday = now.toLocaleDateString('pt-BR', { weekday: 'long' });

  return `Agora é ${weekday}, ${dayPart}. Horário: ${now.toLocaleTimeString('pt-BR')}.`;
}

// Habilita JSON no body
app.use(express.json());

app.post('/memory/clear', (req, res) => {
  const { user_id } = req.body;
  clearSTM(user_id);
  res.json({ 
    ok: true,
    message: "Memoria de curto prazo limpa."
  });
});


// =============================================================
//  ROTA /solve – IA corrige e explica o exercício
//  Fluxo:
//   1) recebe user_id, exercise_id, user_answer
//   2) busca exercício no banco
//   3) confere se está certo (comparação direta)
//   4) chama BNA (/bna/msg) para gerar explicação personalizada
//   5) registra tentativa + XP
//   6) devolve status, explicação, XP e nível
// =============================================================
// ROTA /solve – IA corrige e explica o exercício
app.post('/solve', async (req, res) => {
  try {
    const { user_id, exercise_id, user_answer, answer, response_mode, selected_letter, mode } = req.body || {};
    const uid = Number.isFinite(Number(user_id)) ? Number(user_id) : 1;
    const rawAnswer = (typeof user_answer !== 'undefined') ? user_answer : answer;

    // 1) validação básica
    if (!exercise_id || typeof rawAnswer === 'undefined') {
      return res.status(400).json({
        ok: false,
        message: 'Campos obrigatórios: exercise_id, user_answer (ou answer). user_id é opcional (default=1).',
      });
    }

    const final_answer = String(rawAnswer);
    await saveSTM(uid, final_answer);

    console.log('/solve recebido:', { body: req.body });

    // 2) buscar exercício
    const [exRows] = await pool.query(
      'SELECT id, topic, difficulty, statement, correct_answer, answer_type FROM exercises WHERE id = ?',
      [exercise_id]
    );

    if (exRows.length === 0) {
      return res.status(404).json({
        ok: false,
        message: 'Exercício não encontrado',
      });
    }

    const exercise = exRows[0];
    const question = exercise.statement;
    // versões "cruas" (como vieram do banco e do usuário)
    const correct_answer_raw = exercise.correct_answer;
    const user_answer_raw = final_answer;

    // normaliza pra comparar de forma mais justa
    const correct_answer = normalizeAnswer(correct_answer_raw);
    const normalized_user = normalizeAnswer(user_answer_raw);

    // checar se está correto (agora com normalização)
    const isCorrect = normalized_user === correct_answer;

    // 3.5) recuperar memória e registrar tentativa no médio / longo prazo
let shortContext = '';
let midContext = '';
let longContext = '';

try {
  const _stmArr = await getSTM(uid);
  shortContext = _stmArr.join('\n');
} catch (err) {
  console.error('Erro ao ler STM:', err.message);
}

try {
  midContext = await getMPT(uid);
} catch (err) {
  console.error('Erro ao ler MPT:', err.message);
}

try {
  await registerSolve({
    userId: uid,
    isCorrect,
    exercise,
  });

  // atualizar estatísticas de longo prazo (por tópico)
  await updateTopicStats({
    userId: uid,
    topic: exercise.topic,
    isCorrect,
  });

  // gerar contexto de longo prazo para o BNA
  longContext = await getLTM(uid);
} catch (err) {
  console.error('Erro ao registrar stats / longo prazo:', err.message);
}

    // 4) pedir explicação para o BNA (engine direto)
    let explanation = 'Não foi possível gerar explicação agora.';

    //5
    let styleTag = "estilo_normal";

    if (!isCorrect) {
        if (final_answer.trim() === "") {
            styleTag = "erro_sem_resposta";
        } else if (correct_answer.length <= 3) {
            styleTag = "erro_simples";
        } else {
            styleTag = "erro_complexo";
        }
    } else {
        styleTag = "acerto";
    } 

    try {
      const prompt = `
${persona}   

Agora siga rigorosamente as intruções acima para corrigir o exercicio.

Você está corrigindo um exercício de Cálculo 1.

Historico recente do aluno (curto prazo):
${shortContext || '-sem historico recente-'}

Resumo do desempenho do dia (medio prazo):
${midContext || '-sem resumo dispnivel ainda-'}

Resumo geral do aluno (longo prazo):
${longContext || '-sem historico geral'} 

Dados do exercício:
- Enunciado: ${question}
- Tipo de resposta: ${exercise.answer_type || 'expressão'}
- Resposta correta esperada: ${correct_answer}
- Resposta do aluno: ${final_answer}
- Resultado da checagem automática: ${isCorrect ? 'correta' : 'incorreta'}

Tarefas:
1. Confirme se a resposta do aluno está correta ou incorreta.
2. Explique a resolução passo a passo, em blocos curtos e claros.
3. Se o aluno errou, mostre onde provavelmente ele se confundiu.
4. Use o tom do Brain-Mode: firme, claro, rápido e sagaz.
5. Lembre o aluno de usar papel e caneta quando necessário.
`.trim();

      const bnaResult = await BNA.think(prompt);

      if (bnaResult && bnaResult.ok && bnaResult.response) {
        explanation = bnaResult.response;
      }
    } catch (err) {
      console.error('Erro ao chamar BNA para explicação:', err);
    }


    // 4.5) Feedback Coach (curto) + quick replies (estilo 99/Uber)
    const topic = exercise.topic;
    const difficulty = exercise.difficulty;
    const userAnswer = String(final_answer || '');
    const correctAnswer = String(correct_answer_raw || correct_answer || '');

    await setLastSolve(uid, {
      exercise,
      topic,
      difficulty,
      userAnswer,
      correctAnswer,
      isCorrect,
      ts: Date.now(),
    });

    const coach = await makeCoachFeedback({
      userId: uid,
      exercise,
      userAnswer,
      correctAnswer,
      isCorrect,
      topic,
      difficulty,
    });
    const gained_xp = isCorrect ? 10 : 2;
    const new_level = 1; // placeholder por enquanto

    return res.json({
      ok: true,
      user_id: uid,
      exercise_id,
      
      // HTML lê assim:
      is_correct: isCorrect,
      bna_answer: explanation,
      coach: {
        text: coach && coach.text ? coach.text : '',
        quick_replies: coach && coach.quickReplies ? coach.quickReplies : [],
      },

      // continua enviando o que já tinha
      gained_xp,
      new_level,
    });
  } catch (err) {
    console.error('Erro na rota /solve:', err);
    return res.status(500).json({
      ok: false,
      message: 'Erro interno ao corrigir exercício',
    });
  }
});


// ROTA DE INVOKE — dispara /solve automaticamente via GET
app.get('/invoke/solve', async (req, res) => {
  try {
    const fakePayload = {
      user_id: 1,
      exercise_id: 1,
      user_answer: "2x + 3"
    };

    const response = await fetch("http://localhost:3000/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fakePayload)
    });

    const data = await response.json();
    return res.json({
      invoked: true,
      sent: fakePayload,
      solve_response: data
    });

  } catch (err) {
    return res.json({
      invoked: false,
      error: err.message
    });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------
   ROTAS DE TESTE
-------------------------------------------------------*/

// Rota POST simples de teste
app.post('/ping', (req, res) => {
  return res.json({
    ok: true,
    message: 'Brain-Mode online (POST)',
    body: req.body,
  });
});

// Rota de teste do BNA (Breno Neural Assistant)
app.get("/bna/test", async (req, res) => {
  try {
    const user_id = Number(req.query.user_id ?? 1);
    const msg = String(req.query.msg ?? "Olá, BNA!").trim();

    const history = (memory?.get && typeof memory.get === "function")
      ? memory.get(user_id)
      : [];

    let result;
    if (typeof BNA?.think === "function") {
      result = await BNA.think(msg, history, { mode: "auto", time: "now", user_id });
    } else {
      throw new Error("BNA.think não existe (import do BNA falhou).");
    }

    // normaliza retorno pra STRING
    let reply =
      (typeof result === "string" ? result :
      result?.response ?? result?.reply ?? result?.text ?? result?.content ?? result);

    if (typeof reply !== "string") reply = JSON.stringify(reply, null, 2);

    // salva memória (opcional)
    if (memory?.add && typeof memory.add === "function") {
      memory.add(user_id, { role: "user", content: msg });
      memory.add(user_id, { role: "assistant", content: reply });
    }

    return res.json({
      ok: true,
      user_id,
      msg,
      reply
    });

  } catch (err) {
    console.error("ERRO /bna/test:", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao processar o BNA",
      details: String(err?.message || err)
    });
  }
});


// ROTA DO CHAT (versão estável, com memória por estado)

// Rota opcional: gerar feedback coach sob demanda (usa o último /solve do usuário)
app.post('/coach', async (req, res) => {
  try {
    const userId = String((req.body && req.body.user_id) || 'anon');
    const last = getLastSolve(userId);

    if (!last) {
      return res.status(400).json({ ok: false, error: 'Sem contexto de solve. Faça um /solve primeiro.' });
    }

    const coach = await makeCoachFeedback({
      userId,
      exercise: last.exercise,
      userAnswer: last.userAnswer,
      correctAnswer: last.correctAnswer,
      isCorrect: last.isCorrect,
      topic: last.topic,
      difficulty: last.difficulty,
    });

    return res.json({ ok: true, coach: { text: coach.text || '', quick_replies: coach.quickReplies || [] } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { user_id, message, mode } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Campo 'message' é obrigatório e deve ser string.",
      });
    }

    const uid = Number.isFinite(Number(user_id)) ? Number(user_id) : 1;

    // 1) Decide estado “base” para buscar histórico
    // - se veio mode fixo (ex: 'treino'), usa ele
    // - se veio auto (ou nada), usa o último estado salvo do usuário
    const requested = (mode && String(mode).trim()) ? String(mode).trim() : "auto";
    const baseState = requested === "auto" ? (memory.getUserState(uid) || "auto") : requested;

    // 2) Puxa histórico do estado base
    const baseKey = memory.makeKey(uid, baseState);
    const history = memory.getByKey(baseKey);

    // 3) Salva msg do user nesse “contexto base”
    memory.addByKey(baseKey, { role: "user", content: message });

    // 4) Injeta contextos MTM/LTM (para lembrar de dias anteriores)
    let midContext = "";
    let longContext = "";
    try { midContext = await getMPT(uid); } catch(e) {}
    try { longContext = await getLTM(uid); } catch(e) {}

    const memoryContext = `Contexto persistente do aluno (NÃO invente fatos):\n- MTM: ${midContext || "-"}\n- LTM: ${longContext || "-"}`.trim();

    const augmentedHistory = Array.isArray(history) ? [...history] : [];
    // Coloca um "system" leve no começo (sem quebrar o tom do BNA)
    augmentedHistory.unshift({ role: "system", content: memoryContext });

    // 4) Chama BNA
    const result = await BNA.think(message, augmentedHistory);

    // 5) Normaliza reply (engine.js já devolve { ok, state, response }, mas vamos blindar)
    const reply =
      (typeof result === "string" && result) ||
      result?.response ||
      result?.reply ||
      result?.text ||
      (result?.message?.content ?? null);

    if (!reply) {
      console.log("CHAT result bruto:", result);
      return res.status(500).json({
        ok: false,
        message: "BNA respondeu vazio/inesperado.",
      });
    }

    // 6) Estado final: se o engine informou, usamos ele; senão, fica no baseState
    const finalState = result?.state ? String(result.state) : baseState;

    // 7) Agora salva a conversa no contexto FINAL (pra próxima puxar certo)
    const finalKey = memory.makeKey(uid, finalState);

    // se o estado mudou, também replica a msg do user nesse novo “thread”
    if (finalKey !== baseKey) {
      memory.addByKey(finalKey, { role: "user", content: message });
    }

    memory.addByKey(finalKey, { role: "assistant", content: String(reply) });

    // 8) Atualiza estado “corrente” do user
    memory.setUserState(uid, finalState);

    return res.json({
      ok: true,
      user_id: uid,
      mode: requested,
      state: finalState,
      time: new Date().toISOString(),
      reply: String(reply),
    });
  } catch (err) {
    console.error("ERRO /chat:", err);
    return res.status(500).json({
      ok: false,
      message: "Erro ao processar o chat",
      error: String(err?.message || err),
    });
  }
});

/* ------------------------------------------------------
   USUÁRIOS
-------------------------------------------------------*/

// Testa leitura da tabela users
app.get('/db-users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM users');
    return res.json({
      ok: true,
      users: rows,
    });
  } catch (err) {
    console.error('Erro no banco: ', err);
    return res.status(500).json({
      ok:false,
      message: 'Erro ao consultar usuários',
    });
  }
});

// Inserção de usuário
app.post('/add-user', async (req, res) => {
  try {
    const { name, email } = req.body;

    const sql = "INSERT INTO users (name, email) VALUES (?, ?)";
    const [result] = await pool.query(sql, [name, email]);

    return res.json({
      ok: true,
      message: "Usuário inserido com sucesso!",
      id: result.insertId
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao inserir usuário"
    });
  }
});

/* ------------------------------------------------------
   EXERCÍCIOS
-------------------------------------------------------*/

// Puxa exercícios
app.get('/exercises', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM exercises LIMIT 20');
    return res.json({
      ok: true,
      data: rows
    });
  } catch (err) {
    console.error('Erro ao buscar exercícios:', err);
    return res.status(500).json({ ok: false, message: 'Erro ao buscar exercícios' });
  }
});

// Puxa exercício por ID
app.get('/exercises/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.query(
      "SELECT * FROM exercises WHERE id = ?",
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, message: "Exercício não encontrado" });
    }

    return res.json({ ok: true, data: rows[0] });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar exercício" });
  }
});

// Exercício aleatório simples
app.get('/exercises-random', async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM exercises"
    );

    if (rows.length === 0) {
      return res.json({ ok: false, message: "Nenhum exercício cadastrado" });
    }

    const random = rows[Math.floor(Math.random() * rows.length)];

    const ex = { ...random };

    // Se for numerico e dificuldade baixa, gera alternativas A-E
    try {
      const diff = Number(ex.difficulty ?? 0);
      const at = String(ex.answer_type || '').toLowerCase();
      const canMCQ = (at.includes('numeric') || at.includes('number') || at.includes('num') || at.includes('mcq'));
      if (canMCQ) {
        const mcq = buildMCQNumeric(ex.correct_answer);
        if (mcq) {
          ex.mcq = { options: mcq.options };
          ex.options = mcq.options;
          ex.mcq_options = mcq.options;
        }
      }
    } catch (e) {}

    return res.json({ ok: true, data: ex });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: "Erro ao buscar exercício aleatório" });
  }
});

/* ------------------------------------------------------
   TENTATIVAS + XP / LEVEL
-------------------------------------------------------*/

// Registrar tentativa de exercício
app.post('/attempts', async (req, res) => {
  try {
    const { user_id, exercise_id, user_answer, answer, response_mode } = req.body;
    const final_answer = (typeof user_answer !== 'undefined') ? user_answer : answer;

    if (!user_id || !exercise_id || typeof final_answer === 'undefined') {
      return res.status(400).json({
        ok: false,
        message: 'Campos obrigatórios: user_id, exercise_id, user_answer',
      });
    }

    // Buscar o exercício
    const [exRows] = await pool.query(
      'SELECT correct_answer FROM exercises WHERE id = ?',
      [exercise_id]
    );

    if (exRows.length === 0) {
      return res.status(404).json({
        ok: false,
        message: 'Exercício não encontrado',
      });
    }

    const correct_answer = (exRows[0].correct_answer || '').trim();
    const normalized_user = (final_answer || '').trim();

    const isCorrect = correct_answer === normalized_user;

    // Registrar tentativa
    const [attemptResult] = await pool.query(
      `INSERT INTO attempts (user_id, exercise_id, user_answer, is_correct)
       VALUES (?, ?, ?, ?)`,
      [user_id, exercise_id, String(final_answer), isCorrect ? 1 : 0]
    );

    // XP
    const gainedXp = isCorrect ? 10 : 2;

    const [userRows] = await pool.query(
      'SELECT xp, level FROM users WHERE id = ?',
      [user_id]
    );

    if (userRows.length === 0) {
      return res.json({
        ok: true,
        attempt_id: attemptResult.insertId,
        is_correct: isCorrect,
        xp_change_ignored: true,
        message: 'Tentativa salva, mas usuário não encontrado para atualizar XP.'
      });
    }

    let currentXp = userRows[0].xp || 0;
    let currentLevel = userRows[0].level || 1;

    currentXp += gainedXp;

    let leveledUp = false;
    while (currentXp >= currentLevel * 100) {
      currentXp -= currentLevel * 100;
      currentLevel += 1;
      leveledUp = true;
    }

    await pool.query(
      'UPDATE users SET xp = ?, level = ? WHERE id = ?',
      [currentXp, currentLevel, user_id]
    );

    return res.json({
      ok: true,
      attempt_id: attemptResult.insertId,
      is_correct: isCorrect,
      gained_xp: gainedXp,
      user: {
        level: currentLevel,
        xp: currentXp,
      },
      leveled_up: leveledUp
    });

  } catch (err) {
    console.error('Erro ao registrar tentativa:', err);
    return res.status(500).json({
      ok: false,
      message: 'Erro interno ao registrar tentativa',
    });
  }
});

/* ------------------------------------------------------
   ESTATÍSTICAS
-------------------------------------------------------*/

// Estatísticas do usuário (V2 com XP)

/* ------------------------------------------------------
   TREINO — Summary do dia (modal Progresso)
-------------------------------------------------------*/
app.get('/train-summary/:user_id', async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ ok:false, message:'user_id invalido' });
    }

    const [rows] = await pool.query(
      `SELECT a.exercise_id, a.is_correct, a.created_at, e.topic, e.subtopic
         FROM attempts a
         LEFT JOIN exercises e ON e.id = a.exercise_id
        WHERE a.user_id = ? AND DATE(a.created_at) = CURDATE()
        ORDER BY a.created_at ASC`,
      [userId]
    );

    let correct = 0, wrong = 0;
    const perExercise = new Map();
    const topicCount = new Map();
    const subCount = new Map();

    for (const r of rows){
      if (r.is_correct) correct++; else wrong++;

      const t = r.topic || '—';
      topicCount.set(t, (topicCount.get(t)||0)+1);

      const st = r.subtopic || '';
      if (st) subCount.set(st, (subCount.get(st)||0)+1);

      const stt = perExercise.get(r.exercise_id) || { seenWrong:false, fixed:false, attempts:0 };
      stt.attempts += 1;
      if (!r.is_correct) stt.seenWrong = true;
      if (r.is_correct && stt.seenWrong) stt.fixed = true;
      perExercise.set(r.exercise_id, stt);
    }

    let cycles = 0, fixes = 0;
    for (const v of perExercise.values()){
      if (v.attempts >= 2) cycles++;
      if (v.fixed) fixes++;
    }

    const neuro_xp = (fixes * 15) + (cycles * 8) + (correct * 2);

    let focus_topic = '—', maxT = 0;
    for (const [k,v] of topicCount.entries()){
      if (v > maxT){ maxT = v; focus_topic = k; }
    }
    let focus_subtopic = '';
    let maxS = 0;
    for (const [k,v] of subCount.entries()){
      if (v > maxS){ maxS = v; focus_subtopic = k; }
    }

    const next_suggestion =
      wrong > correct
        ? 'Sugestao: repetir um exercicio parecido no mesmo topico e focar no passo onde travou.'
        : (fixes > 0 ? 'Sugestao: subir 1 nivel de dificuldade ou trocar de subtopico.' : 'Sugestao: fazer mais 1 ciclo (tente, veja feedback, tente de novo).');

    return res.json({
      ok:true,
      summary:{ cycles, fixes, neuro_xp, correct, wrong, focus_topic, focus_subtopic, next_suggestion }
    });
  } catch (err) {
    console.error('Erro em /train-summary:', err);
    return res.status(500).json({ ok:false, message:'Erro ao gerar summary do treino' });
  }
});


app.get('/stats/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    const [rows] = await pool.query(
      `SELECT 
         COUNT(*) AS total_attempts,
         SUM(is_correct) AS correct_attempts,
         SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) AS wrong_attempts
       FROM attempts
       WHERE user_id = ?`,
      [user_id]
    );

    const stats = rows[0];

    const [userRows] = await pool.query(
      `SELECT xp, level FROM users WHERE id = ?`,
      [user_id]
    );

    let xp = 0;
    let level = 1;

    if (userRows.length > 0) {
      xp = userRows[0].xp ?? 0;
      level = userRows[0].level ?? 1;
    }

    if (!stats.total_attempts) {
      return res.json({
        ok: true,
        message: 'Usuário ainda não tem tentativas registradas.',
        stats: {
          total_attempts: 0,
          correct_attempts: 0,
          wrong_attempts: 0,
          accuracy: 0,
          xp,
          level
        }
      });
    }

    const accuracy = (stats.correct_attempts / stats.total_attempts) * 100;

    return res.json({
      ok: true,
      stats: {
        total_attempts: stats.total_attempts,
        correct_attempts: stats.correct_attempts,
        wrong_attempts: stats.wrong_attempts,
        accuracy: Number(accuracy.toFixed(2)),
        xp,
        level
      }
    });

  } catch (err) {
    console.error('Erro ao buscar stats: ', err);
    return res.status(500).json({
      ok: false,
      message: 'Erro ao buscar estatísticas do usuário'
    });
  }
});

/* ------------------------------------------------------
   NEXT EXERCISE — SEM ORDER BY, SEM LEFT JOIN
-------------------------------------------------------*/

// Nova rota inteligente
app.get('/next-exercise/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {
    // Exercícios que o usuário nunca tentou
    const [neverDoneRows] = await pool.query(
      `SELECT *
       FROM exercises
       WHERE id NOT IN (
          SELECT exercise_id FROM attempts WHERE user_id = ?
       )`,
       [user_id]
    );

    if (neverDoneRows.length > 0) {
      const randomIndex = Math.floor(Math.random() * neverDoneRows.length);
      return res.json({
        ok: true,
        mode: 'never_done',
        data: neverDoneRows[randomIndex]
      });
    }

    // Fallback: todos os exercícios
    const [allRows] = await pool.query(`SELECT * FROM exercises`);

    if (allRows.length === 0) {
      return res.json({
        ok: false,
        message: "Nenhum exercício cadastrado.",
        data: null
      });
    }

    const randomIndex = Math.floor(Math.random() * allRows.length);

    return res.json({
      ok: true,
      mode: 'random_fallback',
      data: allRows[randomIndex]
    });

  } catch (err) {
    console.error('Erro ao buscar next-exercise:', err);
    return res.status(500).json({
      ok: false,
      message: 'Erro ao buscar próximo exercício'
    });
  }
});

/* ------------------------------------------------------
   DASHBOARD
-------------------------------------------------------*/

// Dashboard consolidado
app.get('/dashboard/:user_id', async (req, res) => {
  const { user_id } = req.params;

  try {

    const [statsRows] = await pool.query(
      `SELECT 
         COUNT(*) AS total_attempts,
         SUM(is_correct) AS correct_attempts,
         SUM(CASE WHEN is_correct = 0 THEN 1 ELSE 0 END) AS wrong_attempts
       FROM attempts WHERE user_id = ?`,
      [user_id]
    );

    const stats = statsRows[0];

    const [userRows] = await pool.query(
      `SELECT name, xp, level FROM users WHERE id = ?`,
      [user_id]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ ok: false, message: 'Usuário não encontrado' });
    }

    const [nextRows] = await pool.query(
      `SELECT *
       FROM exercises
       WHERE id NOT IN (
          SELECT exercise_id FROM attempts WHERE user_id = ?
       )`,
       [user_id]
    );

    const next = nextRows.length
      ? nextRows[Math.floor(Math.random() * nextRows.length)]
      : null;

    return res.json({
      ok: true,
      user: userRows[0],
      stats,
      next_exercise: next
    });

  } catch (err) {
    console.error("Erro ao montar dashboard:", err);
    return res.status(500).json({ ok: false, message: 'Erro ao montar dashboard' });
  }
});



/* ------------------------------------------------------
   INICIAR SERVIDOR
-------------------------------------------------------*/
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
