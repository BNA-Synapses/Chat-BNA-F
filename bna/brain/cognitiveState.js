/**
 * Cognitive State Manager (V3.1)
 * Mantém o "estado cognitivo" do usuário (ex: chat, treino, feedback_coach)
 * com fallback em memória. Se houver db (mysql2/promise pool), persiste em tabela user_state.
 */
"use strict";

const DEFAULT_STATE = "chat"; // chat livre por padrão

const STATES = Object.freeze({
  CHAT: "chat",
  TRAIN: "train",
  EXERCISE: "exercise",
  FEEDBACK_COACH: "feedback_coach",
});

function normalizeState(s) {
  const x = String(s || "").trim().toLowerCase();
  if (!x) return DEFAULT_STATE;
  // aliases comuns
  if (x === "treino" || x === "training") return STATES.TRAIN;
  if (x === "exercicios" || x === "exercício" || x === "drill") return STATES.EXERCISE;
  if (x === "coach" || x === "feedback" || x === "feedback_coach" || x === "feedbackcoach") return STATES.FEEDBACK_COACH;
  if (x === "chat" || x === "free") return STATES.CHAT;
  return x;
}

// DB (opcional)
async function ensureTable(pool) {
  // cria "user_state" se não existir (idempotente)
  const sql = `
    CREATE TABLE IF NOT EXISTS user_state (
      user_id VARCHAR(64) PRIMARY KEY,
      state VARCHAR(32) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `;
  await pool.query(sql);
}

async function getStateFromDb(pool, userId) {
  const [rows] = await pool.query("SELECT state FROM user_state WHERE user_id = ? LIMIT 1", [String(userId)]);
  if (!rows || !rows.length) return null;
  return rows[0].state || null;
}

async function setStateInDb(pool, userId, state) {
  const uid = String(userId);
  const st = normalizeState(state);
  await pool.query(
    "INSERT INTO user_state (user_id, state) VALUES (?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = CURRENT_TIMESTAMP",
    [uid, st]
  );
  return st;
}

/**
 * Factory que recebe:
 * - memory: módulo atual de memória (tem getUserState/setUserState)
 * - pool: mysql2 pool (opcional)
 */
function createCognitiveState({ memory, pool } = {}) {
  const mem = memory;

  async function init() {
    if (!pool) return;
    try { await ensureTable(pool); } catch (_) { /* silent */ }
  }

  async function getUserState(userId) {
    const uid = String(userId || "anon");
    // 1) DB
    if (pool) {
      try {
        const dbState = await getStateFromDb(pool, uid);
        if (dbState) {
          // espelha em memória para facilitar
          if (mem && typeof mem.setUserState === "function") mem.setUserState(uid, dbState);
          return normalizeState(dbState);
        }
      } catch (_) { /* ignore */ }
    }
    // 2) memória
    if (mem && typeof mem.getUserState === "function") {
      const st = mem.getUserState(uid);
      return normalizeState(st || DEFAULT_STATE);
    }
    return DEFAULT_STATE;
  }

  async function setUserState(userId, state) {
    const uid = String(userId || "anon");
    const st = normalizeState(state || DEFAULT_STATE);
    // 1) memória
    if (mem && typeof mem.setUserState === "function") mem.setUserState(uid, st);
    // 2) DB
    if (pool) {
      try { await setStateInDb(pool, uid, st); } catch (_) { /* ignore */ }
    }
    return st;
  }

  function transition(prev, event) {
    const p = normalizeState(prev);
    const e = String(event || "").trim().toLowerCase();
    if (e === "after_solve") return STATES.FEEDBACK_COACH;
    if (e === "open_chat") return STATES.CHAT;
    if (e === "open_train") return STATES.TRAIN;
    if (e === "open_exercise") return STATES.EXERCISE;
    return p;
  }

  return { init, STATES, normalizeState, getUserState, setUserState, transition };
}

module.exports = { createCognitiveState, STATES, DEFAULT_STATE, normalizeState };
