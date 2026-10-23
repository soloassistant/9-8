#!/usr/bin/env node
/**
 * verify-crash-report.js —— 「崩溃上报」回归闸门。
 *
 * 守的是这几件会静默失效、且线上没人会发现的事：
 *
 *   1. **H5 有没有通道**：改前 `Taro.onError` 里只有 `Taro.cloud?.callFunction` 一条分支，
 *      H5 上 `Taro.cloud` 是 undefined → 整段跳过 → 公开入口崩了完全无人知晓。
 *   2. **H5 拿到的堆栈是不是真的**：taro-h5 的 errorListener 是
 *      `trigger(res.stack || res.message || res)` —— 给回调的是**字符串**，
 *      `err instanceof Error` 恒 false，于是整段堆栈被塞进 message、stack 恒空。
 *      所以这里断言「字符串形态能被正确拆回 message + stack」。
 *   3. **隐私边界**：崩溃日志不能带出邮箱 / 手机号 / URL 里的 token / Bearer 凭据。
 *   4. **崩溃路径本身不能二次崩**：transport 抛错 / reject 时不得冒泡，不得死循环。
 *   5. **写入通道必须是只写 RPC**：`client_errors` 对客户端 REVOKE 了表权限、RLS 无策略，
 *      直接 `from('client_errors').insert()` 会 42501（线上实测）。必须走
 *      `rpc('log_client_error')`，且**不能**用 `unwrap`（函数返回 void，data 恒 null，
 *      unwrap 会把它误判成失败）。
 *
 * 判据一律 `cond === true`：失败分支返回非空字符串会被 truthy 判成 PASS（项目踩过）。
 * 用法: node .tools/verify-crash-report.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond === true) {
    pass += 1;
    console.log('PASS  ' + name);
  } else {
    fail += 1;
    console.log('FAIL  ' + name);
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ===================== 加载被测模块（真实 TS 源码） ===================== */

const ts = require('typescript');

function loadTs(rel) {
  const src = read(rel);
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} };
  // crashReport.ts 是零 import 模块，require 不会被调用；传进去只为形态完整
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', out)(
    mod.exports,
    (id) => {
      throw new Error('crashReport 不应有静态依赖，却 require 了: ' + id);
    },
    mod,
    rel,
    ROOT
  );
  return mod.exports;
}

const CR = loadTs('src/services/crashReport.ts');

/* ===================== 1. 打码（隐私边界） ===================== */

const s1 = CR.sanitizeText('failed to send to alice.wang@example.com');
ok('sanitize 邮箱打码', s1.includes('[email]') && !s1.includes('alice.wang'));

const s2 = CR.sanitizeText('login failed for 13812345678');
ok('sanitize 手机号打码', s2.includes('[phone]') && !s2.includes('13812345678'));

const s3 = CR.sanitizeText('GET /.api/x?token=abc123&id=7 failed');
ok(
  'sanitize URL token 参数打码且保留其它参数',
  s3.includes('token=[redacted]') && s3.includes('id=7') && !s3.includes('abc123')
);

const s4 = CR.sanitizeText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
ok('sanitize Bearer 凭据打码', s4.includes('Bearer [redacted]') && !s4.includes('eyJhbGciOiJIUzI1NiJ9'));

// ★ 端到端实测漏网的形态（2026-10-23）：错误文案里**空格分隔的裸** token=xxx，
// 不带 ? / & 前缀。单测原先只覆盖 URL 形态，这条是真实浏览器上报时明文落库后才补上的。
const s4a = CR.sanitizeText('H5-REJECT-e2e123 token=abc123secret');
ok('sanitize 裸 token=（非 URL 形态）也打码', s4a.includes('token=[redacted]') && !s4a.includes('abc123secret'));

const s4b = CR.sanitizeText('verify failed: code=998877 password=hunter2');
ok(
  'sanitize 裸 code= / password= 也打码',
  s4b.includes('code=[redacted]') && s4b.includes('password=[redacted]') && !s4b.includes('998877') && !s4b.includes('hunter2')
);

// 反向：不能把普通长数字误伤成手机号（否则日志失去诊断价值）
const s5 = CR.sanitizeText('order id 1234567890123456 not found');
ok('sanitize 不误伤超长数字串', !s5.includes('[phone]') && s5.includes('1234567890123456'));

// 反向：没有敏感信息时不应改动原文
const s6 = CR.sanitizeText("TypeError: Cannot read properties of undefined (reading 'map')");
ok('sanitize 无敏感信息时保持原样', s6 === "TypeError: Cannot read properties of undefined (reading 'map')");

/* ===================== 2. 异常归一 ===================== */

const e1 = new Error('boom');
e1.stack = 'Error: boom\n    at fn (a.js:1:2)';
const n1 = CR.normalizeError(e1);
ok('normalize Error→message/stack 分离', n1.message === 'boom' && n1.stack.includes('at fn (a.js:1:2)'));

// taro-h5 的真实形态：整段字符串（首行消息 + 后续堆栈）
const taroRaw = "TypeError: x is not a function\n    at Page (index.js:10:5)";
const n2 = CR.normalizeError(taroRaw);
ok(
  'normalize Taro H5 字符串形态拆回 message+stack',
  n2.message === 'TypeError: x is not a function' && n2.stack.includes('at Page (index.js:10:5)')
);

const n3 = CR.normalizeError('plain message only');
ok('normalize 纯字符串不当成堆栈', n3.message === 'plain message only' && n3.stack === '');

const n4 = CR.normalizeError({ type: 'unhandledrejection', promise: {}, reason: new Error('rejected!') });
ok('normalize PromiseRejectionEvent 取 reason', n4.message === 'rejected!');

const evErr = new Error('from error event');
evErr.stack = 'Error: from error event\n    at y (b.js:3:4)';
const n5 = CR.normalizeError({ message: 'from error event', error: evErr });
ok('normalize ErrorEvent 优先取 .error 的 stack', n5.stack.includes('at y (b.js:3:4)'));

const n6 = CR.normalizeError({ message: 'Script error.', filename: 'https://x/main.js', lineno: 42, colno: 7 });
ok(
  'normalize ErrorEvent 无 error 时用 filename:line:col 拼堆栈',
  n6.message === 'Script error.' && n6.stack === 'at https://x/main.js:42:7'
);

const n7 = CR.normalizeError({ some: 'object' });
ok('normalize 非 Error 对象不产出 [object Object]', n7.message === 'Unknown error (non-Error thrown)');

const n8 = CR.normalizeError(undefined);
ok('normalize undefined 有兜底消息', typeof n8.message === 'string' && n8.message.length > 0);

/* ===================== 3. reportCrash 分派 / 去重 / 预算 ===================== */

function makeTransport() {
  const calls = [];
  const t = (p) => {
    calls.push(p);
    return Promise.resolve(true);
  };
  t.calls = calls;
  return t;
}

CR.__resetCrashState();
let tr = makeTransport();
CR.reportCrash(new Error('one'), { transport: tr, channel: 'h5' });
ok('reportCrash 调 transport 一次', tr.calls.length === 1);
ok('reportCrash 载荷带 channel', tr.calls[0].channel === 'h5');
ok('reportCrash 载荷带 message', tr.calls[0].message === 'one');

// 去重：同一错误重复出现只报一次（渲染循环里会刷屏）
tr = makeTransport();
CR.__resetCrashState();
CR.reportCrash(new Error('dup'), { transport: tr, channel: 'h5' });
CR.reportCrash(new Error('dup'), { transport: tr, channel: 'h5' });
CR.reportCrash(new Error('dup'), { transport: tr, channel: 'h5' });
ok('reportCrash 同签名去重（只报一次）', tr.calls.length === 1);

// 空消息不上报
tr = makeTransport();
CR.__resetCrashState();
CR.reportCrash({ message: '   ' }, { transport: tr, channel: 'h5' });
ok('reportCrash 空消息不上报', tr.calls.length === 0);

// 预算：崩溃风暴上限 8 条
tr = makeTransport();
CR.__resetCrashState();
for (let i = 0; i < 20; i += 1) {
  CR.reportCrash(new Error('storm-' + i), { transport: tr, channel: 'h5' });
}
ok('reportCrash 单次会话上限 8 条', tr.calls.length === 8);

// transport 同步抛错：不得冒泡，且不得卡住后续上报（重入标记必须释放）
tr = makeTransport();
CR.__resetCrashState();
let threw = false;
try {
  CR.reportCrash(new Error('sync-throw'), {
    transport: () => {
      throw new Error('transport exploded');
    },
    channel: 'h5'
  });
} catch {
  threw = true;
}
ok('reportCrash transport 同步抛错不冒泡', threw === false);
CR.reportCrash(new Error('after-throw'), { transport: tr, channel: 'h5' });
ok('reportCrash transport 抛错后仍可继续上报（重入标记已释放）', tr.calls.length === 1);

// transport reject：不得产生未捕获拒绝
tr = makeTransport();
CR.__resetCrashState();
const before = process.listenerCount('unhandledRejection');
CR.reportCrash(new Error('reject'), { transport: () => Promise.reject(new Error('nope')), channel: 'h5' });
setTimeout(() => {
  ok('reportCrash transport reject 不产生未捕获拒绝', process.listenerCount('unhandledRejection') === before);
}, 20);

// 重入：transport 内部再次 reportCrash 必须被挡住（否则死循环）
CR.__resetCrashState();
let reentrant = 0;
const loopTransport = (p) => {
  reentrant += 1;
  CR.reportCrash(new Error('nested-' + reentrant), { transport: loopTransport, channel: 'h5' });
  return Promise.resolve(true);
};
CR.reportCrash(new Error('outer'), { transport: loopTransport, channel: 'h5' });
ok('reportCrash 重入保护（transport 内部再上报被挡住）', reentrant === 1);

// 截断
tr = makeTransport();
CR.__resetCrashState();
CR.reportCrash(new Error('m'.repeat(5000)), { transport: tr, channel: 'h5' });
ok('reportCrash message 截断到 2000', tr.calls[0].message.length === 2000);

tr = makeTransport();
CR.__resetCrashState();
const bigErr = new Error('big');
bigErr.stack = 's'.repeat(9000);
CR.reportCrash(bigErr, { transport: tr, channel: 'h5' });
ok('reportCrash stack 截断到 4000', tr.calls[0].stack.length === 4000);

// 显式 page 覆盖（app.tsx 之外可传，便于分页面归因）
tr = makeTransport();
CR.__resetCrashState();
CR.reportCrash(new Error('with-page'), { transport: tr, channel: 'weapp', page: 'pages/mine/index' });
ok('reportCrash 支持显式 page', tr.calls[0].page === 'pages/mine/index');

/* ===================== 4. H5 原生监听 ===================== */

class FakeErrorEvent {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init || {});
  }
}

const handlers = {};
global.ErrorEvent = FakeErrorEvent;
global.window = {
  location: { hash: '#/pages/briefing/index?token=leakme' },
  addEventListener: (type, fn) => {
    handlers[type] = fn;
  }
};

tr = makeTransport();
CR.__resetCrashState();
CR.installH5CrashHandlers(tr, 'h5');
ok('installH5CrashHandlers 挂 error 监听', typeof handlers.error === 'function');
ok('installH5CrashHandlers 挂 unhandledrejection 监听', typeof handlers.unhandledrejection === 'function');

// 资源加载失败（普通 Event，不是 ErrorEvent）应被跳过
const plainEvent = { type: 'error', target: {} };
if (handlers.error) handlers.error(plainEvent);
ok('H5 error 监听跳过资源加载错误', tr.calls.length === 0);

// 真实脚本错误应上报，且 page 取自 hash 且去掉 query
handlers.error(new FakeErrorEvent('error', { message: 'kaboom', filename: 'https://x/a.js', lineno: 9, colno: 2 }));
ok('H5 error 监听上报脚本错误', tr.calls.length === 1);
ok('H5 page 取路由且剥离 query', tr.calls[0].page === 'pages/briefing/index');

// 未处理拒绝应上报
tr = makeTransport();
CR.__resetCrashState();
CR.installH5CrashHandlers(tr, 'h5');
handlers.unhandledrejection({ type: 'unhandledrejection', promise: {}, reason: new Error('async boom') });
ok('H5 unhandledrejection 监听到上报', tr.calls.length === 1 && tr.calls[0].message === 'async boom');

/* ===================== 5. 源码结构约束 ===================== */

const crashSrc = read('src/services/crashReport.ts');
ok(
  'crashReport.ts 保持零静态依赖（崩溃路径存活率）',
  /^\s*import\s/m.test(crashSrc.replace(/^\s*\*.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')) === false
);

const appSrc = read('src/app.tsx');
ok('app.tsx H5 分支装了原生监听', appSrc.includes('installH5CrashHandlers(h5CrashTransport)'));
ok('app.tsx weapp 分支仍走 Taro.onError', /Taro\.onError\(/.test(appSrc));
ok('app.tsx H5 通道走云库写入', appSrc.includes('clientErrorInsert(p)'));
// 回归：不能再出现「只有 cloud.callFunction 一条分支」的旧形态
ok(
  'app.tsx 不再让 H5 依赖 Taro.cloud（旧缺陷）',
  appSrc.includes('if (process.env.TARO_ENV === \'weapp\')')
);

const dbSrc = read('src/services/cloudDb.ts');
// 结构断言前先剥掉注释 —— cloudDb 里**故意**有一段注释写着「不要改成 from('client_errors').insert」，
// 不剥的话这条断言会被自己的文档判成违规（假 FAIL）。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const dbCode = stripComments(dbSrc);

ok('cloudDb 走只写 RPC log_client_error', dbCode.includes("rpc<void>('log_client_error'"));
ok('cloudDb 不得直接写 client_errors 表（会 42501）', dbCode.includes("from('client_errors')") === false);
ok(
  'cloudDb 不用 unwrap 判 void RPC（data 恒 null 会被误判失败）',
  /clientErrorInsert[\s\S]{0,1200}?if \(res\.error\)/.test(dbCode)
);
ok(
  'cloudDb 失败留痕用 console.error（warn 会被生产构建剔除）',
  dbCode.includes("console.error('[cloudDb] log_client_error")
);

/* ===================== 汇总 ===================== */

setTimeout(() => {
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + `  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}, 60);
