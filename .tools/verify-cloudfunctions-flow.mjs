#!/usr/bin/env node
/**
 * verify-cloudfunctions-flow.mjs —— 云函数**行为层**验证（第二层）
 *
 * 与 `.tools/verify-cloudfunctions.mjs` 的分工（不要混淆）：
 *   第一层（已有）：结构/守卫门禁。用递归 Proxy 万能桩把 index.js 拉进 vm，只回答
 *                   「main 在不在 / cron 几段 / 缺 OPENID 会不会拒绝」。
 *   第二层（本文件）：把 `wx-server-sdk` 换成一个**忠实的内存实现**
 *                   （.tools/lib/wx-server-sdk-mock.cjs），真的建集合、真的查询、
 *                   真的更新、真的落 serverDate，然后驱动真实业务流程。
 *
 * 为什么必须有第二层：
 *   小程序主体未注册 → 无 AppID → 开不了云开发 → 这 24 个云函数**线上从未执行过一次**。
 *   于是「越权能不能改到别人的待办」「重复设置同一状态会不会重复写库」
 *   「合法校验失守会不会写脏数据」「LLM 不可用会不会返回看似成功的假内容」
 *   这类问题在第一层里**结构性不可见**（万能桩让每次写库都"成功"）。
 *
 * 断言纪律（本仓吃过假绿的亏，所以写死在这里）：
 *   · 只有 `cond === true` 才计 PASS；断言函数的失败分支**不返回**任何真值字符串；
 *   · 一条断言 = 一个布尔表达式，期望/实际单独用 `detail` 传给失败信息；
 *   · 汇总只有一行 `PASS n / FAIL m`；m>0 时 process.exit(1)。
 *
 * 用法：
 *   node .tools/verify-cloudfunctions-flow.mjs
 *   node .tools/verify-cloudfunctions-flow.mjs --verbose   # 保留云函数自身日志（排障用）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import mockLib from './lib/wx-server-sdk-mock.cjs';

const { createMockCloud } = mockLib;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_DIR = path.join(REPO, 'cloudfunctions');

/* ------------------------------------------------------------------ *
 * 日志：默认静音（云函数里有大量 console.warn 的降级路径，会淹没结果）
 * ------------------------------------------------------------------ */

const realLog = console.log.bind(console);
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);
const realInfo = console.info.bind(console);
const VERBOSE = process.argv.includes('--verbose');
if (!VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  console.info = () => {};
}
const out = (...args) => realLog(...args);

/* ------------------------------------------------------------------ *
 * 前置条件：显式清掉所有外部能力凭据
 *
 * 本 harness 的整套「诚实降级」断言都建立在「LLM / 天气 / 支付 / 推送凭据不可用」之上。
 * 如果机器上恰好设了 LLM_API_KEY，extract/chat/webSearch 会**真的去打外网**，
 * 结果不确定（慢、失败原因不同、甚至"成功"），断言就不再可重复。
 * 所以这里主动清空，让「不可用」成为确定的事实，而不是环境巧合。
 * ------------------------------------------------------------------ */

const SCRUBBED_ENV = [
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_VISION_API_KEY',
  'LLM_VISION_MODEL',
  'LLM_VISION_BASE_URL',
  'LLM_WEB_API_KEY',
  // WEATHER_KEY/WEATHER_LOCATION 已于 2026-10-25 下线（天气切 Open-Meteo 免 key，无凭据概念）
  'INTERNAL_CALL_TOKEN',
  'SUBSCRIBE_TEMPLATE_ID',
  'PRICE_ALERT_TEMPLATE_ID',
  'PAY_WX_SUB_MCH_ID',
  'PAY_ALIPAY_APP_ID',
  'PAY_ALIPAY_PRIVATE_KEY',
  'PAY_ALIPAY_PUBLIC_KEY',
  'PAY_ALIPAY_SELLER_ID',
  'PAY_ALIPAY_ENV',
  'PAY_DY_APP_ID',
  'PAY_DY_APP_SECRET',
  'PAY_DY_MCHID',
  'PAY_DY_PRIVATE_KEY',
  'PAY_DY_SERIAL_NO',
  'PAY_DY_NOTIFY_URL'
];
for (const key of SCRUBBED_ENV) delete process.env[key];

/* ------------------------------------------------------------------ *
 * 断言框架
 * ------------------------------------------------------------------ */

let passCount = 0;
const failures = [];
let currentCase = '(未开始)';

/** 唯一判定口径：必须是布尔 true */
function ok(name, cond, detail) {
  if (cond === true) {
    passCount += 1;
    return;
  }
  failures.push({ name: `[${currentCase}] ${name}`, detail: detail === undefined ? '' : String(detail) });
}

const json = (v) => {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch (e) {
    return `<unserializable: ${e.message}>`;
  }
};

/** 深比较断言 */
function eq(name, actual, expected) {
  ok(name, json(actual) === json(expected), `期望 ${json(expected)}，实际 ${json(actual)}`);
}

/** 捕获同步/异步抛错，绝不吞掉：返回 { threw, error, value } */
async function capture(fn) {
  try {
    const value = await fn();
    return { threw: false, error: null, value };
  } catch (error) {
    return { threw: true, error, value: undefined };
  }
}

/** 断言「抛错且消息匹配」 */
function threwWith(name, r, re) {
  const message = String((r && r.error && r.error.message) || '');
  ok(name, r.threw === true && re.test(message), `期望抛错匹配 ${re}，实际 threw=${r.threw} message=${message || '(空)'}`);
}

/** 断言「没有抛错」，返回 value 以便继续 */
function noThrow(name, r) {
  ok(name, r.threw === false, `期望不抛错，实际抛出 ${String((r.error && r.error.message) || r.error)}`);
  return r.value;
}

/* ------------------------------------------------------------------ *
 * 云函数加载器：伪造 require
 *   - 'wx-server-sdk' → mock（同一实例，同 context）
 *   - 相对路径      → 真 require（./llm、./news-trust.js 等是真模块，会真的因为缺 key 失败）
 *   - Node 内置     → 真 require
 *   - 其他裸包      → 抛「未预期依赖」（mock 不提供 alipay-sdk，绝不假装它可用）
 * 每个场景重新加载模块（函数在顶层就 `const db = cloud.database()` 捕获了实例）。
 * ------------------------------------------------------------------ */

const BUILTINS = new Set(Module.builtinModules);

function makeFakeRequire(fnName, cloud) {
  const realRequire = createRequire(path.join(FN_DIR, fnName, 'index.js'));
  return function fakeRequire(id) {
    if (id === 'wx-server-sdk') return cloud;
    if (typeof id !== 'string' || !id) {
      throw new Error(`[harness] require 参数非法: ${json(id)}`);
    }
    if (id.startsWith('node:')) return realRequire(id);
    if (id.startsWith('.') || path.isAbsolute(id)) return realRequire(id);
    if (BUILTINS.has(id)) return realRequire(id);
    throw new Error(`mock-unexpected-dependency: ${id}（${fnName} 依赖了 mock 未提供的裸包）`);
  };
}

/** 加载并执行某个云函数的 index.js（不写 require 缓存，保证每场景纯净） */
function loadCloudFunction(name, cloud) {
  const file = path.join(FN_DIR, name, 'index.js');
  if (!fs.existsSync(file)) throw new Error(`[harness] 云函数不存在: ${name}`);
  const src = fs.readFileSync(file, 'utf8');
  const mod = { exports: {} };
  // runInThisContext：保留真实全局（process/Buffer/URL/setTimeout），避免 vm 沙箱的
  // 跨 realm 问题（instanceof Date 等），同时让每个场景拿到全新的模块实例。
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${src}\n})`,
    { filename: file }
  );
  wrapper(mod.exports, makeFakeRequire(name, cloud), mod, file, path.dirname(file));
  return mod.exports;
}

const OWNER = 'openid-owner-A';
const OTHER = 'openid-other-B';
const DEFAULT_CONTEXT = { OPENID: OWNER, APPID: 'wx-mock-appid', UNIONID: '', ENV: 'mock-env' };

/**
 * 起一个干净场景：全新 mock 实例 + 全新模块加载。
 * @returns {{cloud: object, main: Function, mod: object}}
 */
function boot(fnName, config = {}) {
  const holder = { cloud: null };
  const cloud = createMockCloud({
    context: Object.assign({}, DEFAULT_CONTEXT, config.context || {}),
    seed: config.seed || {},
    functionOverrides: config.functionOverrides || {},
    // cloud.callFunction：分派到同名云函数的 main，共用同一份 mock 实例与 context
    resolveFunction: (name) => loadCloudFunction(name, holder.cloud)
  });
  holder.cloud = cloud;
  const mod = loadCloudFunction(fnName, cloud);
  return { cloud, mod, main: mod.exports ? mod.exports.main : mod.main };
}

/* ------------------------------------------------------------------ *
 * 时间工具（与云函数内 monthStart/todayStr 同口径）
 * ------------------------------------------------------------------ */

function monthStartStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('sv-SE');
}
function isoFromNow(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

/* ================================================================== *
 * 0. mock 自证（元测试）
 *    如果 mock 自己的语义都不忠实，后面所有断言都是假绿。
 * ================================================================== */

async function caseMockSemantics() {
  currentCase = 'mock 自证';
  const cloud = createMockCloud({
    context: { OPENID: 'oA' },
    seed: {
      t: [
        { _id: 'd1', openid: 'oA', n: 1 },
        { _id: 'd2', openid: 'oB', n: 2 },
        { _id: 'd3', noOwner: true, n: 3 }
      ]
    }
  });
  const db = cloud.database();

  // ★ 事故根因：where({openid: undefined}) 必须退化成「匹配全部」
  const undef = await db.collection('t').where({ openid: undefined }).get();
  ok('where({openid:undefined}) 退化成匹配全部（真实 SDK 丢弃 undefined 键）', undef.data.length === 3, json(undef.data.map((d) => d._id)));

  // 正常过滤仍然有效
  const filtered = await db.collection('t').where({ openid: 'oA' }).get();
  ok('where({openid:"oA"}) 只命中 1 条', filtered.data.length === 1 && filtered.data[0]._id === 'd1', json(filtered.data));

  // add 不注入 _openid（云函数环境的真实行为）
  const added = await db.collection('t').add({ data: { openid: 'oA', n: 9 } });
  const addedDoc = await db.collection('t').doc(added._id).get();
  ok('add 不注入 _openid 字段', addedDoc.data._openid === undefined, json(addedDoc.data));
  ok('add 自动生成 _id 且回传', typeof added._id === 'string' && added._id.length > 0, json(added._id));

  // doc().get() 不存在 → 抛错（真实 errCode:-1），不是返回空
  const missing = await capture(() => db.collection('t').doc('nope').get());
  ok('doc(id).get() 不存在时抛 errCode -1', missing.threw === true && missing.error.errCode === -1, json(missing.error && missing.error.message));

  // get 返回深拷贝
  filtered.data[0].n = 999;
  const again = await db.collection('t').doc('d1').get();
  ok('get() 返回深拷贝（改返回值不影响库）', again.data.n === 1, json(again.data));

  // update 命中多条 → 全部更新并回传统计
  const upd = await db.collection('t').where({ openid: 'oA' }).update({ data: { flag: true } });
  const afterUpd = await db.collection('t').where({ openid: 'oA' }).get();
  ok('where().update() 命中多条全部更新，stats.updated 计数正确', upd.stats.updated === afterUpd.data.length && afterUpd.data.every((d) => d.flag === true), json(upd));

  // inc
  await db.collection('t').doc('d2').update({ data: { n: db.command.inc(5) } });
  const incDoc = await db.collection('t').doc('d2').get();
  ok('inc 做数值累加', incDoc.data.n === 7, json(incDoc.data));

  // 类型不匹配必须抛错（不宽容）
  const badInc = await capture(() => db.collection('t').doc('d1').update({ data: { openid: db.command.inc(1) } }));
  ok('inc 用在字符串字段上抛错（不静默忽略）', badInc.threw === true, json(badInc.error && badInc.error.message));

  // 未知/非法操作符在 where 里抛错
  const badWhere = await capture(() => db.collection('t').where({ n: db.command.inc(1) }).get());
  ok('where 里出现 inc 操作符抛错', badWhere.threw === true, json(badWhere.error && badWhere.error.message));

  const badCmp = await capture(() => db.collection('t').where({ openid: db.command.gt(1) }).get());
  ok('比较操作符类型不匹配抛错（string vs number）', badCmp.threw === true, json(badCmp.error && badCmp.error.message));

  // gte / lt
  const cmp = await db.collection('t').where({ n: db.command.gte(2) }).get();
  ok(
    'gte 比较命中 n>=2 的全部文档（d2=7、d3=3、新加的一条 n=9）',
    cmp.data.length === 3 && cmp.data.every((d) => typeof d.n === 'number' && d.n >= 2),
    json(cmp.data.map((d) => [d._id, d.n]))
  );

  // remove 统计
  const rm = await db.collection('t').doc('d3').remove();
  ok('doc().remove() 返回 stats.removed=1', rm.stats.removed === 1, json(rm));

  // count
  const cnt = await db.collection('t').count();
  ok('count 统计过滤后总数', cnt.total === 3, json(cnt));

  // serverDate 写入后是 Date 实例
  const sd = await db.collection('t').add({ data: { at: db.serverDate() } });
  const sdDoc = await db.collection('t').doc(sd._id).get();
  ok('serverDate() 写入后是 Date 实例（不是占位对象/字符串）', sdDoc.data.at instanceof Date, String(sdDoc.data.at));

  // 无 where 的 update 必须拒绝（防「忘了 where 就全表改」）
  const unsafe = await capture(() => db.collection('t').update({ data: { x: 1 } }));
  ok('无 where 的 collection.update 被拒绝', unsafe.threw === true, json(unsafe.error && unsafe.error.message));

  // 未实现的外部能力：调用即抛可识别错误，绝不返回成功
  const pay = await capture(() => cloud.cloudPay.unifiedOrder({}));
  ok('cloudPay 未实现 → 抛 mock-unsupported，不伪装成功', pay.threw === true && /mock-unsupported/.test(String(pay.error.message)), json(pay.error && pay.error.message));
  const oa = await capture(() => cloud.openapi.security.msgSecCheck({}));
  ok('openapi 未实现 → 抛 mock-unsupported，不伪装成功', oa.threw === true && /mock-unsupported/.test(String(oa.error.message)), json(oa.error && oa.error.message));

  // 集合不存在 → -502005（deleteAccount 的 skip 分支依赖它）
  const missingCol = await capture(() => db.collection('never_created').where({ a: 1 }).get());
  ok('未创建集合读取抛 errCode -502005', missingCol.threw === true && missingCol.error.errCode === -502005, json(missingCol.error && missingCol.error.message));
}

/* ================================================================== *
 * 1. login
 * ================================================================== */

async function caseLogin() {
  currentCase = 'login';
  {
    const { cloud, main } = boot('login', { seed: { users: [] } });
    const r1 = await capture(() => main({}));
    const r2 = await capture(() => main({}));
    noThrow('login 首次调用不抛错', r1);
    noThrow('login 二次调用不抛错', r2);
    const users = cloud.__docs('users');
    ok('连续两次 login 只建一条 users 文档', users.length === 1, `users=${users.length}`);
    ok('第二次 login 返回库内文档（带 _id）', !!r2.value && typeof r2.value._id === 'string', json(r2.value));
    ok('返回的 openid 是当前上下文身份', r2.value.openid === OWNER, json(r2.value.openid));
    // 首次创建与「已有档案」两条路径的响应形状必须一致（2026-10 修复：原 return profile 无 _id）
    ok('首次 login 返回的 profile 也带 _id', !!r1.value && typeof r1.value._id === 'string', json(r1.value));
    eq('首次返回的 _id 与库内那条文档一致', r1.value._id, users[0]._id);
    ok('库内文档带 createdAt 时间字符串', typeof users[0].createdAt === 'string' && users[0].createdAt.length > 0, json(users[0].createdAt));
    ok('库内文档未写入 _openid（云函数 add 不注入）', users[0]._openid === undefined, json(users[0]));
  }
  {
    const { cloud, main } = boot('login', { context: { OPENID: '' }, seed: { users: [] } });
    const r = await capture(() => main({}));
    threwWith('login 缺 OPENID 抛错', r, /no openid/);
    ok('login 缺 OPENID 时不得建用户', cloud.__docs('users').length === 0, json(cloud.__docs('users')));
  }
  {
    // 预置「另一个 openid 的用户」：不得被返回（否则所有人共用一份档案）
    const { cloud, main } = boot('login', { seed: { users: [{ _id: 'u-other', openid: OTHER, nickname: '别人的档案' }] } });
    const r = await capture(() => main({}));
    noThrow('login 在库内只有别人的用户时不抛错', r);
    ok('login 不会返回别人 openid 的档案', r.value.openid === OWNER, json(r.value.openid));
    ok('login 为当前身份新建了一条独立文档', cloud.__docs('users').length === 2, `users=${cloud.__docs('users').length}`);
  }
  {
    const { main } = boot('login', {
      seed: { users: [{ _id: 'u-me', openid: OWNER, nickname: '老王', briefingTime: '08:00' }] }
    });
    const r = await capture(() => main({}));
    noThrow('login 已有本人档案时不抛错', r);
    eq('login 返回既有档案（含 _id/昵称）', [r.value._id, r.value.nickname], ['u-me', '老王']);
  }
}

/* ================================================================== *
 * 2. updateSettings
 * ================================================================== */

async function caseUpdateSettings() {
  currentCase = 'updateSettings';
  {
    const { cloud, main } = boot('updateSettings', {
      seed: {
        users: [
          { _id: 'u-a', openid: OWNER, nickname: '晨友', briefingTime: '07:30' },
          { _id: 'u-b', openid: OTHER, nickname: '别人', briefingTime: '09:00' }
        ]
      }
    });
    const longName = '一二三四五六七八九十甲乙丙丁戊己';
    const r = await capture(() => main({ nickname: longName, briefingTime: '06:45' }));
    noThrow('updateSettings 正常入参不抛错', r);
    const mine = cloud.__docs('users').find((u) => u.openid === OWNER);
    const others = cloud.__docs('users').find((u) => u.openid === OTHER);
    ok('nickname 超 12 字落库被截断为前 12 字', mine.nickname === longName.slice(0, 12), `实际=${json(mine.nickname)}`);
    ok('合法 briefingTime 正常落库', mine.briefingTime === '06:45', json(mine.briefingTime));
    eq('只能改到自己的用户：别人的文档原封不动', [others.nickname, others.briefingTime], ['别人', '09:00']);
    ok('返回的是本人更新后的文档', r.value && r.value.openid === OWNER && r.value.nickname === longName.slice(0, 12), json(r.value));
    ok('落库写入 updatedAt', typeof mine.updatedAt === 'string' && mine.updatedAt.length > 0, json(mine.updatedAt));
  }
  {
    const { cloud, main } = boot('updateSettings', {
      seed: { users: [{ _id: 'u-a', openid: OWNER, nickname: '晨友', briefingTime: '07:30' }] }
    });
    const r = await capture(() => main({ briefingTime: '不是时间' }));
    threwWith('updateSettings 全是非法字段 → 抛错（不静默成功）', r, /no valid fields to update/);
    const mine = cloud.__docs('users')[0];
    ok('非法 briefingTime 不落库（保持原值）', mine.briefingTime === '07:30', json(mine.briefingTime));
  }
  {
    const { cloud, main } = boot('updateSettings', {
      seed: { users: [{ _id: 'u-a', openid: OWNER, nickname: '晨友', briefingTime: '07:30' }] }
    });
    const r = await capture(() => main({ nickname: '  ' }));
    threwWith('updateSettings 空 payload（全空白）→ 抛错', r, /no valid fields to update/);
    const mine = cloud.__docs('users')[0];
    ok('空 payload 不写库（nickname 未变）', mine.nickname === '晨友', json(mine.nickname));
  }
  {
    // HH:mm 校验是 /^\d{2}:\d{2}$/：一位小时必须被拒
    const { cloud, main } = boot('updateSettings', {
      seed: { users: [{ _id: 'u-a', openid: OWNER, briefingTime: '07:30' }] }
    });
    const r = await capture(() => main({ nickname: '新名字', briefingTime: '7:30' }));
    noThrow('updateSettings 单字段非法但另有合法字段时不抛错', r);
    const mine = cloud.__docs('users')[0];
    ok('briefingTime="7:30" 格式非法 → 不落库', mine.briefingTime === '07:30', json(mine.briefingTime));
    ok('同一次调用里合法字段仍然生效', mine.nickname === '新名字', json(mine.nickname));
  }
  {
    const { main } = boot('updateSettings', { context: { OPENID: '' }, seed: { users: [] } });
    const r = await capture(() => main({ nickname: 'x' }));
    threwWith('updateSettings 缺 OPENID 抛错', r, /no openid/);
  }
  {
    // 时间格式必须是合法 24 小时制：修复前 /^\d{2}:\d{2}$/ 会放过 25:99、99:99
    const { cloud, main } = boot('updateSettings', {
      seed: { users: [{ _id: 'u-a', openid: OWNER, briefingTime: '07:30' }] }
    });
    for (const bad of ['25:99', '24:00', '99:99', '7:30', '07:3']) {
      const r = await capture(() => main({ briefingTime: bad }));
      threwWith(`briefingTime="${bad}" 非法 → 抛错（不落库）`, r, /no valid fields to update/);
    }
    eq('多次非法时间后库里仍是 07:30', cloud.__docs('users')[0].briefingTime, '07:30');
    for (const good of ['23:59', '00:00', '07:30']) {
      const r = await capture(() => main({ briefingTime: good }));
      noThrow(`briefingTime="${good}"（合法边界）不抛错`, r);
      eq(`briefingTime="${good}" 正常落库`, cloud.__docs('users')[0].briefingTime, good);
    }
  }
  {
    // 没有任何 users 文档时：命中 0 行必须如实报错
    // （修复前不检查 stats.updated，随后 res.data[0] 是 undefined，前端拿到非对象且修改永久丢失）
    const { main } = boot('updateSettings', { seed: { users: [] } });
    const r = await capture(() => main({ nickname: 'x' }));
    threwWith('updateSettings 无本人档案 → 抛错（不返回 undefined 静默丢弃更新）', r, /user not found/);
  }
}

/* ================================================================== *
 * 3. todoStatus
 * ================================================================== */

async function caseTodoStatus() {
  currentCase = 'todoStatus';
  {
    // 越权：B 改 A 的待办
    const { cloud, main } = boot('todoStatus', {
      context: { OPENID: OTHER },
      seed: { todos: [{ _id: 'todo-a', openid: OWNER, title: 'A 的待办', status: 'confirmed', updateTime: 'T0' }] }
    });
    const r = await capture(() => main({ id: 'todo-a', status: 'done' }));
    noThrow('todoStatus 跨用户修改不抛错（返回业务失败）', r);
    eq('B 改 A 的待办 → {ok:false, reason:"not_found"}', [r.value.ok, r.value.reason], [false, 'not_found']);
    const doc = cloud.__docs('todos')[0];
    eq('越权请求不得改动目标文档', [doc.status, doc.updateTime], ['confirmed', 'T0']);
  }
  {
    // 幂等：已是目标状态不写库
    const { cloud, main } = boot('todoStatus', {
      seed: { todos: [{ _id: 'todo-a', openid: OWNER, title: 'A 的待办', status: 'done', updateTime: 'T0' }] }
    });
    const r = await capture(() => main({ id: 'todo-a', status: 'done' }));
    noThrow('todoStatus 重复设置同一状态不抛错', r);
    eq('重复设置同一状态 → {ok:true, unchanged:true}', [r.value.ok, r.value.unchanged], [true, true]);
    const doc = cloud.__docs('todos')[0];
    ok('幂等分支不得改写 updateTime', doc.updateTime === 'T0', json(doc.updateTime));
    const dbUpdates = cloud.__called('db.update');
    ok('幂等分支不得发出任何 update 写库', dbUpdates.length === 0, json(dbUpdates));
  }
  {
    const { cloud, main } = boot('todoStatus', {
      seed: { todos: [{ _id: 'todo-a', openid: OWNER, title: 'A 的待办', status: 'confirmed' }] }
    });
    const r = await capture(() => main({ id: 'todo-a', status: 'done' }));
    noThrow('todoStatus 正常改状态不抛错', r);
    eq('正常改状态 → {ok:true}', [r.value.ok, r.value.unchanged], [true, undefined]);
    const doc = cloud.__docs('todos')[0];
    ok('状态真的落库为 done', doc.status === 'done', json(doc.status));
    ok('状态变更写入 updateTime', typeof doc.updateTime === 'string' && doc.updateTime.length > 0, json(doc.updateTime));
  }
  {
    const { main } = boot('todoStatus', { seed: { todos: [] } });
    const r1 = await capture(() => main({ id: '', status: 'done' }));
    threwWith('todoStatus 缺 id → 抛错', r1, /id required/);
    const r2 = await capture(() => main({ id: 'x', status: 'deleted' }));
    threwWith('todoStatus 非法 status → 抛错', r2, /invalid status/);
  }
  {
    const { main } = boot('todoStatus', { context: { OPENID: '' }, seed: { todos: [] } });
    const r = await capture(() => main({ id: 'todo-a', status: 'done' }));
    threwWith('todoStatus 缺 OPENID 抛错', r, /no openid/);
  }
}

/* ================================================================== *
 * 4. getLibrary
 * ================================================================== */

async function caseGetLibrary() {
  currentCase = 'getLibrary';
  {
    const { main } = boot('getLibrary', {
      seed: {
        items: [
          { _id: 'i1', openid: OWNER, title: 'A 旧', createTime: '2026-01-01T00:00:00.000Z' },
          { _id: 'i2', openid: OWNER, title: 'A 新', createTime: '2026-03-01T00:00:00.000Z' },
          { _id: 'i3', openid: OTHER, title: 'B 的', createTime: '2026-04-01T00:00:00.000Z' },
          { _id: 'i4', openid: OWNER, title: 'A 中', createTime: '2026-02-01T00:00:00.000Z' }
        ]
      }
    });
    const r = await capture(() => main({}));
    const data = noThrow('getLibrary 不抛错', r);
    ok('getLibrary 只返回自己的 items（不含他人）', Array.isArray(data) && data.every((d) => d.openid === OWNER), json(data));
    eq('getLibrary 按 createTime 倒序', data.map((d) => d._id), ['i2', 'i4', 'i1']);
  }
  {
    const { main } = boot('getLibrary', { context: { OPENID: '' }, seed: { items: [] } });
    const r = await capture(() => main({}));
    threwWith('getLibrary 缺 OPENID 抛错（不退化成全表查询）', r, /no openid/);
  }
  {
    // 无归属查询反证：库里有多人 items 时，空身份绝不能读到任何一条
    const { main } = boot('getLibrary', {
      context: { OPENID: '' },
      seed: { items: [{ _id: 'i1', openid: OWNER, createTime: '2026-01-01T00:00:00.000Z' }] }
    });
    const r = await capture(() => main({}));
    ok('空身份读不到任何 items（抛错或空数组都算拒绝，但绝不能返回数据）', r.threw === true || (Array.isArray(r.value) && r.value.length === 0), json(r.value));
  }
}

/* ================================================================== *
 * 5. confirmItem
 * ================================================================== */

async function caseConfirmItem() {
  currentCase = 'confirmItem';
  {
    const { cloud, main } = boot('confirmItem', { seed: { events: [], todos: [], items: [] } });
    const r = await capture(() =>
      main({
        events: [{ title: '季度评审', startTime: '2026-11-01 10:00', location: '会议室' }],
        todos: [{ title: '交周报' }],
        collection: {
          title: '一篇好文',
          summary: '摘要',
          tags: ['a', 'b', 'c', 'd', 'e', 'f'],
          sourceType: 'nonsense',
          url: 'https://example.com/x'
        }
      })
    );
    const res = noThrow('confirmItem 正常入参不抛错', r);
    eq('confirmItem 返回 saved 计数', res.saved, 3);
    const events = cloud.__docs('events');
    const todos = cloud.__docs('todos');
    const items = cloud.__docs('items');
    ok('events 落库带本人 openid', events.length === 1 && events[0].openid === OWNER, json(events));
    ok('events 落库 status=confirmed', events[0].status === 'confirmed', json(events[0]));
    ok('todos 落库带本人 openid', todos.length === 1 && todos[0].openid === OWNER, json(todos));
    ok('items 落库带本人 openid', items.length === 1 && items[0].openid === OWNER, json(items));
    eq('tags 超过 5 个被截断（slice(0,5)）', items[0].tags, ['a', 'b', 'c', 'd', 'e']);
    eq('非法 sourceType 归一到 message', items[0].sourceType, 'message');
  }
  {
    const { cloud, main } = boot('confirmItem', { seed: { events: [], todos: [], items: [] } });
    const r = await capture(() => main({ events: [{ title: '缺开始时间' }], todos: [] }));
    threwWith('confirmItem 非法 event（缺 startTime）→ 抛错', r, /invalid event\/todo payload/);
    ok('非法 payload 一条都不写库', cloud.__docs('events').length === 0 && cloud.__docs('todos').length === 0, json(cloud.__dump()));
  }
  {
    // 收藏配额：满 50 条 → 拒绝新增，且**一条都不能写**。
    // 修复前顺序是「先写 events/todos → 再查配额 → 超限抛错」，于是超限时日程/待办已入库，
    // 用户看到「保存失败」重试就多出一整套重复日程（非原子写入）。
    const seedItems = [];
    for (let i = 0; i < 50; i += 1) seedItems.push({ _id: `i${i}`, openid: OWNER, title: `t${i}` });
    const { cloud, main } = boot('confirmItem', { seed: { events: [], todos: [], items: seedItems } });
    const r = await capture(() =>
      main({
        events: [{ title: '不该入库的会议', startTime: '2026-11-01 10:00' }],
        todos: [{ title: '不该入库的待办' }],
        collection: { title: '新收藏', summary: '摘要' }
      })
    );
    threwWith('confirmItem 收藏达 50 条上限 → 抛错（提示订阅）', r, /quota exceeded/);
    ok('超配额时不得新增 items 文档', cloud.__docs('items').length === 50, `items=${cloud.__docs('items').length}`);
    eq('超配额时 events 必须零写入（配额预检在所有写入之前）', cloud.__docs('events').length, 0);
    eq('超配额时 todos 必须零写入', cloud.__docs('todos').length, 0);
    eq('超配额时不得发出任何 add 写库调用', cloud.__called('db.add').length, 0);
  }
  {
    // 配额的隔离性：A 满额不影响 B
    const seedItems = [];
    for (let i = 0; i < 50; i += 1) seedItems.push({ _id: `i${i}`, openid: OWNER, title: `t${i}` });
    const { main } = boot('confirmItem', { context: { OPENID: OTHER }, seed: { events: [], todos: [], items: seedItems } });
    const r = await capture(() => main({ collection: { title: 'B 的收藏', summary: '摘要' } }));
    const res = noThrow('confirmItem 配额按 openid 隔离（B 不受 A 满额影响）', r);
    eq('B 的收藏正常写入', res.saved, 1);
  }
  {
    const { cloud, main } = boot('confirmItem', { context: { OPENID: '' }, seed: { events: [], todos: [], items: [] } });
    const r = await capture(() => main({ events: [{ title: 'x', startTime: '2026-11-01 10:00' }] }));
    threwWith('confirmItem 缺 OPENID 抛错', r, /no openid/);
    ok('缺 OPENID 时不写任何集合', cloud.__docs('events').length === 0, json(cloud.__docs('events')));
  }
}

/* ================================================================== *
 * 6. getUsage
 * ================================================================== */

async function caseGetUsage() {
  currentCase = 'getUsage';
  const month = monthStartStr();
  {
    const { main } = boot('getUsage', {
      seed: {
        users: [{ _id: 'u-a', openid: OWNER, subscribed: false, expiredAt: null }],
        usage: [{ _id: 'usage-a', openid: OWNER, month, voiceUsed: 7 }],
        items: [
          { _id: 'i1', openid: OWNER, title: 'a' },
          { _id: 'i2', openid: OTHER, title: 'b' }
        ]
      }
    });
    const r = await capture(() => main({}));
    const usage = noThrow('getUsage 免费用户不抛错', r);
    eq('免费档额度 = 语音 20 / 收藏 50', [usage.voiceQuota, usage.collectionQuota], [20, 50]);
    eq('本月已用语音数取自 usage 文档', usage.voiceUsed, 7);
    eq('collectionCount 只算自己的 items', usage.collectionCount, 1);
    eq('非订阅用户 lockedPrice 为 null', usage.lockedPrice, null);
  }
  {
    const { main } = boot('getUsage', {
      seed: {
        users: [{ _id: 'u-a', openid: OWNER, subscribed: true, expiredAt: isoFromNow(86400000 * 30), isEarlyBird: true, planId: 'earlybird_monthly' }],
        usage: [],
        items: []
      }
    });
    const r = await capture(() => main({}));
    const usage = noThrow('getUsage 订阅用户不抛错', r);
    eq('订阅用户额度为 -1（不限）', [usage.voiceQuota, usage.collectionQuota], [-1, -1]);
    eq('早鸟会员按默认方案推导锁价', usage.lockedPrice && usage.lockedPrice.planId, 'earlybird_monthly');
    eq('锁价金额与 EARLYBIRD_PRICE 一致（6.9 元）', usage.lockedPrice && usage.lockedPrice.price, 6.9);
  }
  {
    const { main } = boot('getUsage', {
      seed: {
        users: [{ _id: 'u-a', openid: OWNER, subscribed: true, expiredAt: isoFromNow(-86400000), isEarlyBird: true }],
        usage: [],
        items: []
      }
    });
    const r = await capture(() => main({}));
    const usage = noThrow('getUsage 订阅已过期不抛错', r);
    eq('订阅过期 → 回落免费额度', [usage.voiceQuota, usage.collectionQuota], [20, 50]);
    eq('订阅过期 → lockedPrice 为 null', usage.lockedPrice, null);
  }
  {
    const { main } = boot('getUsage', {
      seed: {
        users: [{ _id: 'u-a', openid: OWNER, subscribed: true, expiredAt: isoFromNow(86400000) }],
        usage: [],
        items: []
      }
    });
    const r = await capture(() => main({ action: 'getLockedPrice' }));
    const res = noThrow('getUsage getLockedPrice 分支不抛错', r);
    eq('getLockedPrice 返回统一 {code:0,message:"ok"} 包装', [res.code, res.message], [0, 'ok']);
    ok('getLockedPrice 的 data 带 lockedPrice 字段', Object.prototype.hasOwnProperty.call(res.data, 'lockedPrice'), json(res.data));
  }
  {
    const { main } = boot('getUsage', { context: { OPENID: '' }, seed: { users: [], usage: [], items: [] } });
    const r = await capture(() => main({}));
    threwWith('getUsage 缺 OPENID 抛错（不共用同一份额度账本）', r, /no openid/);
  }
}

/* ================================================================== *
 * 7. deleteAccount
 * ================================================================== */

async function caseDeleteAccount() {
  currentCase = 'deleteAccount';
  const { cloud, main } = boot('deleteAccount', {
    seed: {
      users: [
        { _id: 'u-a', openid: OWNER, nickname: '我' },
        { _id: 'u-b', openid: OTHER, nickname: '别人' }
      ],
      orders: [
        { _id: 'o-a', openid: OWNER, orderId: 'ord_a' },
        { _id: 'o-b', openid: OTHER, orderId: 'ord_b' }
      ],
      todos: [
        { _id: 't-a', openid: OWNER, title: '我的待办' },
        { _id: 't-b', openid: OTHER, title: '别人的待办' }
      ],
      items: [
        { _id: 'i-a', openid: OWNER, title: '我的收藏' },
        { _id: 'i-b', openid: OTHER, title: '别人的收藏' }
      ],
      // errors 是 reportError 写的崩溃上报（openid + page + stack）——
      // 2026-10 修复前它不在注销清单里，等于「注销后仍留着这个人的身份与页面」。
      errors: [
        { _id: 'e-a', openid: OWNER, message: '我的崩溃', page: 'pages/home/index' },
        { _id: 'e-b', openid: OTHER, message: '别人的崩溃', page: 'pages/mine/index' }
      ]
    }
  });
  const scoped = ['users', 'orders', 'todos', 'items', 'errors'];
  const r = await capture(() => main({}));
  const res = noThrow('deleteAccount 正常调用不抛错', r);
  eq('返回 {code:0, data.deleted:true}', [res.code, res.data.deleted], [0, true]);
  eq('removed 计数覆盖本人 5 条记录（含 errors）', res.data.removed, 5);
  ok('本人 users/orders/todos/items/errors 全部清空', scoped.every((c) => cloud.__docs(c).every((d) => d.openid !== OWNER)), json(cloud.__dump()));
  ok('别人的数据一条都不能少（含 errors）', scoped.every((c) => cloud.__docs(c).filter((d) => d.openid === OTHER).length === 1), json(cloud.__dump()));
  eq('注销后 errors 里该 openid 的记录为 0（F18：崩溃上报也算个人数据）', cloud.__docs('errors').filter((d) => d.openid === OWNER).length, 0);
  eq('别人的 errors 仍然保留（不能误删）', cloud.__docs('errors').filter((d) => d.openid === OTHER).map((d) => d._id), ['e-b']);
  ok('未创建的遗留集合（history 等）被跳过而不是判失败', res.data.failed === undefined, json(res.data));
}

/* ================================================================== *
 * 8. reportError
 * ================================================================== */

async function caseReportError() {
  currentCase = 'reportError';
  {
    const { cloud, main } = boot('reportError', { seed: { errors: [] } });
    const longMsg = 'x'.repeat(800);
    const r = await capture(() => main({ message: longMsg, channel: 'weapp', page: 'pages/home/index', stack: 'y'.repeat(3000) }));
    const res = noThrow('reportError 正常上报不抛错', r);
    eq('reportError 返回 {ok:true}', res.ok, true);
    const docs = cloud.__docs('errors');
    ok('errors 集合写入 1 条', docs.length === 1, `errors=${docs.length}`);
    ok('created_at 落库是 Date 实例（不是字符串）', docs[0].created_at instanceof Date, String(docs[0].created_at));
    ok('openid 写入本人身份', docs[0].openid === OWNER, json(docs[0].openid));
    eq('message 截断到 500 字', docs[0].message.length, 500);
    eq('stack 截断到 2000 字', docs[0].stack.length, 2000);
    eq('page 落库', docs[0].page, 'pages/home/index');
  }
  {
    const { cloud, main } = boot('reportError', { context: { OPENID: '' }, seed: { errors: [] } });
    const r = await capture(() => main({ message: 'x' }));
    const res = noThrow('reportError 缺 OPENID 不抛错（fire-and-forget 语义）', r);
    eq('缺 OPENID → {ok:false, skip:true, reason:"no openid"}', [res.ok, res.skip, res.reason], [false, true, 'no openid']);
    ok('缺 OPENID 时不写库（不落无主错误记录）', cloud.__docs('errors').length === 0, json(cloud.__docs('errors')));
  }
  {
    const { cloud, main } = boot('reportError', { seed: { errors: [] } });
    const circular = { a: 1 };
    circular.self = circular;
    const r = await capture(() => main({ message: 'x', extra: circular }));
    noThrow('reportError 无法序列化的 extra 不抛错', r);
    const doc = cloud.__docs('errors')[0];
    eq('无法序列化的 extra 降级为 {_unserializable:true}', doc.extra, { _unserializable: true });
  }
  {
    // 无参调用（event 为 undefined）：这是 fire-and-forget 的上报口，最不该再抛。
    // 修复前 `event.TARO_ENV` 会抛 TypeError。
    const { cloud, main } = boot('reportError', { seed: { errors: [] } });
    const r = await capture(() => main(undefined));
    const res = noThrow('reportError 无参调用不抛错（event.TARO_ENV → err.TARO_ENV）', r);
    eq('无参调用仍返回 {ok:true}', res && res.ok, true);
    const docs = cloud.__docs('errors');
    eq('无参调用仍然落了一条错误记录', docs.length, 1);
    eq('无 channel 入参时按 APPID 兜底为 weapp', docs[0] && docs[0].channel, 'weapp');
    eq('无 message 入参时落 unknown error', docs[0] && docs[0].message, 'unknown error');
  }
}

/* ================================================================== *
 * 9. 订单族：createOrder / ordersList / queryOrder / refundOrder / closeOrder
 * ================================================================== */

async function caseOrders() {
  currentCase = 'createOrder';
  {
    const { main } = boot('createOrder', { seed: { orders: [] } });
    const r = await capture(() => main({ planId: 'no_such_plan' }));
    threwWith('createOrder 非法 planId → 抛错', r, /invalid planId/);
  }
  {
    const { main } = boot('createOrder', { seed: { orders: [] } });
    const r = await capture(() => main({ planId: 'monthly', channel: 'paypal' }));
    threwWith('createOrder 非法 channel → 抛错', r, /invalid channel/);
  }
  {
    // 早鸟额度守卫：已满 500 单 paid
    const seedOrders = [];
    for (let i = 0; i < 500; i += 1) {
      seedOrders.push({ _id: `o${i}`, openid: `someone-${i}`, planId: 'earlybird_monthly', status: 'paid' });
    }
    const { main } = boot('createOrder', { seed: { orders: seedOrders } });
    const r = await capture(() => main({ planId: 'earlybird_monthly' }));
    threwWith('createOrder 早鸟额度耗尽 → 抛错', r, /earlybird quota exhausted/);
  }
  {
    // 支付通道不可用：必须抛错，但订单要保留（可重试），不得返回假成功
    const { cloud, main } = boot('createOrder', { seed: { orders: [] } });
    const r = await capture(() => main({ planId: 'monthly', channel: 'wechat' }));
    threwWith('createOrder 在支付通道不可用时抛错（不伪装成功）', r, /pay-wechat|下单失败/);
    const orders = cloud.__docs('orders');
    ok('通道失败后订单仍保留在库里（可重试）', orders.length === 1, `orders=${orders.length}`);
    eq('订单状态为 created / payStatus=pending', [orders[0].status, orders[0].payStatus], ['created', 'pending']);
    eq('订单归属当前 openid', orders[0].openid, OWNER);
    ok('确实调用了 pay-wechat 云函数', cloud.__called('callFunction', 'pay-wechat').length === 1, json(cloud.__calls.filter((c) => c.kind === 'callFunction')));
  }
  {
    // 定向验证「回填必须按 add() 返回的 _id 寻址」（第 4 步）。
    // 注意：这里显式替身了 pay-wechat 的**返回值**，只为观测 createOrder 自身的回填逻辑；
    // 它不验证 pay-wechat 的真实行为（那条在本文件末尾「支付通道不得伪装成功」里验证）。
    const { cloud, main } = boot('createOrder', {
      seed: { orders: [] },
      functionOverrides: {
        'pay-wechat': (data) => ({
          ok: true,
          channel: 'wechat',
          orderId: data.orderId,
          payment: { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=x', signType: 'RSA', paySign: 'sig' }
        })
      }
    });
    const r = await capture(() => main({ planId: 'earlybird_monthly', channel: 'wechat' }));
    const res = noThrow('createOrder 通道成功时不抛错', r);
    eq('返回金额换算为元（690 分 → 6.9 元）', res.price, 6.9);
    eq('返回统一 payment 结构（wechatPay）', res.payment && res.payment.wechatPay && res.payment.wechatPay.paySign, 'sig');
    const orders = cloud.__docs('orders');
    eq('回填按 _id 命中同一条订单（channelPayStatus=pending）', orders[0].channelPayStatus, 'pending');
    ok('回填把 payment 写进订单文档', !!orders[0].wechatPayment && orders[0].wechatPayment.paySign === 'sig', json(orders[0].wechatPayment));
  }

  currentCase = 'ordersList';
  {
    const seedOrders = [
      { _id: 'o1', orderId: 'ord_1', openid: OWNER, planId: 'earlybird_monthly', price: 690, months: 1, status: 'created', payStatus: 'pending', createTime: '2026-05-01T00:00:00.000Z' },
      { _id: 'o2', orderId: 'ord_2', openid: OWNER, planId: 'yearly', price: 8800, months: 12, status: 'paid', payStatus: 'paid', createTime: '2026-06-01T00:00:00.000Z' },
      { _id: 'o3', orderId: 'ord_3', openid: OTHER, planId: 'monthly', price: 990, months: 1, status: 'paid', createTime: '2026-07-01T00:00:00.000Z' }
    ];
    const { main } = boot('ordersList', { seed: { orders: seedOrders } });
    const r = await capture(() => main({}));
    const res = noThrow('ordersList 不抛错', r);
    eq('ordersList 只返回自己的订单', res.orders.length, 2);
    ok('ordersList 不含他人订单号', res.orders.every((o) => o.orderId !== 'ord_3'), json(res.orders.map((o) => o.orderId)));
    eq('ordersList 按 createTime 倒序', res.orders.map((o) => o.orderId), ['ord_2', 'ord_1']);
    const early = res.orders.find((o) => o.orderId === 'ord_1');
    eq('价格按分→元换算', early.price, 6.9);
    eq('refundStatus 缺省归一为 none', early.refundStatus, 'none');
    eq('早鸟单标记 isEarlyBird', early.isEarlyBird, true);
  }
  {
    const { main } = boot('ordersList', { context: { OPENID: '' }, seed: { orders: [] } });
    const r = await capture(() => main({}));
    const res = noThrow('ordersList 缺 OPENID 不抛错', r);
    eq('ordersList 缺 OPENID → {ok:false, error:"no openid"}', [res.ok, res.error], [false, 'no openid']);
  }

  {
    // 真实链路：createOrder 建单（通道失败但订单保留）→ ordersList 能查到同一条。
    // 两个云函数共用同一份 mock 实例，模拟"同一个云环境里的同一个库"。
    const { cloud, main } = boot('createOrder', { seed: { orders: [] } });
    const created = await capture(() => main({ planId: 'monthly', channel: 'wechat' }));
    ok('链路：通道失败时 createOrder 抛错', created.threw === true, json(created.value));
    const ordersList = loadCloudFunction('ordersList', cloud);
    const listed = await capture(() => ordersList.main({}));
    const res = noThrow('链路：ordersList 能读同一份库', listed);
    eq('链路：createOrder 建的订单在 ordersList 里可见', res.orders.length, 1);
    eq('链路：金额 990 分 → 9.9 元', res.orders[0].price, 9.9);
    eq('链路：订单号与库内一致', res.orders[0].orderId, cloud.__docs('orders')[0].orderId);
  }

  currentCase = 'queryOrder';
  {
    const seedOrders = [
      { _id: 'o1', orderId: 'ord_1', openid: OWNER, channel: 'wechat', planId: 'monthly', price: 990, months: 1, status: 'created' },
      { _id: 'o2', orderId: 'ord_2', openid: OWNER, channel: 'wechat', planId: 'monthly', price: 990, months: 1, status: 'paid', channelTradeNo: 'wx_trade_1' }
    ];
    const { cloud, main } = boot('queryOrder', { context: { OPENID: OTHER }, seed: { orders: seedOrders, users: [{ _id: 'u-a', openid: OWNER }] } });
    const r = await capture(() => main({ orderId: 'ord_1' }));
    const res = noThrow('queryOrder 越权查询不抛错（返回业务失败）', r);
    eq('别人查我的订单 → {ok:false, error:"order owner mismatch"}', [res.ok, res.error], [false, 'order owner mismatch']);
    ok('越权查询不得触达支付通道', cloud.__called('unsupported').length === 0, json(cloud.__called('unsupported')));
  }
  {
    const seedOrders = [
      { _id: 'o1', orderId: 'ord_1', openid: OWNER, channel: 'wechat', planId: 'monthly', price: 990, months: 1, status: 'created' }
    ];
    const { cloud, main } = boot('queryOrder', { seed: { orders: seedOrders, users: [{ _id: 'u-a', openid: OWNER }] } });
    const r = await capture(() => main({ orderId: 'ord_1' }));
    const res = noThrow('queryOrder 通道不可用时不抛错（降级返回）', r);
    eq('通道不可用 → paid=false（绝不假装已支付）', res.paid, false);
    eq('通道异常归类为 query_failed', res.channelStatus, 'query_failed');
    eq('本地订单状态保持不变（不被误改 paid/closed）', cloud.__docs('orders')[0].status, 'created');
    eq('未对账 → reconciled=false', res.reconciled, false);
  }
  {
    const seedOrders = [
      { _id: 'o2', orderId: 'ord_2', openid: OWNER, channel: 'wechat', planId: 'monthly', price: 990, months: 1, status: 'paid', channelTradeNo: 'wx_trade_1' }
    ];
    const { cloud, main } = boot('queryOrder', { seed: { orders: seedOrders, users: [{ _id: 'u-a', openid: OWNER }] } });
    const r = await capture(() => main({ orderId: 'ord_2' }));
    const res = noThrow('queryOrder 本地已 paid 时不抛错', r);
    eq('本地已 paid → 幂等返回 paid=true / channelStatus=local', [res.paid, res.channelStatus], [true, 'local']);
    ok('幂等分支不触达支付通道（不重复对账）', cloud.__called('unsupported').length === 0, json(cloud.__called('unsupported')));
  }
  {
    const { main } = boot('queryOrder', { seed: { orders: [], users: [] } });
    const r1 = await capture(() => main({}));
    const res1 = noThrow('queryOrder 缺 orderId 不抛错', r1);
    eq('缺 orderId → {ok:false, error:"orderId required"}', res1.error, 'orderId required');
    const r2 = await capture(() => main({ orderId: 'nope' }));
    const res2 = noThrow('queryOrder 查不存在的订单不抛错', r2);
    eq('不存在的订单 → ok:false', res2.ok, false);
  }

  currentCase = 'refundOrder';
  {
    const seedOrders = [
      { _id: 'o1', orderId: 'ord_1', openid: OWNER, channel: 'wechat', planId: 'monthly', price: 990, months: 1, status: 'paid' }
    ];
    const { cloud, main } = boot('refundOrder', { context: { OPENID: OTHER }, seed: { orders: seedOrders, users: [] } });
    const r = await capture(() => main({ orderId: 'ord_1' }));
    const res = noThrow('refundOrder 越权退款不抛错（返回业务失败）', r);
    eq('别人给我的订单退款 → {ok:false, error:"无权限操作此订单"}', [res.ok, res.error], [false, '无权限操作此订单']);
    ok('越权退款不得改动订单退款状态', cloud.__docs('orders')[0].refundStatus === undefined, json(cloud.__docs('orders')[0]));
  }
  {
    const seedOrders = [
      { _id: 'o1', orderId: 'ord_1', openid: OWNER, channel: 'wechat', planId: 'monthly', price: 990, months: 1, status: 'created' }
    ];
    const { main } = boot('refundOrder', { seed: { orders: seedOrders, users: [] } });
    const r = await capture(() => main({ orderId: 'ord_1' }));
    const res = noThrow('refundOrder 未支付订单不抛错', r);
    eq('未支付订单拒绝退款', [res.ok, res.error], [false, '订单未支付或已处理']);
  }
  {
    // 微信通道退款：cloudPay 不可用 → 必须如实失败，且状态落到 refund_failed（不假装成功）
    const seedOrders = [
      { _id: 'o1', orderId: 'ord_1', openid: OWNER, channel: 'wechat', planId: 'monthly', price: 990, months: 1, status: 'paid' }
    ];
    const userExpiredAt = isoFromNow(86400000);
    const { cloud, main } = boot('refundOrder', { seed: { orders: seedOrders, users: [{ _id: 'u-a', openid: OWNER, expiredAt: userExpiredAt }] } });
    const r = await capture(() => main({ orderId: 'ord_1' }));
    const res = noThrow('refundOrder 通道异常不抛出（返回业务失败）', r);
    eq('通道不可用 → ok:false（绝不伪装退款成功）', res.ok, false);
    eq('失败后订单标记 refund_failed 便于人工介入', cloud.__docs('orders')[0].refundStatus, 'refund_failed');
    eq('失败不扣减订阅（expiredAt 保持不变）', cloud.__docs('users')[0].expiredAt, userExpiredAt);
  }
  {
    // 抖音通道：设计上不支持自动退款 → 返回人工指引，且订单回到 pending
    const seedOrders = [
      { _id: 'o1', orderId: 'ord_1', openid: OWNER, channel: 'douyin', planId: 'monthly', price: 990, months: 1, status: 'paid' }
    ];
    const { cloud, main } = boot('refundOrder', { seed: { orders: seedOrders, users: [{ _id: 'u-a', openid: OWNER }] } });
    const r = await capture(() => main({ orderId: 'ord_1' }));
    const res = noThrow('refundOrder 抖音通道不抛错', r);
    eq('抖音通道返回人工退款指引（manualRefund）', [res.ok, res.manualRefund], [false, true]);
    eq('抖音通道不把订单留在 refunding', cloud.__docs('orders')[0].refundStatus, 'pending');
  }

  currentCase = 'closeOrder';
  {
    // 资损安全：通道状态「不确定」时不得关单
    const stale = isoFromNow(-60 * 60 * 1000);
    const seedOrders = [
      { _id: 'o-old', orderId: 'ord_old', openid: OWNER, channel: 'wechat', price: 990, months: 1, status: 'created', createTime: stale },
      { _id: 'o-new', orderId: 'ord_new', openid: OWNER, channel: 'wechat', price: 990, months: 1, status: 'created', createTime: isoFromNow(-1000) }
    ];
    const { cloud, main } = boot('closeOrder', { context: { OPENID: '' }, seed: { orders: seedOrders, users: [{ _id: 'u-a', openid: OWNER }] } });
    const r = await capture(() => main({}));
    const res = noThrow('closeOrder 不抛错', r);
    eq('只扫到超时未支付订单（新鲜的 excluded）', res.scanned, 1);
    eq('通道状态不确定 → 计入 skippedUnknown', res.skippedUnknown, 1);
    eq('通道状态不确定 → 不得关单（资损安全优先）', cloud.__docs('orders').find((o) => o._id === 'o-old').status, 'created');
    eq('本单不计入 closed', res.closed, 0);
  }
}

/* ================================================================== *
 * 9b. shopping（真机端清单 CRUD：归属隔离 + _.remove() 语义 + 错误不伪装成功）
 * ================================================================== */

async function caseShopping() {
  currentCase = 'shopping';
  {
    const { main } = boot('shopping', {
      seed: {
        shopping: [
          { _id: 's-old', openid: OWNER, name: '旧货', bought: false, createdAt: '2026-01-01T00:00:00.000Z', prices: [] },
          { _id: 's-new', openid: OWNER, name: '新货', bought: true, createdAt: '2026-02-01T00:00:00.000Z', prices: [{ platform: '京东', price: 99 }] },
          { _id: 's-other', openid: OTHER, name: '别人的货', bought: false, createdAt: '2026-03-01T00:00:00.000Z', prices: [] }
        ]
      }
    });
    const r = await capture(() => main({ action: 'list' }));
    const res = noThrow('shopping list 不抛错', r);
    eq('shopping 统一返回包装 {code:0,message:"ok"}', [res.code, res.message], [0, 'ok']);
    eq('只返回自己的清单条目', res.data.map((d) => d.id), ['s-new', 's-old']);
    eq('映射 _id → id 且保留 bought 布尔', [res.data[0].id, res.data[0].bought], ['s-new', true]);
  }
  {
    const { cloud, main } = boot('shopping', { seed: { shopping: [] } });
    const r = await capture(() => main({ action: 'add', name: '蓝牙耳机', targetPrice: '299' }));
    const res = noThrow('shopping add 不抛错', r);
    ok('add 返回新条目 id', typeof res.data.id === 'string' && res.data.id.length > 0, json(res.data));
    const docs = cloud.__docs('shopping');
    eq('add 落库归属本人', docs[0].openid, OWNER);
    eq('targetPrice 字符串被转成数字', docs[0].targetPrice, 299);
    eq('add 初始 bought=false / prices=[]', [docs[0].bought, docs[0].prices], [false, []]);
  }
  {
    // 非法 targetPrice 不落库（不能写成 0/NaN）
    const { cloud, main } = boot('shopping', { seed: { shopping: [] } });
    const r = await capture(() => main({ action: 'add', name: '耳机', targetPrice: 'not-a-number' }));
    noThrow('shopping add 非法目标价不抛错', r);
    eq('非法 targetPrice 不写入（字段缺省）', cloud.__docs('shopping')[0].targetPrice, undefined);
  }
  {
    const { main } = boot('shopping', { seed: { shopping: [] } });
    const r = await capture(() => main({ action: 'add', name: '   ' }));
    const res = noThrow('shopping add 空名称不抛错（返回业务失败）', r);
    eq('空名称 → code:-1 且 message=name required', [res.code, res.message], [-1, 'name required']);
  }
  {
    // 越权：B 不能改 / 删 / 比价 A 的条目
    const base = {
      shopping: [
        { _id: 's-a', openid: OWNER, name: 'A 的货', bought: false, createdAt: '2026-01-01T00:00:00.000Z', prices: [], targetPrice: 199 }
      ]
    };
    const cases = [
      { action: 'toggleBought', id: 's-a' },
      { action: 'remove', id: 's-a' },
      { action: 'addPrice', id: 's-a', platform: '淘宝', price: 88 },
      { action: 'setTargetPrice', id: 's-a', price: 100 },
      { action: 'clearTargetPrice', id: 's-a' }
    ];
    const { cloud, main } = boot('shopping', { context: { OPENID: OTHER }, seed: base });
    for (const c of cases) {
      const r = await capture(() => main(c));
      const res = noThrow(`shopping ${c.action} 越权调用不抛错`, r);
      eq(`B 对 A 的条目执行 ${c.action} → code:-1 / not found`, [res.code, res.message], [-1, 'not found']);
    }
    const doc = cloud.__docs('shopping')[0];
    eq('越权尝试后 A 的条目原封不动', [doc.bought, doc.targetPrice, doc.prices.length], [false, 199, 0]);
  }
  {
    // clearTargetPrice 用 db.command.remove() 删字段（真实语义：字段消失，不是置 null）
    const { cloud, main } = boot('shopping', {
      seed: { shopping: [{ _id: 's-a', openid: OWNER, name: 'A 的货', bought: false, createdAt: '2026-01-01T00:00:00.000Z', prices: [], targetPrice: 199, lastNotifiedPrice: 190 }] }
    });
    const r = await capture(() => main({ action: 'clearTargetPrice', id: 's-a' }));
    noThrow('shopping clearTargetPrice 不抛错', r);
    const doc = cloud.__docs('shopping')[0];
    ok('command.remove() 真的删掉字段（targetPrice 不存在）', !Object.prototype.hasOwnProperty.call(doc, 'targetPrice'), json(doc));
    ok('同时删掉 lastNotifiedPrice 去重记录', !Object.prototype.hasOwnProperty.call(doc, 'lastNotifiedPrice'), json(doc));
  }
  {
    const { cloud, main } = boot('shopping', {
      seed: { shopping: [{ _id: 's-a', openid: OWNER, name: 'A 的货', bought: false, createdAt: '2026-01-01T00:00:00.000Z', prices: [{ platform: '京东', price: 99 }] }] }
    });
    const r1 = await capture(() => main({ action: 'addPrice', id: 's-a', platform: '淘宝', price: 88 }));
    noThrow('shopping addPrice 不抛错', r1);
    eq('比价记录追加（保留历史价格）', cloud.__docs('shopping')[0].prices, [{ platform: '京东', price: 99 }, { platform: '淘宝', price: 88 }]);
    const r2 = await capture(() => main({ action: 'addPrice', id: 's-a', platform: '', price: 88 }));
    const res2 = noThrow('shopping addPrice 缺平台不抛错', r2);
    eq('缺平台 → code:-1 / bad price', [res2.code, res2.message], [-1, 'bad price']);
  }
  {
    const { main } = boot('shopping', { seed: { shopping: [] } });
    const r = await capture(() => main({ action: 'unknownAction' }));
    const res = noThrow('shopping 未知 action 不抛错', r);
    eq('未知 action → code:-1 且明示未知动作', [res.code, res.message], [-1, 'unknown action: unknownAction']);
  }
  {
    const { main } = boot('shopping', { context: { OPENID: '' }, seed: { shopping: [] } });
    const r = await capture(() => main({ action: 'list' }));
    threwWith('shopping 缺 OPENID 抛错（清单不能对所有人敞开）', r, /no openid/);
  }
}

/* ================================================================== *
 * 10. getBriefing
 * ================================================================== */

function newsFixture() {
  const sources = ['新华网', '科技日报', '健康时报'];
  const items = [];
  for (let i = 0; i < 12; i += 1) {
    items.push({
      id: `n${i}`,
      title: `国产手机出货量回升第${i}篇`,
      summary: `行业观察摘要 ${i}`,
      source: sources[i % sources.length],
      url: `https://example.com/n${i}`,
      ts: Date.now() - i * 60000,
      tags: ['科技']
    });
  }
  return items;
}

function cacheSeed(fresh = true) {
  return {
    hotspotCache: [
      {
        _id: 'hotspot',
        key: 'hotspot',
        updateTime: fresh ? new Date().toISOString() : isoFromNow(-3 * 60 * 60 * 1000),
        items: newsFixture(),
        softItems: [],
        sourceHealth: []
      },
      {
        _id: 'video',
        key: 'video',
        updateTime: new Date().toISOString(),
        items: [
          { id: 'bili-1', title: '视频一', summary: 's1', source: '哔哩哔哩', url: 'https://b23.tv/1' },
          { id: 'bili-2', title: '视频二', summary: 's2', source: '哔哩哔哩', url: 'https://b23.tv/2' }
        ]
      }
    ]
  };
}

async function caseGetBriefing() {
  currentCase = 'getBriefing';
  {
    const { main } = boot('getBriefing', { context: { OPENID: '' }, seed: { briefings: [] } });
    const r = await capture(() => main({}));
    threwWith('getBriefing 缺 OPENID 抛错（不退化成无归属查询 + 脏记录）', r, /no openid/);
  }
  {
    // 用户路径：只聚合自己的数据；同一天二次打开复用库内晨报
    const seed = Object.assign(
      {
        users: [{ _id: 'u-a', openid: OWNER, briefingTime: '07:30' }],
        events: [
          { _id: 'e-a', openid: OWNER, title: '今天的会', startTime: `${todayStr()} 10:00`, status: 'confirmed' },
          { _id: 'e-old', openid: OWNER, title: '昨天的会', startTime: `${todayStr(-1)} 10:00`, status: 'confirmed' },
          { _id: 'e-b', openid: OTHER, title: '别人的会', startTime: `${todayStr()} 11:00`, status: 'confirmed' }
        ],
        todos: [
          { _id: 't-a', openid: OWNER, title: '我的待办', status: 'confirmed', dueDate: `${todayStr()} 18:00` },
          { _id: 't-b', openid: OTHER, title: '别人的待办', status: 'confirmed', dueDate: `${todayStr()} 18:00` }
        ],
        items: [
          { _id: 'i-a', openid: OWNER, title: '我的收藏', summary: '摘要', createTime: isoFromNow(-3600000) },
          { _id: 'i-b', openid: OTHER, title: '别人的收藏', summary: '摘要', createTime: isoFromNow(-3600000) }
        ],
        shopping: [],
        briefings: [],
        usage: []
      },
      cacheSeed(true)
    );
    const { cloud, main } = boot('getBriefing', { seed });
    const r1 = await capture(() => main({}));
    const b1 = noThrow('getBriefing 首次生成不抛错', r1);
    eq('晨报只含自己的今日日程（不含昨天/他人）', b1.events.map((e) => e._id), ['e-a']);
    eq('晨报只含自己的待办', b1.todos.map((t) => t._id), ['t-a']);
    eq('digest 来自自己的收藏', b1.digest.length, 1);
    eq('晨报带今天日期', b1.date, todayStr());
    const briefings = cloud.__docs('briefings');
    eq('briefings 落库 1 条', briefings.length, 1);
    eq('落库的晨报归属当前 openid', briefings[0].openid, OWNER);
    ok('情报（webSearch 联动）在 mock 下取到缓存资讯，非空', !!b1.intel && Array.isArray(b1.intel.intelItems) && b1.intel.intelItems.length >= 1, json(b1.intel && b1.intel.intelItems && b1.intel.intelItems.length));
    eq('免费档情报标记 aiEnabled=false（无 LLM 不谎称已 AI 提炼）', b1.intel.aiEnabled, false);

    const r2 = await capture(() => main({}));
    const b2 = noThrow('getBriefing 二次打开不抛错', r2);
    eq('同一天二次打开不重复落库', cloud.__docs('briefings').length, 1);
    eq('二次打开返回同一份晨报（同一 _id）', b2._id, briefings[0]._id);
  }
  {
    // 定时路径：按 briefingTime 分桶；无模板 ID 时不下发订阅消息
    const seed = {
      users: [
        { _id: 'u-a', openid: OWNER, briefingTime: '07:30' },
        { _id: 'u-b', openid: OTHER, briefingTime: '09:30' }
      ],
      briefings: [],
      events: [],
      todos: [],
      items: [],
      shopping: [],
      usage: []
    };
    const { cloud, main } = boot('getBriefing', { context: { OPENID: '' }, seed });
    const r = await capture(() => main({ Type: 'Timer', TriggerName: 'brief07', Cron: '0 30 7 * * * *' }));
    const res = noThrow('getBriefing 定时路径不抛错', r);
    eq('triggerHour 从触发器名解析为 7', res.triggerHour, 7);
    eq('扫到全部用户 2 人', res.scanned, 2);
    eq('只给 brief07 分桶的用户生成（1 人）', res.total, 1);
    eq('成功生成 1 份晨报', res.ok, 1);
    const briefings = cloud.__docs('briefings');
    eq('只落库 1 条晨报', briefings.length, 1);
    eq('落库归属 7 点档用户', briefings[0].openid, OWNER);
    ok('未配置模板 ID 时不调用 openapi（不假装推送）', cloud.__called('unsupported', 'openapi').length === 0, json(cloud.__called('unsupported')));
  }
}

/* ================================================================== *
 * 11. chat（LLM 不可用时的确定性分支 + 额度 + 越权）
 * ================================================================== */

async function caseChat() {
  currentCase = 'chat';
  const month = monthStartStr();
  {
    const { main } = boot('chat', { context: { OPENID: '' }, seed: { users: [] } });
    const r = await capture(() => main({ message: '你好' }));
    threwWith('chat 缺 OPENID 抛错（六个集合的数据不能互相可见）', r, /no openid/);
  }
  {
    const { cloud, main } = boot('chat', { seed: { users: [], user_prefs: [], usage: [] } });
    const r = await capture(() =>
      main({ action: 'savePrefs', prefs: { aiFilterEnabled: true, pushFreq: 'mid', dndStart: '22:00', dndEnd: '07:00', parentPin: '1234', legacyField: 'x', pushFreqInvalid: 'zzz' } })
    );
    const res = noThrow('chat savePrefs 不抛错', r);
    eq('savePrefs 返回 {saved:true}', res.saved, true);
    const prefs = cloud.__docs('user_prefs');
    eq('user_prefs 落库 1 条并归属本人', prefs.length === 1 && prefs[0].openid === OWNER, true);
    eq('白名单外的字段被丢弃（legacyField 不落库）', prefs[0].legacyField, undefined);
    eq('合法字段正常落库', [prefs[0].pushFreq, prefs[0].aiFilterEnabled], ['mid', true]);
    ok('落库带 createdAt/updatedAt', typeof prefs[0].createdAt === 'string' && typeof prefs[0].updatedAt === 'string', json(prefs[0]));
  }
  {
    const { cloud, main } = boot('chat', { seed: { users: [], user_prefs: [], usage: [] } });
    const r = await capture(() => main({ action: 'savePrefs', prefs: { unknown: 1 } }));
    const res = noThrow('chat savePrefs 全非法字段不抛错', r);
    eq('全非法字段 → {saved:false, error:"invalid prefs"}', [res.saved, res.error], [false, 'invalid prefs']);
    ok('全非法字段不写库', cloud.__docs('user_prefs').length === 0, json(cloud.__docs('user_prefs')));
  }
  {
    const { main } = boot('chat', {
      seed: {
        users: [],
        usage: [],
        user_prefs: [{ _id: 'p-a', openid: OWNER, aiFilterEnabled: false, pushFreq: 'high', createdAt: 'x', updatedAt: 'y' }]
      }
    });
    const r = await capture(() => main({ action: 'getPrefs' }));
    const res = noThrow('chat getPrefs 不抛错', r);
    eq('getPrefs 只回传 schema 字段（剔除 openid/_id/时间戳）', res.prefs, { aiFilterEnabled: false, pushFreq: 'high' });
  }
  {
    const { main } = boot('chat', { context: { OPENID: OTHER }, seed: { users: [], usage: [], user_prefs: [{ _id: 'p-a', openid: OWNER, pushFreq: 'high' }] } });
    const r = await capture(() => main({ action: 'getPrefs' }));
    const res = noThrow('chat getPrefs（他人）不抛错', r);
    eq('B 读不到 A 的偏好', res.prefs, null);
  }
  {
    const { cloud, main } = boot('chat', { seed: { users: [], usage: [], user_affinity: [] } });
    const r = await capture(() =>
      main({
        action: 'saveAffinity',
        affinity: [
          { category: ' 科技 ', score: 250 },
          { category: '健康', score: -5 },
          { category: '', score: 10 },
          { category: 'X', score: 'not-number' }
        ]
      })
    );
    const res = noThrow('chat saveAffinity 不抛错', r);
    eq('saveAffinity 返回清洗后的条数', [res.saved, res.count], [true, 2]);
    const docs = cloud.__docs('user_affinity');
    eq('分数裁剪到 [0,100] 并取整', docs[0].affinity, [{ category: '科技', score: 100 }, { category: '健康', score: 0 }]);
    eq('user_affinity 归属本人', docs[0].openid, OWNER);
  }
  {
    const { main } = boot('chat', { seed: { users: [], usage: [], user_affinity: [] } });
    const r = await capture(() => main({ action: 'saveAffinity', affinity: 'not-an-array' }));
    const res = noThrow('chat saveAffinity 非数组不抛错', r);
    eq('非数组 → {saved:false, error:"invalid affinity"}', [res.saved, res.error], [false, 'invalid affinity']);
  }
  {
    const { main } = boot('chat', { seed: { users: [], usage: [], user_affinity: [{ _id: 'af-a', openid: OWNER, affinity: [{ category: '科技', score: 42 }] }] } });
    const r = await capture(() => main({ action: 'getAffinity' }));
    const res = noThrow('chat getAffinity 不抛错', r);
    eq('getAffinity 回传摘要数组', res.affinity, [{ category: '科技', score: 42 }]);
  }
  {
    // 额度超限：必须在调 LLM 之前拒绝，且不扣额度
    const { cloud, main } = boot('chat', {
      seed: { users: [{ _id: 'u-a', openid: OWNER, subscribed: false }], usage: [{ _id: 'usage-a', openid: OWNER, month, voiceUsed: 20 }], events: [], todos: [] }
    });
    const r = await capture(() => main({ message: '帮我看看今天的安排' }));
    threwWith('chat 免费额度用尽 → 抛错提示订阅', r, /voice quota exceeded/);
    eq('额度用尽时不额外扣额度', cloud.__docs('usage')[0].voiceUsed, 20);
  }
  {
    // 免费用户正常一轮：LLM 不可用 → 规则兜底（诚实降级），额度 +1
    const { cloud, main } = boot('chat', {
      seed: { users: [{ _id: 'u-a', openid: OWNER, subscribed: false }], usage: [{ _id: 'usage-a', openid: OWNER, month, voiceUsed: 3 }], events: [], todos: [] }
    });
    const r = await capture(() => main({ message: '你好' }));
    const res = noThrow('chat LLM 不可用时不抛错（走规则兜底）', r);
    eq('规则兜底返回 query 动作', res.action, 'query');
    eq('规则兜底回复不编造内容（无日程/待办时的确定性文案）', res.reply, '你目前没有日程和待办，享受清净吧。');
    eq('免费用户一轮对话扣 1 次额度', cloud.__docs('usage')[0].voiceUsed, 4);
  }
  {
    // 当月首轮对话：getUsage 新建 usage 文档 → **必须带 _id** → 额度正常累加。
    // （2026-10 修复前这里是 `return doc`，没有 _id，调用方 doc(undefined).update 必抛错。）
    const { cloud, main } = boot('chat', {
      seed: { users: [{ _id: 'u-a', openid: OWNER, subscribed: false }], usage: [], events: [], todos: [] }
    });
    const r1 = await capture(() => main({ message: '你好' }));
    noThrow('当月首轮对话不抛错（getUsage 新建的 usage 文档必须带 _id）', r1);
    const usageDocs = cloud.__docs('usage');
    eq('首轮对话后 usage 文档有且仅有 1 条', usageDocs.length, 1);
    ok('新建的 usage 文档回传了 _id', typeof usageDocs[0]._id === 'string' && usageDocs[0]._id.length > 0, json(usageDocs[0]));
    eq('首轮对话后 voiceUsed === 1（额度真的扣了）', usageDocs[0].voiceUsed, 1);
    const r2 = await capture(() => main({ message: '你好' }));
    noThrow('同月第二轮对话不抛错', r2);
    eq('同月第二轮后 voiceUsed === 2（累加而非覆盖）', cloud.__docs('usage')[0].voiceUsed, 2);
  }
  {
    // 订阅用户：不查也不扣额度
    const usageDoc = { _id: 'usage-a', openid: OWNER, month, voiceUsed: 9 };
    const { cloud, main } = boot('chat', {
      seed: {
        users: [{ _id: 'u-a', openid: OWNER, subscribed: true, expiredAt: isoFromNow(86400000) }],
        usage: [usageDoc],
        events: [],
        todos: []
      }
    });
    const r = await capture(() => main({ message: '你好' }));
    noThrow('chat 订阅用户不抛错', r);
    eq('订阅用户不扣语音额度', cloud.__docs('usage').find((u) => u._id === 'usage-a').voiceUsed, 9);
  }
  {
    // 规则兜底的确定性写库：「完成」→ 把最早到期的一条待办置 done
    const { cloud, main } = boot('chat', {
      seed: {
        users: [{ _id: 'u-a', openid: OWNER, subscribed: false }],
        usage: [{ _id: 'usage-a', openid: OWNER, month, voiceUsed: 0 }],
        events: [],
        todos: [
          { _id: 't-late', openid: OWNER, title: '晚点做', status: 'confirmed', dueDate: `${todayStr()} 20:00` },
          { _id: 't-soon', openid: OWNER, title: '赶紧做', status: 'confirmed', dueDate: `${todayStr()} 09:00` },
          { _id: 't-b', openid: OTHER, title: '别人的', status: 'confirmed', dueDate: `${todayStr()} 08:00` }
        ]
      }
    });
    const r = await capture(() => main({ message: '我完成了' }));
    const res = noThrow('chat「完成」规则兜底不抛错', r);
    eq('返回 todo_done 动作', res.action, 'todo_done');
    const todos = cloud.__docs('todos');
    eq('只把本人最早到期的一条置 done', [todos.find((t) => t._id === 't-soon').status, todos.find((t) => t._id === 't-late').status], ['done', 'confirmed']);
    eq('别人的待办不得被动到', todos.find((t) => t._id === 't-b').status, 'confirmed');
  }
  {
    // 没有本人待办时，「完成」不得误伤他人数据
    const { cloud, main } = boot('chat', {
      seed: {
        users: [{ _id: 'u-a', openid: OWNER, subscribed: false }],
        usage: [{ _id: 'usage-a', openid: OWNER, month, voiceUsed: 0 }],
        events: [],
        todos: [{ _id: 't-b', openid: OTHER, title: '别人的', status: 'confirmed', dueDate: `${todayStr()} 08:00` }]
      }
    });
    const r = await capture(() => main({ message: '做完了' }));
    noThrow('chat 无本人待办时「完成」不抛错', r);
    eq('他人待办状态保持不变', cloud.__docs('todos')[0].status, 'confirmed');
  }
  {
    // applyPlan：落库带 openid；改期越权被归属校验挡住
    const { cloud, main } = boot('chat', {
      seed: {
        users: [],
        usage: [],
        events: [
          { _id: 'e-a', openid: OWNER, title: '我的会', startTime: `${todayStr()} 10:00`, status: 'confirmed' },
          { _id: 'e-b', openid: OTHER, title: '别人的会', startTime: `${todayStr()} 11:00`, status: 'confirmed' }
        ]
      }
    });
    const r = await capture(() =>
      main({
        action: 'applyPlan',
        proposalId: 'p1',
        events: [
          { eventId: 'e-a', title: '我的会', startTime: `${todayStr()} 15:00` },
          { title: '新排的会', startTime: `${todayStr()} 16:00` }
        ]
      })
    );
    const res = noThrow('chat applyPlan 不抛错', r);
    eq('applyPlan 返回 {code:0, saved:2}', [res.code, res.data.saved], [0, 2]);
    const events = cloud.__docs('events');
    eq('改期命中本人日程', events.find((e) => e._id === 'e-a').startTime, `${todayStr()} 15:00`);
    const created = events.find((e) => e.title === '新排的会');
    eq('新建日程归属本人', created && created.openid, OWNER);
    eq('新建日程 status=confirmed', created && created.status, 'confirmed');

    const r2 = await capture(() => main({ action: 'applyPlan', events: [{ eventId: 'e-b', title: '别人的会', startTime: `${todayStr()} 19:00` }] }));
    const res2 = noThrow('chat applyPlan 越权改期不抛错', r2);
    eq('越权改期 saved=0', res2.data.saved, 0);
    eq('他人日程时间未被改动', cloud.__docs('events').find((e) => e._id === 'e-b').startTime, `${todayStr()} 11:00`);
  }
  {
    const { main } = boot('chat', { seed: { users: [], usage: [], events: [], todos: [] } });
    const r = await capture(() => main({}));
    threwWith('chat 缺 message → 抛错', r, /message is required/);
  }
}

/* ================================================================== *
 * 12. extract（LLM 不可用时必须失败，不得编造提取结果）
 * ================================================================== */

async function caseExtract() {
  currentCase = 'extract';
  {
    const { main } = boot('extract');
    const r = await capture(() => main({ content: '明天下午三点和产品评审' }));
    // callLLM 缺 key 会抛 'LLM_API_KEY not configured'；无论哪种，必须「失败」而不是「返回假数据」
    ok(
      'extract 在 LLM 不可用时失败（抛错，绝不返回假提取结果）',
      r.threw === true,
      `threw=${r.threw} value=${json(r.value)}`
    );
    ok('失败原因与 LLM 配置/调用相关（不是被静默吞掉）', r.threw === true && /LLM_API_KEY|LLM |timeout/i.test(String(r.error && r.error.message)), json(r.error && r.error.message));
  }
  {
    const { main } = boot('extract', { context: { OPENID: '' } });
    const r = await capture(() => main({ content: 'x' }));
    threwWith('extract 缺 OPENID 抛错', r, /no openid/);
  }
  {
    const { main } = boot('extract');
    const r1 = await capture(() => main({}));
    threwWith('extract 空内容 → 抛错', r1, /content or images is required/);
    const r2 = await capture(() => main({ content: 'x'.repeat(5001) }));
    threwWith('extract 内容超长 → 抛错', r2, /content too long/);
  }
}

/* ================================================================== *
 * 13. webSearch（公开内容免 openid；涉身份分支要身份；LLM 不可用要如实降级）
 * ================================================================== */

async function caseWebSearch() {
  currentCase = 'webSearch';
  {
    // hotspot 免 openid（公开内容），使用库内缓存 → 全程离线
    const { main } = boot('webSearch', { context: { OPENID: '' }, seed: cacheSeed(true) });
    const r = await capture(() => main({ action: 'hotspot' }));
    const res = noThrow('webSearch hotspot 免 openid 可调用', r);
    eq('hotspot 返回 code:0', res.code, 0);
    eq('hotspot 首页条数为 10', res.data.length, 10);
    const firstThree = res.data.slice(0, 3).map((n) => n.source);
    eq('首页前 3 条来自不同源（每源最多 1 条）', new Set(firstThree).size, 3);
  }
  {
    const { main } = boot('webSearch', { context: { OPENID: '' }, seed: cacheSeed(true) });
    const r = await capture(() => main({ action: 'videoNews' }));
    const res = noThrow('webSearch videoNews 免 openid 可调用', r);
    eq('videoNews 返回 code:0', res.code, 0);
    eq('videoNews 只返回 1 条', res.data.length, 1);
  }
  {
    // 涉身份分支：无 openid 必须拒绝
    const { cloud, main } = boot('webSearch', { context: { OPENID: '' }, seed: Object.assign({ users: [], newsFeedback: [], usage: [] }, cacheSeed(true)) });
    const r = await capture(() => main({ action: 'briefing' }));
    const res = noThrow('webSearch briefing 无身份不抛错（返回业务失败）', r);
    eq('briefing 无身份 → {code:-1, message:"no openid"}', [res.code, res.message], [-1, 'no openid']);
    ok('briefing 无身份时不写 usage（不产生无主账本）', cloud.__docs('usage').length === 0, json(cloud.__docs('usage')));
  }
  {
    const { cloud, main } = boot('webSearch', { context: { OPENID: '' }, seed: Object.assign({ users: [], newsFeedback: [] }, cacheSeed(true)) });
    const r = await capture(() => main({ action: 'feedback', id: 'n1', feedback: 'up' }));
    const res = noThrow('webSearch feedback 无身份不抛错', r);
    eq('feedback 无身份 → {code:-1, message:"no openid"}', [res.code, res.message], [-1, 'no openid']);
    ok('feedback 无身份时不落库', cloud.__docs('newsFeedback').length === 0, json(cloud.__docs('newsFeedback')));
  }
  {
    const { cloud, main } = boot('webSearch', { seed: Object.assign({ users: [], newsFeedback: [] }, cacheSeed(true)) });
    const r = await capture(() => main({ action: 'feedback', id: 'n1', feedback: 'up' }));
    const res = noThrow('webSearch feedback 有身份不抛错', r);
    eq('feedback 正常返回 code:0', res.code, 0);
    const docs = cloud.__docs('newsFeedback');
    eq('feedback 落库归属本人', docs[0].openid, OWNER);
    eq('feedback 值归一为 up', docs[0].value, 'up');
  }
  {
    // aiFilter：候选为空 → 明确拒绝；有候选但无 LLM key → 明确失败（不返回假 picks）
    const { main } = boot('webSearch', { seed: cacheSeed(true) });
    const r1 = await capture(() => main({ action: 'aiFilter', candidates: [] }));
    const res1 = noThrow('webSearch aiFilter 无候选不抛错', r1);
    eq('aiFilter 无候选 → code:-1 / candidates required', [res1.code, res1.message], [-1, 'candidates required']);

    const r2 = await capture(() => main({ action: 'aiFilter', interests: ['科技'], candidates: ['1. [新华网·科技] 某芯片发布'] }));
    const res2 = noThrow('webSearch aiFilter 无 LLM key 不抛错', r2);
    eq('aiFilter 无 LLM key → code:-1 且明示未配置（绝不返回假 picks）', [res2.code, res2.message, res2.data], [-1, 'LLM_API_KEY not configured', null]);
  }
  {
    // 免费档 briefing：零 LLM 成本，返回公开 RSS 原始条目 + degraded:false（无东西失败）
    const { main } = boot('webSearch', {
      seed: Object.assign({ users: [{ _id: 'u-a', openid: OWNER, subscribed: false, preferences: [] }], usage: [] }, cacheSeed(true))
    });
    const r = await capture(() => main({ action: 'briefing' }));
    const res = noThrow('webSearch briefing 免费档不抛错', r);
    eq('免费档返回 code:0 / subscribed:false', [res.code, res.data.subscribed], [0, false]);
    eq('免费档 intelItems 上限 3 条', res.data.intelItems.length, 3);
    eq('免费档 degraded=false（没有 AI 就不算降级）', res.data.degraded, false);
    eq('免费档 aiEnabled=false（前端据此显示档位说明）', res.data.aiEnabled, false);
  }
  {
    // 订阅档：没 LLM key → 必须 degraded:true（本该有 AI 却没拿到），但仍有兜底内容
    const { cloud, main } = boot('webSearch', {
      seed: Object.assign(
        { users: [{ _id: 'u-a', openid: OWNER, subscribed: true, expiredAt: isoFromNow(86400000), preferences: [] }], usage: [] },
        cacheSeed(true)
      )
    });
    const r = await capture(() => main({ action: 'briefing' }));
    const res = noThrow('webSearch briefing 订阅档不抛错', r);
    eq('订阅档确实走 AI 档（aiEnabled:true）', res.data.aiEnabled, true);
    eq('LLM 不可用 → degraded:true（不谎称已提炼）', res.data.degraded, true);
    ok('降级后仍有兜底资讯（不返回空壳）', res.data.intelItems.length > 0, `intelItems=${res.data.intelItems.length}`);
    eq('LLM 尝试消耗一次今日情报额度', cloud.__docs('usage')[0] && cloud.__docs('usage')[0].intelUsed, 1);
  }
  {
    const { main } = boot('webSearch', { seed: cacheSeed(true) });
    const r = await capture(() => main({ action: 'nonsense' }));
    const res = noThrow('webSearch 未知 action 不抛错', r);
    eq('未知 action → code:-1', res.code, -1);
  }
}

/* ================================================================== *
 * 14. 支付/授权类：只断言「不得伪装成功」
 * ================================================================== */

async function casePaymentHonesty() {
  currentCase = 'pay-* 不得伪装成功';
  const cases = [
    { name: 'pay-wechat', event: { planId: 'monthly', orderId: 'ord_x', totalAmount: 990, openid: OWNER } },
    { name: 'pay-alipay', event: { planId: 'monthly', orderId: 'ord_x', totalAmount: 990, buyerId: '2088000000000001' } },
    { name: 'pay-douyin', event: { planId: 'monthly', orderId: 'ord_x', totalAmount: 990, openid: OWNER } },
    { name: 'auth-alipay', event: { authCode: 'fake-code' } },
    { name: 'auth-douyin', event: { code: 'fake-code' } }
  ];
  for (const c of cases) {
    const loadResult = await capture(async () => boot(c.name, { seed: { orders: [], users: [] } }));
    if (loadResult.threw) {
      // 加载失败说明这条用例根本没被执行 —— 记 FAIL 而不是"默认通过"，
      // 否则新增一个裸包依赖就能让诚实性验证静默失效。
      ok(
        `${c.name} 应能在 mock 下加载并执行`,
        false,
        `加载失败：${String((loadResult.error && loadResult.error.message) || loadResult.error)}`
      );
      continue;
    }
    const { main } = loadResult.value;
    const r = await capture(() => main(c.event));
    const succeeded =
      r.threw !== true &&
      r.value &&
      (r.value.ok === true || (r.value.code === 0 && r.value.data && r.value.data.payment));
    ok(`${c.name} 在凭据/通道不可用时不得返回成功`, succeeded === false, `threw=${r.threw} value=${json(r.value)}`);
  }
  {
    // pay-callback：无法识别通道时返回错误响应，不得看起来像对账成功
    const { cloud, main } = boot('pay-callback', { context: { OPENID: '' }, seed: { orders: [], users: [] } });
    const r = await capture(() => main({}));
    const res = noThrow('pay-callback 无法识别通道时不抛出（返回错误响应）', r);
    ok('pay-callback 未知通道的响应不得声明成功', !(res && (res.errcode === 0 || res.code === 0 || res.ok === true)), json(res));
    eq('pay-callback 未改动任何订单', cloud.__docs('orders').length, 0);
  }
}

/* ================================================================== *
 * 15. 静态对齐：deleteAccount 的注销清单 ↔ 云函数里「按 openid 写入」的集合
 *
 * 背景（2026-10 真实缺陷）：deleteAccount 的清单自称「逐一对照过所有写入点」，
 * 但漏了 reportError 写的 errors —— 注销后崩溃上报仍留着用户 openid / 页面 / 堆栈。
 * 这类缺陷**运行时很难发现**（只有那个集合恰好有数据时才暴露），所以必须静态守住：
 * 凡是「按 openid 写入」的集合，都必须出现在注销清单里。
 * ================================================================== */

/** 递归列出 cloudfunctions/ 下所有 .js（跳过 node_modules） */
function walkCloudFunctionJsFiles(dir = FN_DIR, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkCloudFunctionJsFiles(full, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 全用户共享、文档里不含 openid 的集合（显式白名单 + 理由）。
 * 白名单必须写理由：否则它就会变成「以后所有闹钟都按掉」的那张单子。
 */
const GLOBAL_COLLECTIONS = new Map([
  ['hotspotCache', '全用户共享的 RSS/视频缓存（readHotspotCache/writeHotspotCache），文档是 items 而非用户数据']
]);

/** 把 `collection('x')` / `collection(PREFS_COLLECTION)` 的集合名解析出来 */
function resolveCollectionName(src, arg) {
  const literal = arg.match(/^['"]([^'"]+)['"]$/);
  if (literal) return literal[1];
  const ident = arg.match(/^[A-Za-z_$][\w$]*$/);
  if (!ident) return null;
  const decl = new RegExp(`const\\s+${ident}\\s*=\\s*['"]([^'"]+)['"]`).exec(src);
  return decl ? decl[1] : null;
}

/** 取 `const <ident> = { ... };` 这段对象字面量源码 */
function findObjectLiteral(src, ident) {
  const idx = src.search(new RegExp(`const\\s+${ident}\\s*=\\s*\\{`));
  if (idx < 0) return null;
  const rest = src.slice(idx);
  const close = /\n\s*\};/.exec(rest);
  return close ? rest.slice(0, close.index + close[0].length) : rest;
}

/**
 * 扫描「按 openid 写入」的集合名。
 * 判据：collection(X) 后面紧跟 add/set/update，且满足其一 ——
 *   ① 该写入片段里出现 openid（字面量或 `{ openid, ... }` 简写）；
 *   ② 载荷是变量（`add({ data: doc })`），而该变量的对象字面量里有 `openid:`。
 * 判据②是必须的：reportError 正是 `const doc = { openid: OPENID, ... }; add({ data: doc })`，
 * 只看①会恰好漏掉它 —— 那就是本次要防的形态。
 */
function scanUserScopedWriteCollections() {
  const found = new Set();
  for (const file of walkCloudFunctionJsFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const calls = [];
    const re = /collection\(\s*([^)]*)\)/g;
    let m = re.exec(src);
    while (m) {
      calls.push({ at: m.index, arg: m[1].trim() });
      m = re.exec(src);
    }
    for (let i = 0; i < calls.length; i += 1) {
      const start = calls[i].at;
      const end = i + 1 < calls.length ? calls[i + 1].at : src.length;
      const chunk = src.slice(start, end);
      if (!/\.(add|set|update)\(/.test(chunk)) continue;
      const name = resolveCollectionName(src, calls[i].arg);
      if (!name) continue;
      let userScoped = /\bopenid\b/.test(chunk);
      if (!userScoped) {
        const byVar = chunk.match(/\.(?:add|set|update)\(\s*\{\s*data:\s*([A-Za-z_$][\w$]*)\s*[,}]/);
        if (byVar) {
          const literal = findObjectLiteral(src, byVar[1]);
          if (literal && /openid\s*:/.test(literal)) userScoped = true;
        }
      }
      if (userScoped) found.add(name);
    }
  }
  return found;
}

async function caseStaticAlignment() {
  currentCase = '静态对齐（注销清单）';
  const src = fs.readFileSync(path.join(FN_DIR, 'deleteAccount', 'index.js'), 'utf8');
  const arrMatch = src.match(/const collections = \[([\s\S]*?)\];/);
  ok('能解析出 deleteAccount 的注销清单', !!arrMatch, '正则未命中 const collections = [ ... ];');
  const listed = arrMatch ? Array.from(arrMatch[1].matchAll(/'([^']+)'/g)).map((x) => x[1]) : [];

  const found = scanUserScopedWriteCollections();
  // 先守扫描器自身：它瞎了的话下面的「未登记为空」就是假绿
  ok('扫描器自身有效：至少扫出 8 个按 openid 写入的集合', found.size >= 8, `实际 ${found.size}：${json([...found])}`);
  ok('扫描器能看到 errors（否则它对本次缺陷是瞎的）', found.has('errors'), json([...found]));
  ok('扫描器能看到 users / orders / items', ['users', 'orders', 'items'].every((c) => found.has(c)), json([...found]));

  const missing = [...found].filter((c) => !listed.includes(c) && !GLOBAL_COLLECTIONS.has(c));
  ok(
    '所有按 openid 写入的集合都已登记进注销清单',
    missing.length === 0,
    `未登记: ${missing.join(', ') || '(无)'} —— 注销会把这些集合里的用户数据留在云端（F18）`
  );

  const stale = listed.filter((c) => c !== 'history' && !found.has(c));
  ok('注销清单里没有「写错名字 / 无任何写入点」的集合（history 沿用历史存量，例外）', stale.length === 0, `可疑: ${stale.join(', ') || '(无)'}`);
}

/* ================================================================== *
 * 主流程
 * ================================================================== */

const SCENARIOS = [
  ['mock 自证', caseMockSemantics],
  ['login', caseLogin],
  ['updateSettings', caseUpdateSettings],
  ['todoStatus', caseTodoStatus],
  ['getLibrary', caseGetLibrary],
  ['confirmItem', caseConfirmItem],
  ['getUsage', caseGetUsage],
  ['deleteAccount', caseDeleteAccount],
  ['reportError', caseReportError],
  ['订单族', caseOrders],
  ['shopping', caseShopping],
  ['getBriefing', caseGetBriefing],
  ['chat', caseChat],
  ['extract', caseExtract],
  ['webSearch', caseWebSearch],
  ['支付类诚实性', casePaymentHonesty],
  ['静态对齐（注销清单）', caseStaticAlignment]
];

async function runAll() {
  for (const [title, fn] of SCENARIOS) {
    try {
      await fn();
    } catch (err) {
      // 场景级未捕获异常也要计入失败（绝不能静默跳过整个场景）
      failures.push({
        name: `[${title}] 场景执行抛出未捕获异常`,
        detail: (err && err.stack) || String(err)
      });
    }
  }
}

runAll().then(() => {
  if (failures.length > 0) {
    realError(`\n失败用例（${failures.length}）：`);
    for (const f of failures) {
      realError(`  ✗ ${f.name}`);
      if (f.detail) realError(`      ${f.detail}`);
    }
    realError('');
  } else {
    realWarn(`\n全部通过：${SCENARIOS.length} 个场景（cloudfunctions/ 的真实业务逻辑）`);
  }
  out(`PASS ${passCount} / FAIL ${failures.length}`);
  out(`断言总数 ${passCount + failures.length}`);
  process.exit(failures.length > 0 ? 1 : 0);
});
