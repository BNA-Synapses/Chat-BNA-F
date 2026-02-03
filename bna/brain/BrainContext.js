// bna/brain/BrainContext.js
const BrainStates = require('./BrainState');

const ALLOWED_STATES = new Set(Object.values(BrainStates));

// transições simples (pode ajustar depois)
const TRANSITIONS = {
  [BrainStates.EXPLICACAO]: new Set([
    BrainStates.EXPLICACAO,
    BrainStates.PASSO_A_PASSO,
    BrainStates.TREINO,
    BrainStates.REVISAO,
    BrainStates.APLICACAO,
    BrainStates.PROVA,
    BrainStates.ERRO_COMUM,
  ]),
  [BrainStates.PASSO_A_PASSO]: new Set([
    BrainStates.PASSO_A_PASSO,
    BrainStates.EXPLICACAO,
    BrainStates.TREINO,
    BrainStates.REVISAO,
    BrainStates.PROVA,
    BrainStates.ERRO_COMUM,
    BrainStates.APLICACAO,
  ]),
  [BrainStates.TREINO]: new Set([
    BrainStates.TREINO,
    BrainStates.REVISAO,
    BrainStates.EXPLICACAO,
    BrainStates.PASSO_A_PASSO,
    BrainStates.ERRO_COMUM,
  ]),
  [BrainStates.REVISAO]: new Set([
    BrainStates.REVISAO,
    BrainStates.TREINO,
    BrainStates.EXPLICACAO,
    BrainStates.PASSO_A_PASSO,
    BrainStates.APLICACAO,
  ]),
  [BrainStates.PROVA]: new Set([
    BrainStates.PROVA,
    BrainStates.EXPLICACAO,
    BrainStates.PASSO_A_PASSO,
    BrainStates.ERRO_COMUM,
  ]),
  [BrainStates.ERRO_COMUM]: new Set([
    BrainStates.ERRO_COMUM,
    BrainStates.EXPLICACAO,
    BrainStates.PASSO_A_PASSO,
    BrainStates.TREINO,
  ]),
  [BrainStates.APLICACAO]: new Set([
    BrainStates.APLICACAO,
    BrainStates.EXPLICACAO,
    BrainStates.PASSO_A_PASSO,
    BrainStates.REVISAO,
  ]),
};

const BrainContext = {
  currentState: BrainStates.EXPLICACAO,
  meta: { mode: 'explain', source: 'boot', ts: Date.now() },

  setState(nextState, meta = {}) {
    if (!ALLOWED_STATES.has(nextState)) return false;

    const from = this.currentState;
    const allowed = TRANSITIONS[from] || new Set([from]);

    if (!allowed.has(nextState)) return false;

    this.currentState = nextState;
    this.meta = {
      ...this.meta,
      ...meta,
      ts: Date.now(),
    };
    return true;
  },

  getState() {
    return this.currentState;
  },

  getMeta() {
    return this.meta || {};
  },

  reset(meta = {}) {
    this.currentState = BrainStates.EXPLICACAO;
    this.meta = { mode: 'explain', source: 'reset', ts: Date.now(), ...meta };
  },
};

module.exports = BrainContext;