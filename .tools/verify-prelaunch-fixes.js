#!/usr/bin/env node
/**
 * verify-prelaunch-fixes.js —— 上市前 8 项修复的回归闸门。
 *
 * 为什么单独写这个：这次改的绝大多数是**安全判定**（身份冒用、外链协议、同意前置）。
 * 这类代码「读一遍觉得对」毫无价值 —— 只有能跑出反例才算数。
 * 判据一律是「构造攻击输入 → 断言被拒」，不是「断言正常输入通过」。
 *
 * 覆盖：
 *   A. resolveCallerOpenid —— 客户端自传 openid 冒用（webSearch S-1）
 *   B. isSafeExternalUrl   —— javascript:/data:/file: 外链注入
 *   C. clampText/clampSummary —— 代理对截断乱码 + 省略号
 *   D. deleteAccount 集合清单覆盖所有按 openid 写入的集合
 *   E. 7 个云函数的 OPENID 空值拒绝（源码级 + 加载级）
 *   F. 免责声明按档位分支（免费档不得出现「AI 整理」）
 *   G. i18n 新增键中英双向齐全
 *
 * 用法: node .tools/verify-prelaunch-fixes.js
 * 退出码: 0 = 全 PASS；1 = 有 FAIL
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name);
  }
}

/* ============ 桩：wx-server-sdk 的 OPENID 与 env 都可控 ============ */

function makeStub(sdkCtx) {
  return {
    DYNAMIC_CURRENT_ENV: 'test',
    init: () => {},
    database: () => new Proxy(function () {}, sdkCtx.db),
    command: {},
    getWXContext: () => sdkCtx.ctx
  };
}

const sdkCtx = { ctx: { OPENID: '' }, db: {} };
require.cache['wx-server-sdk'] = { id: 'wx-server-sdk', filename: 'wx-server-sdk', loaded: true, exports: makeStub(sdkCtx) };
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return makeStub(sdkCtx);
  return origLoad.apply(this, arguments);
};

function freshRequire(rel) {
  const abs = require.resolve(path.join(ROOT, rel));
  delete require.cache[abs];
  return require(abs);
}

/* ============ A. resolveCallerOpenid —— 身份冒用 ============ */

process.env.INTERNAL_CALL_TOKEN = 'srv-secret-abc';
const ws = freshRequire('cloudfunctions/webSearch/index.js');
const { resolveCallerOpenid } = ws.__internals;

console.log('\n--- A. resolveCallerOpenid（客户端自传 openid 冒用）---');

// A1 有微信上下文时，event.openid 必须被忽略（小程序路径，身份不可伪造）
sdkCtx.ctx = { OPENID: 'REAL_USER_A' };
ok(
  'A1 有 OPENID 时忽略 event.openid（不能顶替成别人）',
  resolveCallerOpenid({ OPENID: 'REAL_USER_A' }, { openid: 'VICTIM_B' }) === 'REAL_USER_A'
);

// A2 无微信上下文 + 无令牌（H5 RPC 攻击路径）→ 必须拒绝
ok(
  'A2 无 OPENID 且无令牌 → 解析为空（H5 冒用被堵死）',
  resolveCallerOpenid({}, { openid: 'VICTIM_B' }) === ''
);

// A3 无微信上下文 + 空字符串令牌 → 拒绝
ok(
  'A3 空令牌不被当作通过',
  resolveCallerOpenid({}, { openid: 'VICTIM_B', __internalToken: '' }) === ''
);

// A4 无微信上下文 + 错误令牌 → 拒绝
ok(
  'A4 错误令牌 → 解析为空',
  resolveCallerOpenid({}, { openid: 'VICTIM_B', __internalToken: 'wrong-token' }) === ''
);

// A5 无微信上下文 + 令牌前缀（定长比较不能被前缀短路骗过）→ 拒绝
ok(
  'A5 令牌前缀不足以通过（定长比较）',
  resolveCallerOpenid({}, { openid: 'VICTIM_B', __internalToken: 'srv-secret-ab' }) === ''
);

// A6 服务端路径（getBriefing 定时任务）仍要能用 —— 这是修复不能误伤的回归点
ok(
  'A6 正确令牌 → 放行服务端代传（定时晨报不被误伤）',
  resolveCallerOpenid({}, { openid: 'USER_C', __internalToken: 'srv-secret-abc' }) === 'USER_C'
);

// A7 未配置 INTERNAL_CALL_TOKEN 时必须 fail-closed，而不是放行任何代传
delete process.env.INTERNAL_CALL_TOKEN;
ok(
  'A7 未配置令牌 → 服务端代传也被拒（fail closed，不退化成裸兜底）',
  resolveCallerOpenid({}, { openid: 'USER_C', __internalToken: '' }) === '' &&
    resolveCallerOpenid({}, { openid: 'USER_C', __internalToken: 'anything' }) === ''
);
process.env.INTERNAL_CALL_TOKEN = 'srv-secret-abc';

// A8 主入口确实走了新解析器
// ⚠️ 判据陷阱（2026-10-12 亲历）：**必须先剥注释再匹配**。修复时写的文档注释里会原文引用
// 旧的坏写法（`ctx.OPENID || (event && event.openid)`），正则照样命中 —— 那是假阳性，
// 报红后会反过来去改一段本来正确的代码。
{
  const raw = fs.readFileSync(path.join(ROOT, 'cloudfunctions/webSearch/index.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const bare = code.match(/OPENID\s*\|\|\s*\(\s*event\s*&&\s*event\.openid\s*\)/g);
  ok('A8 去注释后源码中已无裸 openid 兜底写法', !bare);
  if (bare) {
    code.split(/\r?\n/).forEach((l, i) => {
      if (/OPENID\s*\|\|\s*\(\s*event\s*&&\s*event\.openid/.test(l)) console.log('      实际命中行 ' + (i + 1) + ': ' + l.trim());
    });
  }
  // 注意排除函数定义本身：`function resolveCallerOpenid(ctx, event) {` 也会被同一个正则数进去
  const callSites = (code.match(/=\s*resolveCallerOpenid\(ctx, event\)/g) || []).length;
  ok('A8 两处取身份都是调用点（' + callSites + ' 处，排除函数定义）', callSites === 2);
  ok('A8 解析器自身仍认微信上下文优先', /function resolveCallerOpenid\(ctx, event\)\s*\{\s*if \(ctx\.OPENID\) return ctx\.OPENID;/.test(code));
}

// A9 getBriefing 调用方带上令牌
{
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getBriefing/index.js'), 'utf8');
  ok('A9 getBriefing 调用 webSearch 时携带 __internalToken', /__internalToken:\s*token/.test(src));
}

/* ============ C. 摘要截断 ============ */

console.log('\n--- C. clampSummary / clampText（代理对 + 省略号）---');
const { clampSummary } = ws.__internals;

// C1 截断不得切坏代理对：80 个 emoji 是 160 个码元，slice(0,80) 会切出半个代理对
{
  const src = Array.from({ length: 200 }, () => '\u{1F600}').join('');
  const out = clampSummary(src, 80);
  ok('C1 截断后无孤立代理对（不产生 U+FFFD）', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out));
  ok('C1 输出码点数 ≤ 上限', Array.from(out).length <= 80);
}

// C2 被截断时必须有省略号（线上实测 77/198 条恰好等于上限却毫无提示）
{
  const long = '内'.repeat(500);
  const out = clampSummary(long, 80);
  ok('C2 超长文本以省略号收尾', out.endsWith('…'));
  ok('C2 省略号后没有残留内容', Array.from(out).length === 80);
}

// C3 未超长时**不得**加省略号（否则短摘要会被误标成被截断）
{
  const short = '短摘要';
  ok('C3 未超长则原样返回且无省略号', clampSummary(short, 80) === short);
}

// C4 fetch-data.js 侧同规则
{
  const fsSrc = fs.readFileSync(path.join(ROOT, '.tools/fetch-data.js'), 'utf8');
  ok('C4 fetch-data.js 已改用 clampText（不再裸 slice(0,80)）', /clampText\(desc \|\| title, 80\)/.test(fsSrc));
  ok('C4 fetch-data.js 已无 (desc || title).slice(0, 80)', !/\(desc\s*\|\|\s*title\)\.slice\(0,\s*80\)/.test(fsSrc));
}

/* ============ D. deleteAccount 覆盖面 ============ */

console.log('\n--- D. deleteAccount 集合清单---');
{
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/deleteAccount/index.js'), 'utf8');
  // 所有按 openid 写入用户数据的集合（逐一对照 db.collection(...) 的实际写入点确认）
  const required = ['users', 'events', 'todos', 'items', 'briefings', 'usage', 'shopping', 'orders', 'user_prefs', 'user_affinity', 'newsFeedback'];
  const missing = required.filter((c) => !new RegExp("'" + c + "'").test(src));
  ok('D1 deleteAccount 覆盖全部 ' + required.length + ' 个用户数据集合', missing.length === 0);
  if (missing.length) console.log('      缺失: ' + missing.join(', '));

  // 反向校验：清单里的每个集合都真的存在 openid 字段（否则 where 删不到，等于假覆盖）
  // 注意口径：user_prefs / user_affinity 在 chat/index.js 里是以**常量**引用的
  // （PREFS_COLLECTION / AFFINITY_COLLECTION），按字面量 `collection('user_prefs')` 匹配
  // 会得到假阴性 —— 判据必须跟着代码的真实引用形式走。
  const writes = {
    shopping: { file: 'cloudfunctions/getBriefing/index.js', re: "collection\\('shopping'\\)" },
    orders: { file: 'cloudfunctions/createOrder/index.js', re: "collection\\('orders'\\)" },
    user_prefs: { file: 'cloudfunctions/chat/index.js', re: 'collection\\(PREFS_COLLECTION\\)' },
    user_affinity: { file: 'cloudfunctions/chat/index.js', re: 'collection\\(AFFINITY_COLLECTION\\)' },
    newsFeedback: { file: 'cloudfunctions/webSearch/index.js', re: "collection\\('newsFeedback'\\)" }
  };
  for (const [name, w] of Object.entries(writes)) {
    const s = fs.readFileSync(path.join(ROOT, w.file), 'utf8');
    const near = new RegExp(w.re + '[\\s\\S]{0,600}?openid').test(s);
    ok('D2 ' + name + ' 写入点确实带 openid 字段（where 能命中）', near);
  }
  // 常量本身的取值也要对得上，否则 D2 就是在验一个空壳
  {
    const s = fs.readFileSync(path.join(ROOT, 'cloudfunctions/chat/index.js'), 'utf8');
    ok("D2 chat 里 PREFS_COLLECTION 常量取值就是 'user_prefs'", /PREFS_COLLECTION\s*=\s*'user_prefs'/.test(s));
    ok("D2 chat 里 AFFINITY_COLLECTION 常量取值就是 'user_affinity'", /AFFINITY_COLLECTION\s*=\s*'user_affinity'/.test(s));
  }
}

/* ============ E. 7 个云函数 OPENID 空值拒绝 ============ */

console.log('\n--- E. 云函数 OPENID 空值拒绝---');
{
  const needGuard = ['getLibrary', 'updateSettings', 'confirmItem', 'shopping', 'createOrder', 'login', 'getUsage'];
  for (const fn of needGuard) {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions', fn, 'index.js'), 'utf8');
    const guarded = /if\s*\(\s*!OPENID\s*\)\s*throw\s+new\s+Error\('no openid'\)/.test(src);
    const destructured = /const\s*\{\s*OPENID\s*\}\s*=\s*cloud\.getWXContext\(\)/.test(src);
    ok('E ' + fn + ' 解构了 OPENID 且紧随其后有拒绝', guarded && destructured);
  }
  // getBriefing 是唯一合法的「无 OPENID」函数（定时触发器），不能被误加拒绝
  {
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/getBriefing/index.js'), 'utf8');
    ok('E getBriefing 保持定时器可无 OPENID（未被误改）', !/if\s*\(\s*!OPENID\s*\)\s*throw/.test(src));
  }
}

/* ============ F. 免责声明按档位分支 ============ */

console.log('\n--- F. 免责声明（免费档不得称「AI 整理」）---');
{
  const lang = fs.readFileSync(path.join(ROOT, 'src/store/language.ts'), 'utf8');
  const neutral = lang.match(/'common\.disclaimer':\s*'([^']*)'/g) || [];
  const withAi = lang.match(/'common\.disclaimerAI':\s*'([^']*)'/g) || [];
  ok('F1 中英两版都有 common.disclaimer（中性版）', neutral.length === 2);
  ok('F1 中英两版都有 common.disclaimerAI（AI 版）', withAi.length === 2);
  ok('F2 中性版**不含**「AI 整理」', !neutral.some((s) => s.includes('AI 整理')));
  ok('F2 英文中性版不含 AI-curated', !neutral.some((s) => s.includes('AI-curated')));
  ok('F3 AI 版**含**「AI 整理」', withAi.some((s) => s.includes('AI 整理')));

  // 晨报页必须按档位分支；资讯页（原始 RSS）必须走中性版
  const brief = fs.readFileSync(path.join(ROOT, 'src/pages/briefing/index.tsx'), 'utf8');
  ok('F4 晨报页按 aiEnabled/degraded 分支选署名',
    /intelResolved\.aiEnabled\s*&&\s*!intelResolved\.degraded\s*\?\s*'common\.disclaimerAI'\s*:\s*'common\.disclaimer'/.test(brief));
  const lib = fs.readFileSync(path.join(ROOT, 'src/pages/library/index.tsx'), 'utf8');
  ok('F5 资讯页不再引用 AI 版署名', !lib.includes('common.disclaimerAI'));
}

/* ============ G. i18n 新增键双向齐全 ============ */

console.log('\n--- G. i18n 新增键---');
{
  const lang = fs.readFileSync(path.join(ROOT, 'src/store/language.ts'), 'utf8');
  for (const key of ['auth.privacyNotice', 'auth.privacyAgree', 'auth.errPrivacy', 'common.disclaimerAI']) {
    const n = (lang.match(new RegExp("'" + key + "'", 'g')) || []).length;
    ok('G ' + key + ' 中英各一（共 ' + n + ' 处）', n === 2);
  }
  const login = fs.readFileSync(path.join(ROOT, 'src/pages/login/index.tsx'), 'utf8');
  ok('G 登录页接入了同意勾选与门禁',
    login.includes('privacyNotice') && login.includes('privacyAgree') &&
    login.includes('requirePrivacy') && login.includes('readPrivacyConsent'));
  // 同意必须默认关闭，且两个提交入口都被拦
  ok('G 默认不勾选（privacyOk 初始取本地值，未存即 false）',
    /useState\(readPrivacyConsent\)/.test(login));
  ok('G 提交与取码两个入口都调用了 requirePrivacy', (login.match(/if \(!requirePrivacy\(\)\) return;/g) || []).length >= 2);
}

/* ============ B. 外链协议白名单（esbuild 打真实 TS） ============ */

console.log('\n--- B. isSafeExternalUrl（外链协议注入）---');
(async function runExternalLinkTests() {
  const esbuild = require(path.join(ROOT, 'node_modules/esbuild'));
  const out = path.join(__dirname, '.cache', 'external-link.cjs');
  const taroStub = `
    export function setClipboardData(){ return Promise.resolve({}); }
    export function showToast(){ return Promise.resolve({}); }
    const T = { setClipboardData, showToast };
    export default T;
  `;
  // esbuild 的同步 API 不接受 plugins，所以这里必须走异步 build
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/utils/externalLink.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: out,
    define: { 'process.env.TARO_ENV': '"h5"' },
    plugins: [
      {
        name: 'taro-stub',
        setup(build) {
          build.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: 'taro-stub', namespace: 'stub' }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: taroStub, loader: 'js' }));
        }
      }
    ]
  });
  delete require.cache[require.resolve(out)];
  const { isSafeExternalUrl, openExternalPage } = require(out);

  const bad = [
    'javascript:alert(document.domain)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/System32/cmd.exe',
    '//evil.example.com/x',
    '/relative/path',
    '',
    '   '
  ];
  for (const u of bad) {
    ok('B1 拒绝 ' + JSON.stringify(u).slice(0, 46), isSafeExternalUrl(u) === false);
  }
  for (const u of ['http://example.com/a', 'https://example.com/a?b=1', 'https://sec.douban.com/x']) {
    ok('B2 放行 ' + u.slice(0, 46), isSafeExternalUrl(u) === true);
  }

  // 防过度修复：确认 openExternalPage 确实在入口处拦（而不只是有个没接上的工具函数）
  const origOpen = global.window;
  let touched = false;
  global.window = {
    open: () => { touched = true; return {}; },
    location: { set href(_v) { touched = true; } }
  };
  return Promise.resolve(openExternalPage('javascript:alert(1)'))
    .then((r) => {
      ok('B3 openExternalPage 对 javascript: 返回 failed', r === 'failed');
      ok('B3 且从未把它交给 window.open / location', touched === false);
      ok('B3 http 链接仍然放行（正常路径未被误伤）', isSafeExternalUrl('https://example.com') === true);
    })
    .finally(() => { global.window = origOpen; });
})().then(() => {
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
  console.error('测试脚本自身异常：', err);
  process.exit(1);
});