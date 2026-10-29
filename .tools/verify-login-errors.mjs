#!/usr/bin/env node
/**
 * verify-login-errors.mjs —— 登录错误**按 kind 分流**门禁（2026-10-29 审计复检 P1）
 *
 * 守的是「**不实告知**」这件事：
 *   原来 `src/pages/login/index.tsx` 的 `sdkDownText` 只判 `backend-unavailable` 一种，
 *   其余 kind 全部落到各分支的兜底文案 ⇒
 *     · `rate-limited`（被限流）→ 告诉用户「多半是网络抖了一下，再点一次」
 *       ⇒ 用户照着连续点，而连续点必然继续被拒 ⇒ 死循环；
 *     · `network` → 也说「网络抖了一下」，但正确说法是「连不上服务器，
 *       **这一步不是你的密码错了**」——否则用户先去改密码，方向完全错；
 *     · `invalid-request` → 归到通用文案，用户不知道自己该换什么。
 *
 * 判据分两组：
 *   A 源码结构：sdkDownText 至少分流 N 种 kind，且**每种映射到不同的 i18n 键**
 *     （都指向同一个键 = 分流了个寂寞）；
 *   B i18n 完整性：这些键在 zh 与 en **都**存在（en 的类型是 Record<keyof typeof zh>，
 *     TS 编译期会兜住，但门禁要给出可读的原因）。
 *
 * 另外守一条反枚举口径：不得把 `error.message` 直接透给用户。
 *
 * 用法: node .tools/verify-login-errors.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rows = [];
let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

const login = read('src/pages/login/index.tsx');
const lang = read('src/store/language.ts');

/* ───────────── A. sdkDownText 的分流结构 ───────────── */
const m = /function sdkDownText\(([\s\S]*?)\n\}/.exec(login);
assert('A1 登录页有 sdkDownText 归一函数', !!m);
const body = m ? m[0] : '';

// 取出 switch 里的 kind 分支（case 'xxx':）
const cases = [...body.matchAll(/case\s+'([^']+)'/g)].map((x) => x[1]);
const uniq = [...new Set(cases)];

// 归一化：把 rate_limited / invalid_request 这类下划线写法折算成连字符写法
const norm = (k) => k.replace(/_/g, '-');
const normCases = [...new Set(cases.map(norm))];

const REQUIRED = ['backend-unavailable', 'network', 'rate-limited', 'invalid-request'];
assert(
  'A2 sdkDownText 至少分流 4 种 kind（backend-unavailable / network / rate-limited / invalid-request）',
  REQUIRED.every((k) => normCases.includes(k)),
  `实际分流: ${normCases.join(', ') || '（无）'}`
);

// 每种 kind 映射到**不同**的 i18n 键：抓 case 后面第一个 t('...')
const keyOf = {};
{
  const re = /case\s+'([^']+)'\s*:\s*(?:case\s+'[^']+'\s*:\s*)?return\s+t\('([^']+)'\)/g;
  let mm;
  while ((mm = re.exec(body))) keyOf[norm(mm[1])] = mm[2];
}
assert(
  'A3 每种 kind 都映射到自己的 i18n 键（没有「分流了但都指向同一句」）',
  REQUIRED.every((k) => keyOf[k]),
  `映射: ${JSON.stringify(keyOf)}`
);
const mappedKeys = Object.values(keyOf);
assert(
  'A4 不同 kind 映射到不同文案（否则等于没分流）',
  new Set(mappedKeys).size === mappedKeys.length && mappedKeys.length >= 3,
  `keys=${JSON.stringify(mappedKeys)}`
);

/* ───────────── B. i18n 完整性（zh / en 都得有） ───────────── */
const zhStart = lang.indexOf('const zh = {');
const enStart = lang.indexOf('const en: Record<keyof typeof zh, string> = {');
assert('B0 language.ts 能定位 zh / en 两段', zhStart > 0 && enStart > zhStart);
const zhSec = zhStart > 0 && enStart > zhStart ? lang.slice(zhStart, enStart) : '';
const enSec = zhStart > 0 && enStart > zhStart ? lang.slice(enStart) : '';
for (const k of mappedKeys) {
  assert(`B1 中文有 ${k}`, zhSec.includes(`'${k}':`), '');
  assert(`B2 英文有 ${k}`, enSec.includes(`'${k}':`), '');
}
// 文案不得为空
for (const k of mappedKeys) {
  const mm = new RegExp(`'${k}':\\s*'([^']*)'`).exec(zhSec);
  assert(`B3 ${k} 的中文文案非空`, !!mm && mm[1].trim().length > 4, mm ? mm[1] : '未找到');
}

/* ───────────── C. 反枚举口径 + 调用点覆盖 ───────────── */
assert(
  'C1 不得把 error.message 直接透给用户（密码登录刻意不区分「账号不存在/密码错」）',
  !/set(Error|BindError)\(\s*[^)]*error\.message/.test(login),
  ''
);
// 所有错误展示点都必须过归一（要么 sdkDownText，要么显式兜底文案）
const errorShows = [...login.matchAll(/set(?:Error|BindError)\(([^\n]*)\)/g)].map((x) => x[1]);
const unguarded = errorShows.filter(
  (s) =>
    !/sdkDownText/.test(s) &&
    !/t\('auth\./.test(s) &&
    // setError('') 是「清空错误」，不是展示点
    !/^\s*''\s*$/.test(s) &&
    // setXxx(...) 里的 xxx 不是 setError/setBindError 本体
    !/set[A-Za-z]*\(/.test(s)
);
assert(
  'C2 所有错误展示点都过了归一或用了明确的兜底文案',
  unguarded.length === 0,
  `未覆盖: ${JSON.stringify(unguarded.slice(0, 5))}；全部展示点: ${JSON.stringify(errorShows)}`
);

/* ───────────── D. 云端确实会产生这些 kind ───────────── */
const cloudAuth = read('src/services/cloudAuth.ts');
assert(
  'D1 cloudAuth 至少造出 backend-unavailable 与 network 两种 kind',
  /kind:\s*'backend-unavailable'/.test(cloudAuth) && /kind:\s*'network'/.test(cloudAuth),
  ''
);
const sdk = read('src/assets/wb-sdk.js');
assert(
  'D2 SDK 产物里能查到 rate-limited（否则分流到的那一句永远走不到）',
  sdk.includes('rate-limited'),
  ''
);
assert(
  'D3 SDK 产物里能查到 network / invalid-request',
  sdk.includes('network') && sdk.includes('invalid-request'),
  ''
);

console.log('\n登录错误分流门禁');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
