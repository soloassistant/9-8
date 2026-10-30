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

/* ───────────── E/F. 非 H5 通道：短信找回密码不可用 ⇒ 不给入口、不谎报 ─────────────
 *
 * 背景（2026-10-29 用户追问「手机号的忘记密码呢」时查出来的缺陷）：
 *   · 微信小程序端**没有短信通道**（身份由微信提供，云函数 login 拿 openid），
 *     压根不需要「账号 + 密码」这套 ⇒ 不该出现「忘记密码」入口；
 *   · 更严重的是 cloudAuth.requestPasswordResetByPhone 在非 H5 时**回 error: null**，
 *     而登录页 startReset 的判定是 `if (res.error) {...}` ⇒ 判不出来 ⇒ 走进
 *     「重置验证码已发送」分支 ⇒ **界面谎报「已发送」，实际一条短信都没发**。
 *
 * 两层判据：
 *   E 源码形状 —— **先剥注释**：源码注释里就写着「不能回 error: null」，
 *     不剥注释直接搜 'error: null' 会被**注释自己点亮**（假红）；
 *     反过来判「缺陷不存在」时也必须先剥 —— 注释不是事实。
 *   F 行为断言 —— **真跑**：esbuild 分别按 weapp / h5 编译 cloudAuth.ts，
 *     weapp 断言「回 error 且一次网络请求都没发」，
 *     h5 断言「确实发了请求、请求体符合服务端协议、服务端拒绝被如实带回」。
 */

/** 注释剥离（字符串感知）。理由见上面 E 组：注释不能当事实，也不能自己触发断言。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

const cloudAuthNoComment = stripComments(cloudAuth);
const fnIdx = cloudAuthNoComment.indexOf('export async function requestPasswordResetByPhone');
assert('E0 能定位 requestPasswordResetByPhone', fnIdx >= 0);
const branchIdx = fnIdx >= 0 ? cloudAuthNoComment.indexOf('if (!H5)', fnIdx) : -1;
assert('E1 requestPasswordResetByPhone 里必须有「非 H5 就早退」的分支', branchIdx >= 0);
const branchEnd = branchIdx >= 0 ? cloudAuthNoComment.indexOf('\n  }', branchIdx) : -1;
const noH5Branch = branchIdx >= 0 && branchEnd > branchIdx ? cloudAuthNoComment.slice(branchIdx, branchEnd) : '';
const branchFlat = noH5Branch.replace(/\s+/g, ' ').slice(0, 180);
assert(
  'E2 非 H5 分支必须回 error，且**不能**是 error: null（error:null 会让界面谎报「验证码已发送」）',
  /error\s*:/.test(noH5Branch) && !/error\s*:\s*null/.test(noH5Branch),
  branchFlat
);
assert(
  'E3 非 H5 分支的 error 必须带 kind（否则前端分流不出来，只能显示通用文案）',
  /kind\s*:\s*'[^']+'/.test(noH5Branch),
  branchFlat
);
assert(
  'E4 登录页必须按端判断（IS_H5 来自 process.env.TARO_ENV）',
  /const\s+IS_H5\s*=\s*process\.env\.TARO_ENV\s*===\s*'h5'/.test(login)
);
assert(
  'E5 手机号「忘记密码」引导行必须带 && IS_H5（小程序端没有短信通道，不给入口）',
  /channel\s*===\s*'phone'\s*&&\s*IS_H5\s*\?/.test(login)
);
assert(
  'E6 tabs 必须按端过滤掉 forgot（小程序端不渲染「忘记密码」页签）',
  /\.filter\(\s*\(k\)\s*=>\s*IS_H5\s*\|\|\s*k\s*!==\s*'forgot'\s*\)/.test(login)
);

/* ── F1/F2：tabs 计算**真跑**（求值，不是看源码形状） ──
 *  取源码里那段表达式，剥掉 TS 类型标注后直接 new Function 求值：
 * 源码写成「纯 JS 可求值」就是为了这里能真跑（IS_H5=false/true 两种）。
 * 求值失败 ⇒ 返回 null ⇒ F1/F2 判红并带出原因（不会静默放过）。 */
const tabsSnippet = (() => {
  const i = login.indexOf('const baseTabs');
  if (i < 0) return null;
  const j = login.indexOf('const tabs', i);
  if (j < 0) return null;
  const semi = login.indexOf(';', j);
  if (semi < 0) return null;
  return login.slice(i, semi + 1);
})();
const tabsJs = tabsSnippet ? tabsSnippet.replace(/:\s*Tab\[\]/g, '') : null;
let tabsEvalError = tabsJs ? null : '取不到 tabs 表达式（源码结构变了？）';
const evalTabs = (channel, isH5) => {
  if (!tabsJs) return null;
  try {
    return new Function('channel', 'IS_H5', `${tabsJs}\nreturn tabs;`)(channel, isH5);
  } catch (e) {
    tabsEvalError = String((e && e.message) || e);
    return null;
  }
};
const tabsWeappPhone = evalTabs('phone', false);
const tabsWeappEmail = evalTabs('email', false);
const tabsH5Phone = evalTabs('phone', true);
const tabsH5Email = evalTabs('email', true);
assert(
  'F1 小程序端（IS_H5=false）不得出现「忘记密码」页签',
  Array.isArray(tabsWeappPhone) && !tabsWeappPhone.includes('forgot') &&
  Array.isArray(tabsWeappEmail) && !tabsWeappEmail.includes('forgot'),
  `phone=${JSON.stringify(tabsWeappPhone)} email=${JSON.stringify(tabsWeappEmail)}${tabsEvalError ? ' 求值错误: ' + tabsEvalError : ''}`
);
assert(
  'F2 H5 端必须仍保留「忘记密码」页签（修小程序端不许把 H5 的入口一起删了）',
  Array.isArray(tabsH5Phone) && tabsH5Phone.includes('forgot') &&
  Array.isArray(tabsH5Email) && tabsH5Email.includes('forgot'),
  `phone=${JSON.stringify(tabsH5Phone)} email=${JSON.stringify(tabsH5Email)}${tabsEvalError ? ' 求值错误: ' + tabsEvalError : ''}`
);

/* ── F3–F8：cloudAuth **真跑**（esbuild 按端编译），断言行为而不是形状 ── */
async function loadCloudAuth(taroEnv) {
  const esbuild = await import('esbuild');
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/services/cloudAuth.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: 'node18',
    define: { 'process.env.TARO_ENV': JSON.stringify(taroEnv) },
    write: false,
    minify: false,
    treeShaking: false
  });
  const code = built.outputFiles[0].text;
  const mod = { exports: {} };
  const requireStub = (id) => { throw new Error(`cloudAuth 不该有外部依赖：${id}`); };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, requireStub);
  return mod.exports;
}

/** 真跑一次手机号重置：把 fetch 换掉计数，返回「调了几次 / 发了什么 / 回什么」。 */
async function probeReset(taroEnv) {
  const out = { env: taroEnv, calls: [], error: null, res: null, body: null };
  try {
    const api = await loadCloudAuth(taroEnv);
    if (!api || typeof api.requestPasswordResetByPhone !== 'function') {
      out.error = '编译产物里没有 requestPasswordResetByPhone';
      return out;
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      out.calls.push({ url: String(url), init });
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error_description: '账号不存在' })
      };
    };
    try {
      out.res = await api.requestPasswordResetByPhone('+8613800138000');
    } finally {
      globalThis.fetch = realFetch;
    }
    try {
      out.body = out.calls[0] ? JSON.parse(out.calls[0].init.body) : null;
    } catch {
      out.body = null;
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

const weappProbe = await probeReset('weapp');
const h5Probe = await probeReset('h5');

assert(
  'F3 小程序端必须回 error（不能是 error:null —— 那会让界面谎报「验证码已发送」）',
  weappProbe.error === null && !!weappProbe.res && !!weappProbe.res.error,
  weappProbe.error || JSON.stringify(weappProbe.res)
);
assert(
  'F4 小程序端必须完全离线短路：一次网络请求都不许发',
  weappProbe.error === null && weappProbe.calls.length === 0,
  `实际请求数=${weappProbe.calls.length}${weappProbe.error ? ' harness错误: ' + weappProbe.error : ''}`
);
assert(
  'F5 H5 端必须真的发请求（不能被 F3/F4 的短路误伤）',
  h5Probe.error === null && h5Probe.calls.length === 1,
  `实际请求数=${h5Probe.calls.length}${h5Probe.error ? ' harness错误: ' + h5Probe.error : ''}`
);
assert(
  'F6 H5 端请求体必须符合服务端协议：usage=PASSWORD_RESET / target=USER',
  !!h5Probe.body && h5Probe.body.usage === 'PASSWORD_RESET' && h5Probe.body.target === 'USER',
  JSON.stringify(h5Probe.body)
);
assert(
  'F7 手机号必须归一成「+CC 号码」（国家码后有空格）—— 服务端强校验 ^\\+[1-9][0-9]{0,3}\\s[0-9]{4,20}$',
  !!h5Probe.body && h5Probe.body.phone_number === '+86 13800138000',
  `phone_number=${h5Probe.body ? h5Probe.body.phone_number : 'n/a'}`
);
assert(
  'F8 服务端的业务拒绝必须被如实带回（不能被前端吞成「已发送」）',
  !!h5Probe.res && !!h5Probe.res.error && h5Probe.res.error.kind === 'invalid-request',
  JSON.stringify(h5Probe.res && h5Probe.res.error)
);

console.log('\n登录错误分流门禁');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
