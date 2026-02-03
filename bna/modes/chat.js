// bna/modes/chat.js (CommonJS)
// Responsável por: selecionar state pelo "mode" e registrar no BrainContext
// Retorno padronizado: { userMessage, state, meta }

const BrainContext = require('../brain/BrainContext');
const BrainStates = require('../brain/BrainState');
const detectMode = require('../brain/DetectedMode'); // se existir e você quiser auto-detect

// Mapeia modos do front (ou do sistema) -> estados internos do BrainMode
const MODE_TO_STATE = {
  explain: BrainStates.EXPLICACAO,
  step: BrainStates.PASSO_A_PASSO,
  train: BrainStates.TREINO,
  review: BrainStates.REVISAO,
  test: BrainStates.PROVA,
  common_errors: BrainStates.ERRO_COMUM,
  apply: BrainStates.APLICACAO,
  chat: BrainStates.AUTO, // ou EXPLICACAO, se você preferir default fixo
};

// Prefixos opcionais (se você quiser “sinalizar” no texto)
const PREFIX = {
  [BrainStates.EXPLICACAO]: '🧠 Explicando com calma:\n',
  [BrainStates.PASSO_A_PASSO]: '🧩 Vamos passo a passo:\n',
  [BrainStates.TREINO]: '🏋️ Hora de treinar:\n',
  [BrainStates.REVISAO]: '🧾 Revisando:\n',
  [BrainStates.PROVA]: '⏱️ Modo prova:\n',
  [BrainStates.ERRO_COMUM]: '⚠️ Atenção a este erro comum:\n',
  [BrainStates.APLICACAO]: '🔧 Aplicação prática:\n',
};

function setBrainStateFromMode(mode, meta = {}) {
  const nextState = MODE_TO_STATE[mode];

  // fallback seguro: se o modo não existir, não muda nada
  if (!nextState) return null;

  if (BrainContext && typeof BrainContext.setState === 'function') {
    BrainContext.setState(nextState, {
      ...meta,
      source: 'chat',
      mode,
      timestamp: Date.now(),
    });
  }

  return nextState;
}

/**
 * Mod "chat": decide state a partir do mode (ou auto-detect se quiser)
 * @param {Object} params
 * @param {string} params.mode  - modo vindo do front: explain/step/train/review/test/common_errors/apply/chat
 * @param {Object} params.ctx   - contexto que o engine passa (ex: { rawMsg, currentState, meta })
 */
async function run({ mode, ctx }) {
  const rawMsg = String(ctx?.rawMsg ?? ctx?.msg ?? '').trim();
  const meta = ctx?.meta || {};

  let chosenMode = mode;

  // Se vier "chat" ou vier vazio, você pode auto-detectar pelo texto (opcional)
  if (!chosenMode || chosenMode === 'chat') {
    // Se você quiser auto-detectar de verdade:
    // const detected = detectMode(rawMsg);
    // if (detected) chosenMode = detected;

    // Se não quiser, deixa como chat mesmo
    chosenMode = chosenMode || 'chat';
  }

  const forcedState = setBrainStateFromMode(chosenMode, meta);

  // Se quiser prefixar mensagem (opcional)
  const prefix = forcedState ? (PREFIX[forcedState] || '') : '';
  const userMessage = prefix ? `${prefix}${rawMsg}` : rawMsg;

  return {
    userMessage,
    state: forcedState || null, // null = engine decide via detectIntent
    meta: { mode: chosenMode },
  };
}

module.exports = {
  MODE_TO_STATE,
  setBrainStateFromMode,
  run,
};