import { loadEnvLocal } from './src/env.js';
import { requestFixes } from './src/llm.js';

await loadEnvLocal('D:/Agent/晨报');

try {
  const r = await requestFixes({
    verifyText: 'src/app.tsx(1,1): error TS6133: "unused_var" is declared but never used.',
    files: [{ path: 'src/app.tsx', content: 'const unused_var = 1;\n' }],
    round: 1,
    goal: 'fix unused variable'
  });
  console.log('LLM 响应:', JSON.stringify(r).slice(0, 500));
  console.log('SUCCESS');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
}
