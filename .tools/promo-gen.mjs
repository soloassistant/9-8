#!/usr/bin/env node
/**
 * 促销码生成器（2026-10-25）—— 生成明文码 + SHA-256 哈希，供 src/utils/promo.ts 的 PROMO_CODES 使用。
 * 用法：
 *   node .tools/promo-gen.mjs [天数=30] [截止日=YYYY-MM-DD]
 * 输出：明文码（发给用户，不进仓库！）+ 可直接粘贴的 PROMO_CODES 条目。
 * 注意：明文码一旦发出且写进 PROMO_CODES，就随包分发 —— 撤销只能等 goodUntil 过期。
 */
import crypto from 'node:crypto';

const days = Number(process.argv[2] || 30);
const goodUntil = process.argv[3] || (() => {
  const d = new Date();
  d.setMonth(d.getMonth() + 2);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 无 I/O/0/1 —— 防辨认混淆
const seg = () => Array.from(crypto.randomBytes(4)).map((b) => alphabet[b % alphabet.length]).join('');
const code = `PRO-${seg()}-${seg()}`;
const hash = crypto.createHash('sha256').update(code).digest('hex');

console.log('======== 促销码已生成（明文不进仓库，直接发给用户）========');
console.log(`明文码:  ${code}`);
console.log(`开通:    ${days} 天`);
console.log(`活动截止: ${goodUntil}`);
console.log('\n粘贴到 src/utils/promo.ts 的 PROMO_CODES：');
console.log(`  { hash: '${hash}', planDays: ${days}, goodUntil: '${goodUntil}' }`);
