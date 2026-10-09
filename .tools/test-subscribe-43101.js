// =============================================================================
// getBriefing 定时任务：订阅消息 43101（用户侧已不可达）单独处理的断言套件
//
// 测的是**真实 runScheduled()**（exports.scheduled），只 stub 掉 wx-server-sdk 的
// 数据库与 openapi。核心要证明五件事，缺一不可：
//   ① 43101 被单独计数（不算 failed、不算成"没发出去就整人失败"），且写回授权标记；
//   ② 真故障（网络错、模板参数错 43104）**仍然**算 failed、**不改**授权标记；
//   ③ 不会把识别面扩大到别的错误码（负对照）—— 只认 43101，否则就是"改宽了"的隐患；
//   ④ 43101 的**三条形态**都要覆盖：errCode / errcode（小写）/ 仅 errMsg。
//      ← 2026-10-09 补：独立复核用变异验证发现，缺一条种子时把该分支删掉测试**仍然全绿**，
//        即"三条路径都识别"这句话当时其实只有两条被测试约束。这类假绿必须靠种子覆盖堵掉。
//   ⑤ pushPriceAlert 的 43101 分支要**真的被执行到**（断言 14 专门守这一点）。
//      ← 2026-10-09 补：此前本脚本 `delete process.env.PRICE_ALERT_TEMPLATE_ID`，
//        导致 pushPriceAlert 在 guard 处直接 return，那条改动**一次都没跑过**。
//        更隐蔽的是：它和 shopping 集合为空**双重短路**，两层都让循环体不执行。
//        "删掉该分支测试仍全绿" = 该分支当时没有任何回归保护。
//
// 运行：node .tools/test-subscribe-43101.js
// =============================================================================
'use strict';
const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------- 最小内存 DB
const CMD = {
  gte: (v) => ({ __op: 'gte', v }),
  gt: (v) => ({ __op: 'gt', v }),
  lt: (v) => ({ __op: 'lt', v }),
  lte: (v) => ({ __op: 'lte', v }),
  eq: (v) => ({ __op: 'eq', v }),
  neq: (v) => ({ __op: 'neq', v })
};
function matchOne(docVal, cond) {
  if (cond && typeof cond === 'object' && cond.__op) {
    const a = docVal, b = cond.v;
    switch (cond.__op) {
      case 'gte': return a >= b;
      case 'gt': return a > b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      case 'eq': return a === b;
      case 'neq': return a !== b;
      default: return false;
    }
  }
  return docVal === cond;
}
function makeQuery(col) {
  let filters = [];
  let sortKey = null, sortDir = 'asc', lim = null;
  const q = {
    where(c) { filters.push(c); return q; },
    orderBy(k, d) { sortKey = k; sortDir = d || 'asc'; return q; },
    limit(n) { lim = n; return q; },
    field() { return q; },
    async get() {
      let arr = [...col.docs.values()];
      for (const cond of filters) {
        arr = arr.filter((d) => Object.keys(cond).every((k) => matchOne(d[k], cond[k])));
      }
      if (sortKey) {
        arr.sort((a, b) => {
          const av = a[sortKey], bv = b[sortKey];
          if (av === bv) return 0;
          return sortDir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1);
        });
      }
      if (lim != null) arr = arr.slice(0, lim);
      return { data: arr };
    },
    async count() {
      const r = await q.get();
      return { total: r.data.length };
    }
  };
  return q;
}
function makeCollection(name) {
  const docs = new Map();
  return {
    name,
    docs,
    doc(id) {
      return {
        async get() {
          if (!docs.has(id)) { const e = new Error('doc not found ' + name + '/' + id); e.code = 'NOT_FOUND'; throw e; }
          return { data: docs.get(id) };
        },
        async set({ data }) { docs.set(id, Object.assign({ _id: id }, data)); return {}; },
        async update({ data }) {
          if (!docs.has(id)) { const e = new Error('update missing ' + id); e.code = 'NOT_FOUND'; throw e; }
          docs.set(id, Object.assign({}, docs.get(id), data));
          return { stats: { updated: 1 } };
        }
      };
    },
    async add({ data }) { const id = 'auto_' + Math.random().toString(36).slice(2, 9); docs.set(id, Object.assign({ _id: id }, data)); return { _id: id }; },
    where(c) { return makeQuery(this).where(c); },
    orderBy(k, d) { return makeQuery(this).orderBy(k, d); },
    limit(n) { return makeQuery(this).limit(n); },
    async get() { return makeQuery(this).get(); },
    async count() { return makeQuery(this).count(); }
  };
}
const collections = new Map();
function col(name) { if (!collections.has(name)) collections.set(name, makeCollection(name)); return collections.get(name); }

// ------------------------------------------------------------ 种子用户 & openapi
const USERS = [
  { _id: 'u1', openid: 'openid-A', subscribeAccepted: true, briefingTime: '07:30' }, // 形态① errCode 43101
  { _id: 'u2', openid: 'openid-B', subscribeAccepted: true, briefingTime: '07:30' }, // 网络真故障
  { _id: 'u3', openid: 'openid-C', subscribeAccepted: true, briefingTime: '07:30' }, // 正常成功
  { _id: 'u4', openid: 'openid-D', subscribeAccepted: true, briefingTime: '07:30' }, // 43104（负对照）
  { _id: 'u5', openid: 'openid-E', subscribeAccepted: true, briefingTime: '07:30' }, // 形态③ 仅 errMsg
  { _id: 'u6', openid: 'openid-F', subscribeAccepted: true, briefingTime: '07:30' }, // 形态② errcode（小写键）
  { _id: 'u7', openid: 'openid-G', subscribeAccepted: true, briefingTime: '07:30' }, // 形态④ errCode 为字符串 '43101'
  { _id: 'u8', openid: 'openid-H', subscribeAccepted: true, briefingTime: '07:30' }  // 走降价提醒分支
];
for (const u of USERS) col('users').docs.set(u._id, Object.assign({}, u));

// 给 openid-H 造两条会触发提醒的商品（targetPrice 高于最低价，且未通知过同价位）
col('shopping').docs.set('s1', { _id: 's1', openid: 'openid-H', name: '测试商品A', targetPrice: 100, prices: [{ platform: 'jd', price: 88 }], lastNotifiedPrice: null });
col('shopping').docs.set('s2', { _id: 's2', openid: 'openid-H', name: '测试商品B', targetPrice: 200, prices: [{ platform: 'tb', price: 150 }], lastNotifiedPrice: null });

const BRIEFING_TMPL = 'TMPL_TEST';
const PRICE_TMPL = 'TMPL_PRICE';
const sendLog = [];

/**
 * 按**模板**分派行为，而不是只按 openid —— 因为同一用户会走两条不同的下发通道，
 * 混在一起就分不清"是谁在抛"。
 */
function behaviorFor(args) {
  const touser = args && args.touser;
  const tmpl = args && args.templateId;

  if (tmpl === PRICE_TMPL) {
    // 降价提醒：openid-H 的第一条告警就抛 43101。
    // 若 break 生效 → 全程只尝试 1 次；若 break 被删/识别失效 → 会尝试第 2 次（断言 15 红）。
    if (touser === 'openid-H') return { throw: { errCode: 43101, errMsg: 'user refuse to accept the msg' } };
    return { ok: true };
  }

  // 晨报模板
  if (touser === 'openid-A') return { throw: { errCode: 43101, errMsg: 'send subscribe message fail: user refuse to accept the msg' } };
  if (touser === 'openid-B') return { throw: { errCode: -1, errMsg: 'request:fail timeout' } };
  if (touser === 'openid-C') return { ok: true };
  if (touser === 'openid-D') return { throw: { errCode: 43104, errMsg: 'invalid template_id' } };
  if (touser === 'openid-E') return { throw: { errMsg: 'errcode: 43101, user refuse to accept the msg' } };
  if (touser === 'openid-F') return { throw: { errcode: 43101, errMsg: 'user refuse to accept the msg' } };
  if (touser === 'openid-G') return { throw: { errCode: '43101', errMsg: 'user refuse to accept the msg' } };
  return { ok: true };
}

const fakeCloud = {
  init() {}, DYNAMIC_CURRENT_ENV: 'test',
  database() { return { collection: (n) => col(n), command: CMD }; },
  getWXContext() { return { OPENID: '', ENV: 'test', APPID: 'test' }; },
  openapi: {
    security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) },
    subscribeMessage: {
      send: async (args) => {
        sendLog.push(args); // 存整个 args：断言需要按 templateId 分流统计
        const b = behaviorFor(args);
        if (b.throw) throw b.throw;
        return { errCode: 0 };
      }
    }
  },
  callFunction: async () => ({ result: { code: 1, message: 'not used' } })
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') return fakeCloud;
  return origLoad.apply(this, arguments);
};
// ★ 必须**设上**而不是删掉：删掉会让 pushPriceAlert 在 guard 处直接 return，
//   于是它的 43101 分支永远不会被执行（这正是 2026-10-09 复核发现的覆盖真空）。
process.env.PRICE_ALERT_TEMPLATE_ID = PRICE_TMPL;
delete process.env.LLM_API_KEY;
process.env.SUBSCRIBE_TEMPLATE_ID = BRIEFING_TMPL; // 使订阅下发路径真正被走

const GB = require(path.join('D:\\Agent', 'cloudfunctions', 'getBriefing', 'index.js'));

// ------------------------------------------------------------------- 断言工具
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + name + (detail ? '  :: ' + detail : '')); }
  else { fail += 1; console.log('FAIL  ' + name + '  :: ' + detail); }
}

(async () => {
  global.__logLines = [];
  const origLog = console.log, origWarn = console.warn, origError = console.error;
  // 注意：汇总日志与"user failed"走的是 console.error（失败/跳过时升级为高等级），
  // 所以 error 也必须一起拦，否则断言 11 会假失败 —— 这是测试脚本自己的坑，不是产品问题。
  console.log = (...a) => global.__logLines.push('LOG ' + a.join(' '));
  console.warn = (...a) => global.__logLines.push('WARN ' + a.join(' '));
  console.error = (...a) => global.__logLines.push('ERROR ' + a.join(' '));

  const summary = await GB.scheduled();

  console.log = origLog; console.warn = origWarn; console.error = origError;

  const flagOf = (id) => col('users').docs.get(id).subscribeAccepted;
  const briefingSends = sendLog.filter((a) => a.templateId === BRIEFING_TMPL);
  const priceSends = sendLog.filter((a) => a.templateId === PRICE_TMPL);
  const priceSendsForH = priceSends.filter((a) => a.touser === 'openid-H');

  console.log('=== summary ===');
  console.log(JSON.stringify(summary));
  console.log('=== 晨报下发顺序 ===');
  console.log(JSON.stringify(briefingSends.map((a) => a.touser)));
  console.log('=== 降价提醒下发顺序 ===');
  console.log(JSON.stringify(priceSends.map((a) => a.touser)));
  console.log('=== 汇总日志行 ===');
  const line = (global.__logLines || []).find((l) => l.includes('[getBriefing.scheduled] total='));
  console.log(line || '(未找到汇总日志)');
  console.log('=== 断言 ===');

  check('1 覆盖全部 8 个用户', summary.total === 8, 'total=' + summary.total);
  check('2 43101 单独计数 = 4（errCode / errcode / 字符串码 / 仅 errMsg 四种形态都被识别）',
    summary.unsubscribed === 4, 'unsubscribed=' + summary.unsubscribed);
  check('3 真故障仍计入 failed = 2（网络错 + 43104）', summary.failed === 2, 'failed=' + summary.failed);
  check('4 晨报已生成的用户计入 ok = 6（含四个 43101 —— 下发失败不等于生成失败）', summary.ok === 6, 'ok=' + summary.ok);
  check('5 A 的 subscribeAccepted 被写回 false', flagOf('u1') === false, 'u1=' + flagOf('u1'));
  check('6 E 的 subscribeAccepted 被写回 false（errMsg 形态同一处理）', flagOf('u5') === false, 'u5=' + flagOf('u5'));
  check('7 真故障用户 B 的 subscribeAccepted 保持不变（不误改授权标记）', flagOf('u2') === true, 'u2=' + flagOf('u2'));
  check('8 负对照 43104 不算 unsubscribed（识别面未扩大）', summary.unsubscribed === 4 && flagOf('u4') === true, 'u4=' + flagOf('u4'));
  check('9 每个用户只下发一次晨报（43101 不做无谓重试）',
    briefingSends.length === 8 && new Set(briefingSends.map((a) => a.touser)).size === 8, 'calls=' + briefingSends.length);
  check('10 成功用户 C 未受影响', flagOf('u3') === true, 'u3=' + flagOf('u3'));
  check('11 汇总日志含 unsubscribed 字段（可观测）', !!(line && /unsubscribed=4/.test(line)), line ? 'ok' : '无日志行');
  // ---- 以下为 2026-10-09 补，用于堵住独立复核发现的两处覆盖真空 ----
  check('12 F 的标记被写回 false（小写 errcode 键形态）', flagOf('u6') === false, 'u6=' + flagOf('u6'));
  check('13 G 的标记被写回 false（errCode 为字符串 "43101" 的形态）', flagOf('u7') === false, 'u7=' + flagOf('u7'));
  check('14 降价提醒路径确实被执行到（反假绿守卫）', priceSends.length > 0,
    'priceSends=' + priceSends.length + '（若为 0 则下面两条是空断言）');
  check('15 降价提醒遇 43101 只尝试 1 次就停（break 生效）', priceSendsForH.length === 1,
    'openid-H 尝试次数=' + priceSendsForH.length + '（应为 1；若为 2 说明 break 失效）');
  check('16 降价提醒不改用户的 subscribeAccepted（与晨报模板授权互相独立）', flagOf('u8') === true, 'u8=' + flagOf('u8'));
  check('17 降价提醒的跳过有日志可观测',
    (global.__logLines || []).some((l) => l.includes('price alert skipped: user unsubscribed')),
    'warn 行数=' + (global.__logLines || []).filter((l) => l.includes('price alert skipped')).length);

  console.log('\n######## 通过 ' + pass + ' / 失败 ' + fail + ' ########');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS FATAL:', (e && e.stack) || e);
  process.exit(1);
});
