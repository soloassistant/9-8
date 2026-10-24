/**
 * verify-cloudfunctions.mjs —— 云函数离线门禁（无凭据、无 wx-server-sdk 也能跑）
 *
 * 用法：node .tools/verify-cloudfunctions.mjs        （等价 npm run verify:cloudfunctions）
 *
 * 为什么需要它：
 *   24 个云函数当前**一个都部署不了**（缺 WX_APPID / WX_PRIVATE_KEY_PATH / WX_CLOUD_ENV，
 *   根因是小程序主体未注册）。在拿到凭据之前，没有任何东西会去加载这些文件——
 *   也就是说一个语法错误、漏掉的 exports.main、退化的 openid 守卫，可以静静躺上几个月，
 *   直到第一次真部署那天才炸，而且炸在线上。本脚本把它们拉进 CI 的日常射程。
 *
 * 它不做什么（避免误解）：
 *   · 不验证微信侧的任何行为（没有真实 SDK、没有真实数据库）；
 *   · 不验证业务逻辑正确性（那是各 verify:* 脚本的事）；
 *   · 不替代真部署后的控制台核对。
 *   它只守住「结构完整 + 能被加载 + 权限边界不退坡」这三类不变量。
 *
 * 实现要点：
 *   用 vm 加载每个 index.js，注入伪造的 require：
 *     - node 内置模块 / 已安装的真包 → 交给真实 require；
 *     - 裸包名（wx-server-sdk、alipay-sdk）→ 递归 Proxy 桩；
 *     - 相对路径（./llm、./news-trust.js）→ 递归 Proxy 桩（不递归真加载，避免桩传播），
 *       但它指向的文件**必须在磁盘上真实存在**，这一条单独断言。
 *   wx-server-sdk 桩的 getWXContext() 默认返回 {}（OPENID 为空），
 *   于是「守卫在位」可以被行为化验证，而不是靠 grep 关键词。
 *
 * 断言纪律：只有 cond === true 才算 PASS。失败分支不得返回非空字符串（会被判 truthy → 假绿）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_DIR = path.join(REPO, 'cloudfunctions');

/* ------------------------------------------------------------------ *
 * 身份分类表（必须与实际代码精确相等；新增函数不登记就会 FAIL）
 * ------------------------------------------------------------------ */

/**
 * 读取微信上下文且**必须**拒绝空 OPENID 的函数（probe 是触发该分支的最小 event）
 *
 * 大多数函数在 main 开头就判 `if (!OPENID) throw`，传 {} 即可命中；
 * webSearch 是**混合口径**：hotspot / videoNews 是公开内容，按设计免 openid；
 * 只有 briefing / feedback / aiFilter 这几条涉及个人数据与额度的分支要求身份，
 * 所以必须用 { action:'briefing' } 才能探到守卫，用 {} 会走 hotspot 去打外网 RSS。
 */
const OPENID_GUARDED = [
  { name: 'chat', probe: {} },
  { name: 'confirmItem', probe: {} },
  { name: 'createOrder', probe: {} },
  { name: 'deleteAccount', probe: {} },
  { name: 'extract', probe: {} },
  { name: 'feedback', probe: {} },
  { name: 'getBriefing', probe: {} },
  { name: 'getLibrary', probe: {} },
  { name: 'getUsage', probe: {} },
  { name: 'login', probe: {} },
  { name: 'ordersList', probe: {} },
  { name: 'pay-wechat', probe: {} },
  { name: 'refundOrder', probe: {} },
  { name: 'reportError', probe: {} },
  { name: 'shopping', probe: {} },
  { name: 'todoStatus', probe: {} },
  { name: 'updateSettings', probe: {} },
  { name: 'webSearch', probe: { action: 'briefing' }, note: '混合口径：hotspot/videoNews 免 openid' }
];

/** 读取微信上下文但**允许** OPENID 为空的函数 —— 每条必须写明理由 */
const OPENID_OPTIONAL = {
  queryOrder: '前端直连必带 OPENID 且做归属校验；closeOrder 内部扫描调用拿不到 WXContext，为空时跳过校验',
  'pay-alipay': '预留通道，当前 src/ 下无调用方；接入前必须先补 OPENID 归属校验（见 docs/云函数部署指南.md）'
};

/**
 * 判定「缺 OPENID 的响应是否算拒绝」。
 *
 * 不能一律要求 throw：本仓有两种合法的拒绝风格 —— 抛错（多数函数），
 * 以及返回带显式失败标记的结构体（ordersList 的 {ok:false,error}、
 * reportError 的 {ok:false,skip,reason}、webSearch 的 {code:-1,message}）。
 * 但**必须同时带上原因字段**，否则一个光秃秃的 {ok:false} 无法与「静默吞掉」区分。
 *
 * 反过来，只要返回值看起来像业务数据（没有失败标记），就判失败 ——
 * 这正是 getBriefing 原本的问题：缺 OPENID 时它照样返回一份完整晨报。
 */
function isExplicitRejection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hasReason = ['error', 'reason', 'message'].some(
    (k) => typeof value[k] === 'string' && value[k].trim() !== ''
  );
  if (!hasReason) return false;
  const okFalse = value.ok === false;
  const codeNonZero = typeof value.code === 'number' && value.code !== 0;
  return okFalse || codeNonZero;
}

/* ------------------------------------------------------------------ *
 * 断言框架
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond === true) {
    pass += 1;
    console.log('  PASS ' + name);
  } else {
    fail += 1;
    const d = detail == null ? '' : String(detail);
    failures.push(name + (d ? ' :: ' + d : ''));
    console.log('  FAIL ' + name + (d ? '  :: ' + d : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------------ *
 * 伪造 require / 沙箱
 * ------------------------------------------------------------------ */

/** 递归 Proxy 桩：任意属性访问返回自身，可调用、可 new、await 时立即落地 */
function makeStub(label) {
  const target = function stub() {};
  const handler = {
    get(_t, prop) {
      if (prop === 'then') return undefined;               // 关键：避免被当成 thenable 挂死
      if (prop === Symbol.toPrimitive) return () => label;
      if (prop === 'toString') return () => label;
      if (prop === Symbol.iterator) return undefined;
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
    has() { return true; }
  };
  const proxy = new Proxy(target, handler);
  return proxy;
}

const realRequire = createRequire(path.join(REPO, 'package.json'));

/** wx-server-sdk 桩：getWXContext 返回给定的上下文 */
function makeWxStub(ctx, log) {
  const base = {
    DYNAMIC_CURRENT_ENV: '__DYNAMIC_CURRENT_ENV__',
    init() { return undefined; },
    database() { return makeStub('db'); },
    getWXContext() { return ctx; },
    uploadFile: async () => ({ fileID: 'stub' }),
    downloadFile: async () => ({ fileContent: Buffer.alloc(0) }),
    deleteFile: async () => ({ fileList: [] }),
    getTempFileURL: async () => ({ fileList: [] }),
    callFunction: async () => ({ result: {} }),
    openapi: makeStub('openapi'),
    httpclient: makeStub('httpclient')
  };
  return new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'then') return undefined;
      return makeStub('wx.' + String(prop));
    }
  });
}

/**
 * 在沙箱里加载一个云函数，返回 { exports, loadError }
 * @param {string} file 绝对路径
 */
function loadFunction(file, ctx) {
  const dir = path.dirname(file);
  const sandboxRequire = (spec) => {
    if (spec === 'wx-server-sdk') return makeWxStub(ctx, () => {});
    if (spec.startsWith('.') || spec.startsWith('/')) return makeStub(spec);
    try {
      return realRequire(spec);
    } catch {
      return makeStub(spec);
    }
  };

  const quietConsole = {
    log: () => {}, info: () => {}, warn: () => {},
    error: () => {}, debug: () => {}
  };

  const sandbox = {
    module: { exports: {} },
    exports: null,
    require: sandboxRequire,
    console: quietConsole,
    process: { env: { ...process.env }, platform: process.platform, version: process.version, nextTick: (fn) => fn() },
    Buffer,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams,
    TextEncoder, TextDecoder,
    __dirname: dir,
    __filename: file
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  try {
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file, timeout: 5000 });
    return { exports: sandbox.module.exports, loadError: null };
  } catch (err) {
    return { exports: null, loadError: err };
  }
}

/** 调用 main 并判定「是否拒绝」；带超时兜底，避免桩环境下意外挂死 */
async function callExpectReject(mainFn, event) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 3000));
  const run = (async () => {
    try {
      const value = await mainFn(event);
      return { kind: 'resolved', value };
    } catch (err) {
      return { kind: 'rejected', err };
    }
  })();
  return Promise.race([run, timeout]);
}

/* ------------------------------------------------------------------ *
 * 工具：静态扫描
 * ------------------------------------------------------------------ */

/** 去掉块注释与行注释，避免注释里的字面量被误判（项目已踩过这个坑） */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

function listFunctionDirs() {
  return fs.readdirSync(FN_DIR)
    .filter((n) => fs.statSync(path.join(FN_DIR, n)).isDirectory())
    .filter((n) => fs.existsSync(path.join(FN_DIR, n, 'index.js')))
    .sort();
}

/** 相对 require 的目标是否真的存在（依次探测 spec / spec.js / spec/index.js） */
function resolveLocalRequire(dir, spec) {
  const base = path.resolve(dir, spec);
  const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  return candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const names = listFunctionDirs();
console.log('云函数离线门禁 —— 扫描 cloudfunctions/ (' + names.length + ' 个)');

/* ---------- A. 结构 ---------- */
section('A. 结构与清单');

for (const name of names) {
  const dir = path.join(FN_DIR, name);
  const problems = [];

  const idx = path.join(dir, 'index.js');
  if (!fs.existsSync(idx)) problems.push('index.js 缺失');

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    problems.push('package.json 无法解析: ' + (err && err.message));
  }
  if (pkg) {
    const mainField = typeof pkg.main === 'string' && pkg.main ? pkg.main : 'index.js';
    if (!fs.existsSync(path.resolve(dir, mainField))) problems.push('main 指向的文件不存在: ' + mainField);
    const deps = pkg.dependencies || {};
    if (!Object.prototype.hasOwnProperty.call(deps, 'wx-server-sdk')) problems.push('dependencies 未声明 wx-server-sdk');
  }

  ok('[' + name + '] 结构完整（index.js / package.json / main / wx-server-sdk）', problems.length === 0, problems.join('; '));
}

/* 相对 require 目标存在性 */
for (const name of names) {
  const dir = path.join(FN_DIR, name);
  const code = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
  const specs = [...code.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const missing = specs.filter((s) => !resolveLocalRequire(dir, s));
  ok('[' + name + '] 相对 require 目标存在' + (specs.length ? '（' + specs.join(', ') + '）' : '（无）'), missing.length === 0,
    missing.length ? '找不到: ' + missing.join(', ') : '');
}

/* config.json 校验 */
const withConfig = names.filter((n) => fs.existsSync(path.join(FN_DIR, n, 'config.json')));
for (const name of withConfig) {
  const file = path.join(FN_DIR, name, 'config.json');
  const problems = [];
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push('JSON 无法解析: ' + (err && err.message));
  }
  if (cfg) {
    if (cfg.permissions !== undefined && !Array.isArray(cfg.permissions.openapi)) {
      problems.push('permissions.openapi 不是数组');
    }
    if (Array.isArray(cfg.triggers)) {
      cfg.triggers.forEach((t, i) => {
        if (!t || t.type !== 'timer') problems.push('triggers[' + i + '].type 不是 timer');
        const cron = t && typeof t.config === 'string' ? t.config : '';
        const fields = cron.trim().split(/\s+/).filter(Boolean);
        if (fields.length !== 7) problems.push('triggers[' + i + '] cron 应为 7 段，实际 ' + fields.length + ' 段: "' + cron + '"');
      });
    }
  }
  ok('[' + name + '] config.json 合法（openapi 数组 / timer 7 段 cron）', problems.length === 0, problems.join('; '));
}
ok('config.json 覆盖数（chat/closeOrder/extract/getBriefing/webSearch 共 5 个）', withConfig.length === 5,
  '实际 ' + withConfig.length + ' 个: ' + withConfig.join(', '));

/* 扫描数量对齐：防止「漏扫」造成的整体假绿 */
const allDirs = fs.readdirSync(FN_DIR).filter((n) => fs.statSync(path.join(FN_DIR, n)).isDirectory()).sort();
const noIndex = allDirs.filter((n) => !fs.existsSync(path.join(FN_DIR, n, 'index.js')));
ok('目录数与已校验函数数一致（没有「有目录没 index.js」被静默跳过）', noIndex.length === 0 && names.length === allDirs.length,
  '目录 ' + allDirs.length + ' / 已校验 ' + names.length + (noIndex.length ? '；缺 index.js: ' + noIndex.join(', ') : ''));
ok('函数总数与非空目录数相等（当前应为 25）', names.length === 25, '实际 ' + names.length);

/* ---------- B. 可加载性 ---------- */
section('B. 可加载性（vm 加载 + exports.main 是函数）');

const loaded = {};
for (const name of names) {
  const file = path.join(FN_DIR, name, 'index.js');
  const r = loadFunction(file, {});
  loaded[name] = r;
  const cond = !r.loadError && r.exports && typeof r.exports.main === 'function';
  ok('[' + name + '] 加载成功且 exports.main 是函数', cond,
    r.loadError ? '加载抛错: ' + (r.loadError && r.loadError.message) : (r.exports ? 'exports.main = ' + typeof r.exports.main : 'exports 为空'));
}

/* ---------- C. 安全不变量 ---------- */
section('C. 安全不变量');

/* C1. 身份分类表必须与实际代码精确相等（漂移守卫） */
const actualReaders = names.filter((n) => /getWXContext/.test(
  stripComments(fs.readFileSync(path.join(FN_DIR, n, 'index.js'), 'utf8'))
));
const declared = new Set([...OPENID_GUARDED.map((x) => x.name), ...Object.keys(OPENID_OPTIONAL)]);
const undeclared = actualReaders.filter((n) => !declared.has(n));
const stale = [...declared].filter((n) => !actualReaders.includes(n)).sort();
ok('读取 WXContext 的函数全部已分类（新增函数必须显式登记）', undeclared.length === 0,
  undeclared.length ? '未登记: ' + undeclared.join(', ') : '');
ok('分类表没有过期条目（声明的函数确实读了 WXContext）', stale.length === 0,
  stale.length ? '过期: ' + stale.join(', ') : '');
ok('分类覆盖数 = 实际读取数（20）', actualReaders.length === declared.size && actualReaders.length === 20,
  '实际读取 ' + actualReaders.length + ' / 声明 ' + declared.size);

/* C2. OPENID_GUARDED 的函数在缺 OPENID 时必须明确拒绝（行为断言，不靠 grep） */
for (const entry of OPENID_GUARDED) {
  const name = entry.name;
  const mainFn = loaded[name] && loaded[name].exports && loaded[name].exports.main;
  const label = '[' + name + '] 缺 OPENID 时明确拒绝' + (entry.note ? '（' + entry.note + '）' : '');
  if (typeof mainFn !== 'function') {
    ok(label, false, '函数未能加载，无法行为验证');
    continue;
  }
  const r = await callExpectReject(mainFn, entry.probe || {});
  if (r.kind === 'rejected') {
    ok(label + ' → 抛错', true);
  } else if (r.kind === 'resolved') {
    ok(label, isExplicitRejection(r.value), '未拒绝，返回了 ' + JSON.stringify(r.value).slice(0, 220));
  } else {
    ok(label, false, '3s 未返回（守卫之前就在打外网/挂起，CI 里会变成不稳定用例）');
  }
}

/* C3. 已知坑：云函数读查询不能用 _openid（写入时 SDK 才注入） */
for (const name of names) {
  const code = stripComments(fs.readFileSync(path.join(FN_DIR, name, 'index.js'), 'utf8'));
  const hits = [...code.matchAll(/where\s*\(\s*\{[\s\S]{0,240}?_openid/g)].length;
  ok('[' + name + '] 未在 where 查询里使用 _openid', hits === 0, hits ? '命中 ' + hits + ' 处' : '');
}

/* C4. 不得硬编码 AppID / 环境 ID */
section('C4. 不留硬编码凭据');

const HARDCODED_APPID = /\bwx[0-9a-f]{16}\b/g;
const HARDCODED_ENV = /env\s*:\s*['"]cloud[0-9][A-Za-z0-9_-]*['"]/g;
for (const name of names) {
  const code = stripComments(fs.readFileSync(path.join(FN_DIR, name, 'index.js'), 'utf8'));
  const appids = [...code.matchAll(HARDCODED_APPID)].map((m) => m[0]);
  const envs = [...code.matchAll(HARDCODED_ENV)].map((m) => m[0]);
  const tourist = code.includes('touristappid');
  const problems = [];
  if (appids.length) problems.push('硬编码 AppID: ' + appids.join(', '));
  if (envs.length) problems.push('硬编码环境: ' + envs.join(', '));
  if (tourist) problems.push('出现 touristappid');
  ok('[' + name + '] 无硬编码 AppID / 环境 ID', problems.length === 0, problems.join('; '));
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log('\n' + '-'.repeat(60));
console.log('PASS ' + pass + ' / FAIL ' + fail + '（共 ' + (pass + fail) + ' 条断言，' + names.length + ' 个云函数）');
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
console.log('云函数离线门禁：全绿');
