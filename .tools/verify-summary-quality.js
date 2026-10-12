#!/usr/bin/env node
/**
 * verify-summary-quality.js —— 摘要质量实测（跑真实语料，不是看代码猜）。
 *
 * 2026-10-12 登录态实测发现：热点列表里大量条目的摘要就是标题的复读
 * （「王的猜想，刚刚扩展到四维 / 王的猜想，刚刚扩展到四维」），
 * 以及残留的「点击查看原文>」。本脚本把这两类缺陷量化。
 *
 * 判据说明：摘要与标题完全相同、或摘要以标题开头，都算**重复**——
 * 前者用户看到两遍同一句话，后者顶部冗余。这在信息流里是实打实的观感缺陷。
 *
 * 用法: node .tools/verify-summary-quality.js <hotspot.json>
 * 退出码: 0 = 达标；1 = 有项超标
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const target = process.argv[2] || path.join(ROOT, 'dist', 'api', 'hotspot.json');

const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
const items = Array.isArray(raw) ? raw : raw.items || [];

let exact = 0;       // 摘要 === 标题
let prefix = 0;      // 摘要以标题开头
let entity = 0;      // 残留「查看原文>」之类的半截 HTML
let ellipsis = 0;    // 以省略号收尾（说明截断有告知）
let atMax = 0;       // 码点数恰好等于上限
let empty = 0;
let maxLen = 0;
const samples = [];

for (const it of items) {
  const t = String(it.title || '').trim();
  const s = String(it.summary || '').trim();
  if (!s) { empty++; continue; }
  const n = Array.from(s).length;
  if (n > maxLen) maxLen = n;
  if (s === t) { exact++; if (samples.length < 3) samples.push('完全相同: ' + t); }
  else if (t && s.startsWith(t)) { prefix++; if (samples.length < 3) samples.push('以标题开头: ' + t); }
  if (/查看原文[>》]/.test(s)) { entity++; if (samples.length < 3) samples.push('残留半截标签: ' + s.slice(-24)); }
  if (s.endsWith('…')) ellipsis++;
  if (n === 80) atMax++;
}

const dup = exact + prefix;
const pct = items.length ? (100 * dup / items.length) : 0;
const entityPct = items.length ? (100 * entity / items.length) : 0;

// 阈值：重复超过 15% 说明去重逻辑缺失；残留半截标签超过 2% 视为需要修
const LIMITS = [
  ['摘要与标题重复率 ≤ 15%', pct <= 15, `${dup}/${items.length} = ${pct.toFixed(1)}%`],
  ['残留半截 HTML 率 ≤ 2%', entityPct <= 2, `${entity}/${items.length} = ${entityPct.toFixed(1)}%`],
  ['无空摘要', empty === 0, `${empty} 条为空`]
];

console.log(`语料: ${target}`);
console.log(`条数 ${items.length} / 最长摘要 ${maxLen} 码元 / 以省略号收尾 ${ellipsis} / 恰好达上限 ${atMax}`);
console.log(`摘要===标题 ${exact}｜摘要以标题开头 ${prefix}｜重复合计 ${pct.toFixed(1)}%`);
console.log(`残留「查看原文>」 ${entity} = ${entityPct.toFixed(1)}%`);
if (samples.length) {
  console.log('样本:');
  for (const s of samples) console.log('  · ' + s);
}
console.log('');
let bad = 0;
for (const [name, ok, detail] of LIMITS) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  [${detail}]`);
}
console.log(`\n${bad === 0 ? 'ALL PASS' : bad + ' FAILED'}`);
process.exit(bad === 0 ? 0 : 1);
