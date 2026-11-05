#!/usr/bin/env node
/**
 * verify-locate-copy —— 定位失败文案分类门禁（PR-2，2026-11-05）
 *
 * 防的是什么：用户明明在「非安全上下文」或「超时」时，页面却提示「未授权定位」。
 * 假原因会让人反复去改系统权限，永远修不好，所以把「四类失败各自不同文案」写成断言：
 *   1) 六个类别 key 在中英字典里都必须存在；
 *   2) 六条文案两两不同（code=1 拒绝 / code=2 不可用 / code=3 超时不得复用同一句）；
 *   3) 非安全上下文文案不得出现「未授权 / 无权限」（英文不得出现 unauthorized / denied）；
 *   4) briefing 页必须把每个类别都映射到对应 key（而不是退回默认文案）。
 *
 * 用法：node .tools/verify-locate-copy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'src');

const KEYS = [
  'briefing.locateDenied',        // 本次拒绝（geolocation code=1）
  'briefing.locateFailBlocked',   // 永久拒绝（需引导 openSetting）
  'briefing.locateFailInsecure',  // 非安全上下文
  'briefing.locateFailTimeout',   // code=3
  'briefing.locateFailUnavailable', // code=2
  'briefing.locateFailUnsupported'  // 环境无 geolocation
];

/** 从 language.ts 抽出顶层 zh / en 字典（简易解析，只认 'key': 'value' 形式） */
function extractDict(src, name) {
  const i = src.indexOf('const ' + name);
  if (i < 0) return null;
  const start = src.indexOf('{', i);
  let depth = 0;
  let end = -1;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      j++;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(start + 1, end);
  const out = {};
  const re = /'((?:[^'\\]|\\.)+)'\s*:\s*('((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  let m;
  while ((m = re.exec(body))) {
    out[m[1]] = String(m[3] !== undefined ? m[3] : m[4]).replace(/\\n/g, '\n').replace(/\\'/g, "'");
  }
  return out;
}

const langSrc = fs.readFileSync(path.join(SRC, 'store/language.ts'), 'utf8');
const zh = extractDict(langSrc, 'zh');
const en = extractDict(langSrc, 'en');
if (!zh || !en) {
  console.log('FAIL 无法从 src/store/language.ts 解析 zh / en 字典');
  process.exit(1);
}

const problems = [];
const texts = { zh: {}, en: {} };

for (const key of KEYS) {
  for (const [lang, dict] of [['zh', zh], ['en', en]]) {
    if (dict[key] == null) problems.push(`[${lang}] 缺少 key：${key}`);
    else texts[lang][key] = dict[key];
  }
}

/** 断言 2：同语言内六条文案两两不同（code=1 / 2 / 3 不得共用同一句） */
for (const lang of ['zh', 'en']) {
  const seen = {};
  for (const key of KEYS) {
    const v = texts[lang][key];
    if (v == null) continue;
    if (seen[v]) problems.push(`[${lang}] ${key} 与 ${seen[v]} 文案相同：${JSON.stringify(v)}`);
    else seen[v] = key;
  }
}

/** 断言 3：非安全上下文不得说成「未授权」 */
const insecureZh = texts.zh['briefing.locateFailInsecure'];
const insecureEn = texts.en['briefing.locateFailInsecure'];
if (insecureZh && /未授权|无权限/.test(insecureZh)) {
  problems.push(`[zh] 非安全上下文文案含「未授权/无权限」：${JSON.stringify(insecureZh)}`);
}
if (insecureEn && /unauthori[sz]ed|not authorized|permission denied|denied/i.test(insecureEn)) {
  problems.push(`[en] 非安全上下文文案含 unauthorized/denied：${JSON.stringify(insecureEn)}`);
}

/** 断言 4：briefing 页必须为每个类别显式映射 key */
const briefing = fs.readFileSync(path.join(SRC, 'pages/briefing/index.tsx'), 'utf8');
for (const key of KEYS) {
  if (!briefing.includes(`'${key}'`)) problems.push(`briefing/index.tsx 未映射 ${key}`);
}

console.log(`verify-locate-copy：检查 ${KEYS.length} 个定位失败文案 key（zh/en）`);
for (const p of problems) console.log(`  ✗ ${p}`);
if (problems.length) {
  console.log(`\nFAIL ${problems.length}（四类失败必须给不同文案；非安全上下文不得说「未授权」）`);
  process.exit(1);
}
console.log('\nPASS 六类定位失败文案齐全、互不相同，非安全上下文不含「未授权」');
