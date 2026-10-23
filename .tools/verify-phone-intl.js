#!/usr/bin/env node
/**
 * verify-phone-intl.js —— 登录页「手机号支持国际区号」回归闸门（零新增依赖，Node 直跑）。
 *
 * 守的是两件事：
 *   ① `src/utils/phoneIntl.ts` 的纯函数语义（区号表结构、E.164 拼装、校验顺序）；
 *   ② **云 SDK 的真实契约**：区号表里的每一项拼出来的号码，发到
 *      `POST /.cloud/auth/v1/verification` 时都必须原样到达服务端。
 *
 * 为什么必须跑真实 SDK（2026-10-23 实测坐实）：
 *   `src/assets/wb-sdk.js`（自托管同源）里 `normalizePhone`:
 *       t = phone.replace(/\D/g,"")
 *       if (t.startsWith("0086")) t = t.slice(4)
 *       else if (t.startsWith("86") && t.length === 13) t = t.slice(2)
 *       return /^1\d{10}$/.test(t) ? `+86 ${t}` : phone
 *   `+85291234567` / `+447911123456` / `+886912345678` 原样透传；
 *   但 **`+14155550123` 会被改写成 `+86 14155550123`** —— 北美 E.164 恒为「1+10 位」，
 *   数字串必然命中大陆手机号正则。所以区号表**绝不允许出现 `+1`**，
 *   下面既有静态断言，也有遍历全表的 SDK 端到端断言守这条。
 *
 * 本脚本**直接执行被测 TS 源码**（typescript.transpileModule → 自建 CJS 模块壳），
 * 不复制一份逻辑。判据一律 `cond === true`（严格布尔）；
 * 失败分支返回说明字符串、用 `!!x` 之类的宽松判据，都会让整份测试永久假绿。
 *
 * 用法:
 *   node .tools/verify-phone-intl.js
 *   node .tools/verify-phone-intl.js --root .tools/.phone-selftest/base   # 自证用沙箱
 *   PHONE_INTL_PROJECT_ROOT=<dir> node .tools/verify-phone-intl.js
 *
 * 退出码：全过 0；任何 FAIL 或源文件缺失 1。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');

/* ===================== 被测工程根（默认仓库根，可用 --root 覆盖） ===================== */

function resolveRoot() {
  const i = process.argv.indexOf('--root');
  if (i !== -1) {
    const v = process.argv[i + 1];
    if (!v) {
      console.error('ERROR  --root 后面缺少目录参数');
      process.exit(1);
    }
    return path.resolve(REPO, v);
  }
  if (process.env.PHONE_INTL_PROJECT_ROOT) {
    return path.resolve(REPO, process.env.PHONE_INTL_PROJECT_ROOT);
  }
  return REPO;
}
const ROOT = resolveRoot();

/* ===================== 断言收集器（严格布尔） ===================== */

let pass = 0;
let fail = 0;

const fmt = (v) => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/** 唯一判据入口：只有 `cond === true` 才算 PASS。 */
function ok(name, cond, detail) {
  if (cond === true) {
    pass += 1;
    console.log('PASS  ' + name);
    return true;
  }
  fail += 1;
  console.log('FAIL  ' + name);
  if (detail && typeof detail === 'object') {
    if ('expected' in detail) console.log('      期望: ' + fmt(detail.expected));
    if ('actual' in detail) console.log('      实际: ' + fmt(detail.actual));
    if (detail.note) console.log('      说明: ' + detail.note);
  }
  return false;
}

/** 严格相等（===）断言，失败时打印期望/实际。 */
function eq(name, actual, expected, note) {
  return ok(name, actual === expected, { expected, actual, note });
}

/** 包装被测函数调用：抛异常也当成一个可报告的“实际值”，不让整份脚本崩掉。 */
function call(fn, ...args) {
  try {
    return fn(...args);
  } catch (err) {
    return '<抛异常: ' + (err && err.message ? err.message : String(err)) + '>';
  }
}

/* ===================== 源文件存在性（缺失必须显式报错，不许空转） ===================== */

const REQUIRED = ['src/data/dialCodes.ts', 'src/utils/phoneIntl.ts', 'src/assets/wb-sdk.js'];
const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
if (missing.length > 0) {
  console.error('ERROR  缺少被测源文件（工程根: ' + ROOT + '）:');
  for (const m of missing) console.error('        - ' + m);
  console.error('       功能可能尚未落地。本脚本不会静默跳过、也不会空转通过。');
  process.exit(1);
}

const readFile = (abs) => fs.readFileSync(abs, 'utf8');

/* ===================== 加载真实 TS 源码（编译成 CJS 后在自己的模块壳里跑） ===================== */

const ts = require('typescript');
const moduleCache = new Map();

function resolveRelative(fromAbs, id) {
  const base = path.resolve(path.dirname(fromAbs), id);
  const candidates = [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

function loadTsModule(absPath) {
  const key = path.resolve(absPath);
  if (moduleCache.has(key)) return moduleCache.get(key).exports;

  const source = readFile(key);
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 }
  }).outputText;

  const mod = { exports: {} };
  // 先入缓存，允许（理论上存在的）循环依赖
  moduleCache.set(key, mod);

  const req = (id) => {
    if (!id.startsWith('.')) {
      throw new Error('被测源码不应依赖外部包，却 require 了: ' + id + '（' + key + '）');
    }
    const hit = resolveRelative(key, id);
    if (!hit) throw new Error('无法解析相对依赖 "' + id + '"（来自 ' + key + '）');
    return loadTsModule(hit);
  };

  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', out)(
    mod.exports,
    req,
    mod,
    key,
    path.dirname(key)
  );
  return mod.exports;
}

let dialMod;
let phoneMod;
try {
  dialMod = loadTsModule(path.join(ROOT, 'src/data/dialCodes.ts'));
  phoneMod = loadTsModule(path.join(ROOT, 'src/utils/phoneIntl.ts'));
} catch (err) {
  console.error('ERROR  加载被测 TS 源码失败: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}

const DIAL_CODES = Array.isArray(dialMod.DIAL_CODES) ? dialMod.DIAL_CODES : [];
const DEFAULT_DIAL_CODE = dialMod.DEFAULT_DIAL_CODE;
const findDialCode = dialMod.findDialCode;
const isSupportedDialCode = dialMod.isSupportedDialCode;
const normalizeNational = phoneMod.normalizeNational;
const buildPhoneE164 = phoneMod.buildPhoneE164;
const validateNational = phoneMod.validateNational;

console.log('== 被测工程根: ' + ROOT);
console.log('== 区号表条目数: ' + DIAL_CODES.length + '\n');

/* ===================== 1. 区号表结构 ===================== */

console.log('-- 1. 区号表结构');
ok('DIAL_CODES 是非空数组', DIAL_CODES.length > 0, { expected: '> 0 条', actual: DIAL_CODES.length });

const notObject = DIAL_CODES.filter((e) => !e || typeof e !== 'object');
ok('每条都是对象', notObject.length === 0, { expected: '0 条非对象', actual: notObject.length });

const badCodeType = DIAL_CODES.filter((e) => e && typeof e.code !== 'string');
ok('每条 code 都是字符串', badCodeType.length === 0, {
  expected: '0 条类型错误',
  actual: badCodeType.map((e) => (e ? typeof e.code : e))
});

const seen = new Map();
const dupCodes = [];
for (const e of DIAL_CODES) {
  if (!e || typeof e.code !== 'string') continue;
  if (seen.has(e.code)) dupCodes.push(e.code);
  else seen.set(e.code, true);
}
ok('code 全局唯一', dupCodes.length === 0, { expected: '0 个重复', actual: dupCodes });

const notDigits = DIAL_CODES.filter((e) => e && typeof e.code === 'string' && !/^\d+$/.test(e.code)).map((e) => e.code);
ok('code 只含数字（不含 + / 空格 / 短横线）', notDigits.length === 0, { expected: '0 个', actual: notDigits });

const leadingZero = DIAL_CODES.filter((e) => e && typeof e.code === 'string' && /^0/.test(e.code)).map((e) => e.code);
ok('code 不以 0 开头', leadingZero.length === 0, { expected: '0 个', actual: leadingZero });

const badLen = DIAL_CODES.filter((e) => {
  if (!e) return true;
  const { minLen, maxLen } = e;
  return !Number.isInteger(minLen) || !Number.isInteger(maxLen) || minLen < 1 || minLen > maxLen;
});
ok('minLen/maxLen 是正整数且 minLen <= maxLen', badLen.length === 0, {
  expected: '0 条违规',
  actual: badLen.map((e) => (e ? e.code + ':' + e.minLen + '..' + e.maxLen : e))
});

const badPattern = DIAL_CODES.filter((e) => e && e.pattern !== undefined && !(e.pattern instanceof RegExp));
ok('pattern 若存在必须是 RegExp', badPattern.length === 0, {
  expected: '0 条违规',
  actual: badPattern.map((e) => e.code + ':' + typeof e.pattern)
});

ok("表内存在 code === '86'", DIAL_CODES.some((e) => e && e.code === '86'), { expected: true, actual: false });
eq('DEFAULT_DIAL_CODE 是表内项', DIAL_CODES.some((e) => e && e.code === DEFAULT_DIAL_CODE), true, 'DEFAULT_DIAL_CODE=' + fmt(DEFAULT_DIAL_CODE));
eq("DEFAULT_DIAL_CODE === '86'", DEFAULT_DIAL_CODE, '86');

/* ---------- 最关键的一条：禁止 +1 ----------
 *
 * 回归证据（在 Node vm 里真加载 SDK、截获 POST /.cloud/auth/v1/verification 实测）：
 *   normalizePhone("+14155550123")  →  "+86 14155550123"
 *   normalizePhone("+85291234567")  →  "+85291234567"
 *   normalizePhone("+447911123456") →  "+447911123456"
 * 原因：北美 E.164 去掉非数字后恒为「1 + 10 位」，必然命中 /^1\d{10}$/ 的大陆手机号分支。
 * 一旦区号表里出现 code === '1'，所有北美号码都会被注册成 +86 账号 —— 静默错号，不可接受。
 * 下面的全表 SDK 断言是行为层的同一道闸门（静态 + 行为双保险）。
 */
const plusOne = DIAL_CODES.filter((e) => e && e.code === '1');
ok("【禁止 +1】表内不得出现 code === '1'", plusOne.length === 0, {
  expected: '0 条',
  actual: plusOne.map((e) => e.iso + '/' + e.code),
  note: 'SDK normalizePhone 会把 +1XXXXXXXXXX 改写成 "+86 XXXXXXXXXX"（已实测）'
});

/* ---------- 查询函数 ---------- */

eq("findDialCode('86').code", call(() => (findDialCode ? findDialCode('86') : undefined))?.code, '86');
eq("findDialCode('999') === undefined", call(() => findDialCode('999')), undefined);
eq("isSupportedDialCode('852')", call(() => isSupportedDialCode('852')), true);
eq("isSupportedDialCode('999')", call(() => isSupportedDialCode('999')), false);

/* ===================== 2. 纯函数：normalizeNational / buildPhoneE164 ===================== */

console.log('\n-- 2. 纯函数');

eq("normalizeNational(' 9123 4567 ')", call(normalizeNational, ' 9123 4567 '), '91234567');
eq("normalizeNational('+86 138-0013-8000')", call(normalizeNational, '+86 138-0013-8000'), '8613800138000');
eq('normalizeNational(null 容错)', call(normalizeNational, null), '');

eq("buildPhoneE164('86','13800138000')", call(buildPhoneE164, '86', '13800138000'), '+8613800138000');
eq("buildPhoneE164('852',' 9123 4567 ')", call(buildPhoneE164, '852', ' 9123 4567 '), '+85291234567', '必须剥掉空格/分隔符');
eq("buildPhoneE164('999','123')", call(buildPhoneE164, '999', '123'), '', '未知区号必须返回空串');
eq("buildPhoneE164('86','')", call(buildPhoneE164, '86', ''), '', '空号必须返回空串');

/* ===================== 3. 纯函数：validateNational 的顺序与语义 ===================== */

eq("validateNational('86','12345678901')", call(validateNational, '86', '12345678901'), 'format', '11 位但非 1 开头 → format');
eq("validateNational('86','13800138000')", call(validateNational, '86', '13800138000'), null);
eq("validateNational('852','9123456')", call(validateNational, '852', '9123456'), 'length', '7 位 < minLen 8');
eq("validateNational('852','91234567')", call(validateNational, '852', '91234567'), null);
eq("validateNational('852','')", call(validateNational, '852', ''), 'empty');
eq("validateNational('999','123')", call(validateNational, '999', '123'), 'unsupported', '未知区号优先于空号判断');

/* ===================== 4. SDK 契约：遍历全表，逐条核对真实请求体 ===================== */

/**
 * 在沙箱里加载自执行 IIFE 形式的云 SDK，桩掉 fetch 截获请求体。
 * 只提供 SDK 在 sendOtp 路径上真正会碰到的东西；任何缺失都会在运行时暴露，
 * 而不是被 try/catch 静默吞掉。
 */
function createSdkHarness() {
  const requests = [];

  const makeStorage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => {
        m.set(k, String(v));
      },
      removeItem: (k) => {
        m.delete(k);
      },
      clear: () => m.clear(),
      key: (i) => Array.from(m.keys())[i] ?? null,
      get length() {
        return m.size;
      }
    };
  };

  const fetchStub = (url, init) => {
    const opts = init || {};
    requests.push({
      url: String(url),
      method: opts.method || 'GET',
      body: typeof opts.body === 'string' ? opts.body : null
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => Promise.resolve(JSON.stringify({ verification_id: 'stub', is_existing_user: false }))
    });
  };

  const sandbox = {
    console,
    fetch: fetchStub,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    crypto: globalThis.crypto,
    performance,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    location: {
      origin: 'https://example.invalid',
      href: 'https://example.invalid/login',
      pathname: '/login',
      search: ''
    }
  };

  // SDK 的自执行 IIFE 既写 `var WorkBuddyCloud`（顶层 → 全局属性），
  // 也可能读 globalThis / window / self，三者都指向沙箱自身。
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const context = vm.createContext(sandbox);
  const sdkSource = readFile(path.join(ROOT, 'src/assets/wb-sdk.js'));
  new vm.Script(sdkSource, { filename: 'src/assets/wb-sdk.js' }).runInContext(context);

  if (!sandbox.WorkBuddyCloud || typeof sandbox.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
    throw new Error('SDK 执行后没有暴露 WorkBuddyCloud.createWorkBuddyCloud');
  }
  const client = sandbox.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: 'https://example.invalid',
    publishableKey: 'wbpk_stub'
  });
  if (!client || !client.auth || typeof client.auth.sendOtp !== 'function') {
    throw new Error('SDK 客户端缺少 auth.sendOtp');
  }
  return { client, requests };
}

/** 为一条区号表记录生成一个符合其 pattern / 长度约束的样例数字串。 */
function sampleDigits(entry) {
  const min = Number(entry.minLen);
  const max = Number(entry.maxLen);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max) return null;

  const re =
    entry.pattern instanceof RegExp ? new RegExp(entry.pattern.source, entry.pattern.flags.replace(/g/g, '')) : null;
  const matches = (d) => (re ? re.test(d) : true);

  const lens = [...new Set([Math.min(Math.max(11, min), max), min, max])].filter((l) => l >= min && l <= max && l >= 1);
  for (const len of lens) {
    const cands = new Set();
    const add = (s) => {
      if (typeof s === 'string' && s.length === len) cands.add(s);
    };
    add('13800138000');
    add('1415555012');
    add('91234567');
    for (let p = 0; p <= 9; p += 1) add(String(p).repeat(len));
    add('1' + '3'.repeat(Math.max(0, len - 1)));
    add('9' + '1'.repeat(Math.max(0, len - 1)));
    for (const a of '0123456789') {
      for (const b of '0123456789') {
        for (const c of '0123456789') {
          add(a + b + c + '1'.repeat(Math.max(0, len - 3)));
        }
      }
    }
    for (const d of cands) {
      if (matches(d)) return d;
    }
  }
  return null;
}

async function runSdkContract() {
  console.log('\n-- 4. SDK 真实请求契约（遍历 DIAL_CODES 全表）');

  let harness;
  try {
    harness = createSdkHarness();
  } catch (err) {
    ok('云 SDK 可在 vm 沙箱中加载', false, {
      expected: '加载成功',
      actual: err && err.message ? err.message : String(err)
    });
    return;
  }
  ok('云 SDK 可在 vm 沙箱中加载', true);

  const { client, requests } = harness;

  // 先跑一次 86，确认桩真的截获到了 POST /v1/verification（否则后面“截不到请求”会变成假绿）。
  requests.length = 0;
  const probe = await client.auth.sendOtp({ phone: '+8613800138000' });
  const probeReq = requests[requests.length - 1];
  ok('fetch 桩截获到 sendOtp 请求', Boolean(probeReq) && typeof probeReq.body === 'string', {
    expected: '一条带 body 的请求',
    actual: probeReq ? probeReq.method + ' ' + probeReq.url : '<没有请求>'
  });
  ok(
    '请求打到 POST /.cloud/auth/v1/verification',
    Boolean(probeReq) && probeReq.method === 'POST' && probeReq.url.endsWith('/.cloud/auth/v1/verification'),
    {
      expected: 'POST .../.cloud/auth/v1/verification',
      actual: probeReq ? probeReq.method + ' ' + probeReq.url : '<没有请求>'
    }
  );
  ok('sendOtp 本身没有返回错误', Boolean(probe && probe.error === null), {
    expected: 'error === null',
    actual: probe && probe.error ? probe.error.message : '<无返回>'
  });

  for (const entry of DIAL_CODES) {
    const code = entry && entry.code;
    const label = 'SDK [' + code + ']';
    if (typeof code !== 'string' || !/^\d+$/.test(code)) {
      ok(label + ' 区号可参与拼装', false, { expected: '纯数字字符串', actual: fmt(code) });
      continue;
    }
    const digits = sampleDigits(entry);
    if (!digits) {
      ok(label + ' 能生成符合 pattern 的样例号码', false, {
        expected: '至少一个满足 pattern 与长度约束的样例',
        actual: '生成失败（pattern=' + String(entry.pattern) + ', len=' + entry.minLen + '..' + entry.maxLen + '）'
      });
      continue;
    }

    const input = '+' + code + digits;
    requests.length = 0;
    const res = await client.auth.sendOtp({ phone: input });
    const req = requests[requests.length - 1];

    let sent;
    let parseNote = '';
    if (!req || typeof req.body !== 'string') {
      sent = '<未发出请求>';
    } else {
      try {
        const body = JSON.parse(req.body);
        sent = body && typeof body.phone_number === 'string' ? body.phone_number : '<body 无 phone_number>';
      } catch (err) {
        sent = '<body 不是 JSON>';
        parseNote = err && err.message ? err.message : String(err);
      }
    }

    // SDK 对 +86 会插一个空格（既有行为，不改 SDK 就必须接受）；
    // 其余区号必须**逐字节原样透传**。
    const expected = code === '86' ? '+86 ' + digits : input;

    ok(label + ' 送达服务端的号码未被改写', sent === expected && !(res && res.error), {
      expected,
      actual: res && res.error ? sent + '（sendOtp error: ' + res.error.message + '）' : sent,
      note:
        'code=1 时此处必然期望 +1… 实际 +86 …（normalizePhone 改写）' +
        (parseNote ? '；解析失败: ' + parseNote : '')
    });
  }
}

/* ===================== 接线断言（登录页真的用了这套纯函数） ===================== */

/**
 * 为什么需要这一组：上面所有断言都只证明「纯函数本身对」，证明不了「登录页真的调了它」。
 * 把 `currentId()` 改回 `{ phone: account.trim() }`、或把 `validateNational` 换成一行
 * 写死的大陆正则，上面 57 条断言会**全部继续通过**，而线上发出去的又是裸号码。
 * 本仓库有同类先例（verify-pref-select 钉的是「getBriefing 不走 slice(0,3)」）。
 *
 * 判据用「子串存在/不存在」，不绑行号与格式，改实现细节不会误伤。
 */
function checkLoginWiring() {
  const rel = 'src/pages/login/index.tsx';
  let src;
  try {
    src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch (err) {
    // 不静默跳过：读不到就是这一组没被验证，必须算失败。
    ok('登录页源码可读（接线断言前提）', false, {
      expected: rel + ' 存在',
      actual: '读取失败: ' + (err && err.code ? err.code : String(err)),
      note: '若用 --root 指向残缺沙箱，请把登录页一并复制进去'
    });
    return;
  }

  // ⚠️ 不能只判「整个文件里出现过 buildPhoneE164」—— 它在 import 与绑定流程里都还在，
  //    把 currentId() 改回 `{ phone: account.trim() }` 时那个粗断言依然全绿（实测漏抓过一次）。
  //    ⇒ 必须把范围收窄到 currentId 那一段，只认这一段里的拼装。
  const ciAt = src.indexOf('const currentId');
  const ciSeg = ciAt >= 0 ? src.slice(ciAt, ciAt + 420) : '';
  ok('currentId() 用 buildPhoneE164 拼 E.164（不是裸号码）', ciAt >= 0 && ciSeg.includes('buildPhoneE164'), {
    expected: 'currentId 定义段内出现 buildPhoneE164',
    actual:
      ciAt < 0
        ? '找不到 `const currentId` —— 实现结构变了，请更新本断言'
        : ciSeg.includes('buildPhoneE164')
          ? '已使用'
          : '该段内没有 buildPhoneE164 —— 提交给 SDK 的可能是没有区号的裸号码',
    note: 'SDK 只归一 +86，其余区号原样透传，传裸号码服务端收到的就是没有区号的号码'
  });

  // 只盯「定义」不看「提及」：登录页注释里合法地写着「原 PHONE_RE = … 已删除」，
  // 用裸子串会把这段说明误判成回退。
  ok('登录页已移除只认大陆的 PHONE_RE 定义', src.includes('const PHONE_RE') === false, {
    expected: '不出现 const PHONE_RE',
    actual: src.includes('const PHONE_RE') ? '定义仍存在（会把 +852 的 8 位号码全部拦死）' : '定义已移除'
  });

  ok('登录页用 validateNational 做提交前校验', src.includes('validateNational('), {
    expected: '源码里出现 validateNational(',
    actual: '未出现 —— 校验可能被换成写死规则，配合其它区号会误判'
  });
}

/* ===================== 汇总 ===================== */

checkLoginWiring();

runSdkContract()
  .catch((err) => {
    ok('SDK 契约用例整体执行', false, {
      expected: '无异常',
      actual: err && err.stack ? err.stack : String(err)
    });
  })
  .finally(() => {
    console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + `  pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
