#!/usr/bin/env node
/**
 * 外链门禁 `isSafeExternalUrl` 的持久化回归守卫（离线、确定性，可进 CI）。
 *
 * 为什么需要（2026-10-12）：
 *   这个函数是 H5 端 `window.open` / `window.location.href` 的**唯一**屏障，url 来自 RSS 抓回的
 *   外部内容。它已经被改坏过两次：
 *     · 最初版本只认绝对 http(s) → 把 H5 省心买入口 `/sxm/index.html` 一起拒了，入口被打死；
 *     · 放宽成「`/` 开头即站内」后 → `"/\t/evil.com"` 通过前缀检查，但 WHATWG 解析器会删掉 `\t`，
 *       实际解析成协议相对的 `//evil.com` → 跳到外站。
 *   两次都不是靠「读代码」发现的。所以把判定矩阵固化成断言，谁再调松谁当场变红。
 *
 * 直接对 **src/utils/externalLink.ts 源码** 转译后求值（不依赖 dist 产物），
 * 这样 CI 上不需要先 build，也不会因为产物过期而验错对象。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'utils', 'externalLink.ts');

// isH5 在模块顶层求值，必须在加载前设置
process.env.TARO_ENV = 'h5';

// @tarojs/taro 只在 openExternalPage 的剪贴板分支用到；本脚本只验 isSafeExternalUrl，
// 给它一个空桩即可，避免把 Taro 运行时拖进 node。
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extlink-stub-'));
const stubFile = path.join(stubDir, 'taro-stub.js');
fs.writeFileSync(stubFile, 'module.exports = { default: {}, setClipboardData: async () => {} };\n');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@tarojs/taro') return stubFile;
  return origResolve.call(this, request, ...rest);
};

let mod;
try {
  const ts = require('typescript');
  const code = fs.readFileSync(SRC, 'utf8');
  const out = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
  }).outputText;
  mod = new Module(SRC, null);
  mod.filename = SRC;
  mod.paths = Module._nodeModulePaths(path.join(ROOT, 'src', 'utils'));
  mod._compile(out, SRC);
} finally {
  Module._resolveFilename = origResolve;
  try {
    fs.rmSync(stubDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

const isSafeExternalUrl = mod.exports.isSafeExternalUrl;

// 真实线上 origin：用来做「放行的站内路径解析后必须仍在本站」这条不变量
const LIVE_ORIGIN = 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host/';
const LIVE_HOST = new URL(LIVE_ORIGIN).host;

/** [输入, 期望是否可跳转, 说明] */
const CASES = [
  // ── 必须放行
  ['/sxm/index.html', true, 'H5 省心买入口（站内子页）'],
  ['/pages/mine/index', true, '站内二级页'],
  ['/a/b?c=1#d', true, '站内带 query/hash'],
  ['/', true, '站内根路径'],
  ['https://soloassistant.github.io/shengxinmai/', true, '省心买耐久外链'],
  ['https://bb6ae4d03fbd4b109cbbe6dbbc84502d.app.workbuddy.host/', true, '灵犀外链'],
  ['http://example.com/x', true, 'http 外链'],
  [' https://x ', true, '首尾空白（trim 后合法）'],
  // ── 必须拒绝：伪协议
  ['javascript:alert(1)', false, 'javascript: 伪协议'],
  ['JavaScript:alert(1)', false, '大小写混淆'],
  ['JAVASCRIPT:alert(1)', false, '全大写'],
  [' data:text/html,x', false, '前导空格 + data:'],
  ['data:text/html,x', false, 'data: 伪协议'],
  ['file:///c:/x', false, 'file: 伪协议'],
  ['blob:https://x/y', false, 'blob: 伪协议'],
  ['httpx://x', false, '伪协议'],
  // ── 必须拒绝：协议相对 / 反斜杠 / 裸相对
  ['//evil.com', false, '协议相对（以 / 开头但指向外站）'],
  ['//evil.com/x', false, '协议相对带路径'],
  ['/\\evil.com', false, '斜杠 + 反斜杠伪装'],
  ['\\evil.com', false, '反斜杠开头'],
  ['/a\\b', false, '路径含反斜杠'],
  ['sxm/index.html', false, '裸相对路径（语义含糊）'],
  ['', false, '空串'],
  ['   ', false, '纯空白'],
  // ── 必须拒绝：控制字符让「字符串前缀」判断失效（本轮修复的那一类）
  ['/\t/evil.com', false, 'TAB 使 // 检查失效 → 解析成 //evil.com'],
  ['/\n/evil.com', false, 'LF'],
  ['/\r/evil.com', false, 'CR'],
  ['/\t\t/evil.com', false, '双 TAB'],
  ['/\t//evil.com', false, 'TAB + 双斜杠'],
  ['/\t/evil.com/../x', false, 'TAB + 路径回退'],
  ['/\u0000/evil.com', false, 'NUL'],
  ['/\u000b/evil.com', false, 'VT'],
  ['https://good.com\t.evil.com', false, '绝对 URL 里夹 TAB（解析后 host 被改写）'],
  ['java\tscript:alert(1)', false, '协议名里夹 TAB'],
];

let fail = 0;
let pass = 0;
const results = [];
const check = (name, ok, extra) => {
  if (ok) pass++;
  else fail++;
  results.push({ name, ok, extra });
};

for (const [input, expected, why] of CASES) {
  const got = isSafeExternalUrl(input);
  check(
    `isSafeExternalUrl(${JSON.stringify(input)}) === ${expected}  [${why}]`,
    got === expected,
    `got=${got}`,
  );
}

// ── 不变量 ①：凡判为 true 的站内路径，按真实 origin 解析后必须仍在本站
for (const [input, expected] of CASES) {
  if (expected !== true) continue;
  const u = input.trim();
  if (!u.startsWith('/')) continue;
  let host = null;
  try {
    host = new URL(u, LIVE_ORIGIN).host;
  } catch {
    /* 解析失败则本就该被拒，交给上面的矩阵断言 */
  }
  check(
    `放行的站内路径 ${JSON.stringify(input)} 解析后仍在本站`,
    host === LIVE_HOST,
    `host=${host}`,
  );
}

// ── 不变量 ②：不存在「解析后落在外部 host、却仍被判为可跳转」的输入
const LEAKS = [
  '/\t/evil.com',
  '/\r\n/evil.com',
  '//evil.com',
  '/\t//attacker.example',
  'https://good.com\t.evil.com',
];
for (const input of LEAKS) {
  let host = null;
  try {
    host = new URL(input.trim(), LIVE_ORIGIN).host;
  } catch {
    /* 解析失败 = 不会跳转，安全 */
  }
  const outside = host !== null && host !== LIVE_HOST;
  check(
    `${JSON.stringify(input)} 解析去向为外部（${host || '解析失败'}）时必须被拒`,
    !outside || isSafeExternalUrl(input) === false,
    `outside=${outside} allowed=${isSafeExternalUrl(input)}`,
  );
}

// ── 非字符串入参：必须走 false 分支而不是抛错
for (const v of [undefined, null, 123, {}, [], true, Symbol('s')]) {
  let got;
  let threw = null;
  try {
    got = isSafeExternalUrl(v);
  } catch (e) {
    threw = e && e.message;
  }
  check(
    `非字符串入参 ${String(v && typeof v === 'object' ? typeof v : v)} 不抛错且判否`,
    threw === null && got === false,
    threw ? `threw=${threw}` : `got=${got}`,
  );
}

console.log('=== 外链门禁 isSafeExternalUrl 回归 ===');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  (${r.extra})`}`);
}
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
