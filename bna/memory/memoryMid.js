// bna/memoryMid.js
const pool = require('../../db/connection');

// ajuda a manter lista de tópicos pequena e sem repetição
function appendTopic(prevTopics, topic) {
  if (!topic) return prevTopics || '';

  const list = (prevTopics || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  if (!list.includes(topic)) {
    list.push(topic);
  }

  // mantemos só os últimos 5 tópicos
  return list.slice(-5).join(', ');
}

/**
 * Registra uma tentativa de exercício no "médio prazo"
 * - atualiza / cria o resumo do dia do aluno
 */
async function registerSolve({ userId, isCorrect, exercise }) {
  if (!userId) return;

  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const topic = exercise.topic || 'geral';

  // busca se já existe linha pra esse usuário nesse dia
  const [rows] = await pool.query(
    `
    SELECT id, total_attempts, correct_attempts, wrong_attempts, last_topics
    FROM user_daily_stats
    WHERE user_id = ? AND stat_date = ?
    `,
    [userId, today]
  );

  if (rows.length === 0) {
    // cria linha nova
    const totalAttempts = 1;
    const correctAttempts = isCorrect ? 1 : 0;
    const wrongAttempts = isCorrect ? 0 : 1;
    const lastTopics = topic;

    await pool.query(
      `
      INSERT INTO user_daily_stats
        (user_id, stat_date, total_attempts, correct_attempts, wrong_attempts, last_topics)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [userId, today, totalAttempts, correctAttempts, wrongAttempts, lastTopics]
    );
  } else {
    // atualiza linha existente
    const current = rows[0];

    const totalAttempts = current.total_attempts + 1;
    const correctAttempts = current.correct_attempts + (isCorrect ? 1 : 0);
    const wrongAttempts = current.wrong_attempts + (isCorrect ? 0 : 1);

    const lastTopics = appendTopic(current.last_topics, topic);

    await pool.query(
      `
      UPDATE user_daily_stats
      SET total_attempts = ?, correct_attempts = ?, wrong_attempts = ?, last_topics = ?
      WHERE id = ?
      `,
      [totalAttempts, correctAttempts, wrongAttempts, lastTopics, current.id]
    );
  }
}

/**
 * Gera um textinho-resumo do dia do aluno
 * pra ser usado no prompt do BNA
 */
async function getMPT(userId) {
  if (!userId) return '';

  const today = new Date().toISOString().slice(0, 10);

  const [rows] = await pool.query(
    `
    SELECT total_attempts, correct_attempts, wrong_attempts, last_topics
    FROM user_daily_stats
    WHERE user_id = ? AND stat_date = ?
    `,
    [userId, today]
  );

  if (rows.length === 0) {
    return '';
  }

  const stats = rows[0];
  const { total_attempts, correct_attempts, wrong_attempts, last_topics } = stats;

  const hitRate =
    total_attempts > 0
      ? Math.round((correct_attempts / total_attempts) * 100)
      : 0;

  let summary = `Tentativas hoje: ${total_attempts} (acertos: ${correct_attempts}, erros: ${wrong_attempts}, taxa de acerto: ${hitRate}%).`;

  if (last_topics) {
    summary += ` Tópicos recentes trabalhados: ${last_topics}.`;
  }

  return summary;
}

module.exports = {
  registerSolve,
  getMPT,
};