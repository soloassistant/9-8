import { loadEnvLocal } from './src/env.js';
await loadEnvLocal('D:/Agent/晨报');

const apiKey = process.env.CODEFIX_LLM_API_KEY;
const baseUrl = process.env.CODEFIX_LLM_BASE_URL;
const model = process.env.CODEFIX_LLM_MODEL;

console.log('Key:', apiKey?.slice(0, 8) + '...' + apiKey?.slice(-4));
console.log('Base URL:', baseUrl);
console.log('Model:', model);

// 尝试不同的模型名
const models = ['glm-4.7-flash', 'glm-4-flash', 'glm-4.6-flash', 'glm-4.5-flash', 'glm-4.7'];

for (const m of models) {
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: m,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
      }),
    });
    const text = await resp.text();
    console.log(`${m}: HTTP ${resp.status} - ${text.slice(0, 150)}`);
    if (resp.ok) break;
  } catch (e) {
    console.log(`${m}: ${e.message}`);
  }
}
