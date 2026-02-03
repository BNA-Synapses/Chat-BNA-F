// bna/llmClient.js
// Cliente LLM usando Groq (nuvem). Com fallback em simulação local.

const axios = require('axios');
require('dotenv').config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.3-70b-versatile';

/**
 * callLLM(messages)
 * - messages: array no formato OpenAI/Groq [{ role, content }]
 * - retorna SEMPRE uma string (nunca joga erro pra fora)
 */
async function callLLM(messages) {
  // 1) Sem chave → simulação local
  if (!GROQ_API_KEY) {
    return [
      '[SIMULAÇÃO LLM - SEM GROQ_API_KEY]',
      'Mensagens recebidas:',
      JSON.stringify(messages, null, 2)
    ].join('\n');
  }

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        messages,
        temperature: 0.25,
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const content =
      response?.data?.choices?.[0]?.message?.content ||
      '[ERRO] Modelo não retornou conteúdo.';

    return content;
  } catch (err) {
    console.error('Erro ao chamar Groq:', err.message);

    // 2) Falha na requisição → simulação ao invés de quebrar
    return [
      '[SIMULAÇÃO LLM - FALHA NA CHAMADA GROQ]',
      `Erro: ${err.message}`,
      'Mensagens recebidas:',
      JSON.stringify(messages, null, 2)
    ].join('\n');
  }
}

module.exports = { callLLM };