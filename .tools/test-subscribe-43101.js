// =============================================================================
// getBriefing 定时任务：订阅消息 43101（用户侧已不可达）单独处理的断言套件
//
// 测的是**真实 runScheduled()**（exports.scheduled），只 stub 掉 wx-server-sdk 的
// 数据库与 openapi。核心要证明三件事，缺一不可：
//   ① 43101 被单独计数（不算 failed、不算成"没发出去就整人失败"），且写回授权标记；
//   ② 真故障（网络错、模板参数错 43104）**仍然**算 failed、**不改**授权标记；
//   ③ 不会把识别面扩大到别的错误码（负对照）—— 只认 43101，否则就是"改宽了"的隐患。
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
  { _id: 'u1', openid: 'openid-A', subscribeAccepted: true, briefingTime: '07:30' }, // errCode 43101
  { _id: 'u2', openid: 'openid-B', subscribeAccepted: true, briefingTime: '07:30' }, // 网络真故障
  { _id: 'u3', openid: 'openid-C', subscribeAccepted: true, briefingTime: '07:30' }, // 正常成功
  { _id: 'u4', openid: 'openid-D', subscribeAccepted: true, briefingTime: '07:30' }, // 43104（负对照）
  { _id: 'u5', openid: 'openid-E', subscribeAccepted: true, briefingTime: '07:30' }  // 只给 errMsg 的 43101
];
col('users').docs.set('u1', Object.assign({}, USERS[0]));
col('users').docs.set('u2', Object.assign({}, USERS[1]));
col('users').docs.set('u3', Object.assign({}, USERS[2]));
col('users').docs.set('u4', Object.assign({}, USERS[3]));
col('users').docs.set('u5', Object.assign({}, USERS[4]));

const sendLog = [];
function behaviorFor(openid) {
  if (openid === 'openid-A') return { throw: { errCode: 43101, errMsg: 'send subscribe message fail: user refuse to accept the msg' } };
  if (openid === 'openid-B') return { throw: { errCode: -1, errMsg: 'request:fail timeout' } };
  if (openid === 'openid-C') return { ok: true };
  if (openid === 'openid-D') return { throw: { errCode: 43104, errMsg: 'invalid template_id' } };
  if (openid === 'openid-E') return { throw: { errMsg: 'errcode: 43101, user refuse to accept the msg' } };
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
        sendLog.push(args.touser);
        const b = behaviorFor(args.touser);
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
delete process.env.PRICE_ALERT_TEMPLATE_ID;   // 让 pushPriceAlert 直接跳过
delete process.env.LLM_API_KEY;
process.env.SUBSCRIBE_TEMPLATE_ID = 'TMPL_TEST'; // 使订阅下发路径真正被走

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

  console.log('=== summary ===');
  console.log(JSON.stringify(summary));
  console.log('=== 下发调用顺序 ===');
  console.log(JSON.stringify(sendLog));
  console.log('=== 汇总日志行 ===');
  const line = (global.__logLines || []).find((l) => l.includes('[getBriefing.scheduled] total='));
  console.log(line || '(未找到汇总日志)');
  console.log('=== 断言 ===');

  check('1 覆盖全部 5 个用户', summary.total === 5, 'total=' + summary.total);
  check('2 43101 单独计数 = 2（errCode 与仅 errMsg 两种形态都被识别）', summary.unsubscribed === 2, 'unsubscribed=' + summary.unsubscribed);
  check('3 真故障仍计入 failed = 2（网络错 + 43104）', summary.failed === 2, 'failed=' + summary.failed);
  check('4 晨报已生成的用户计入 ok = 3（含两个 43101 —— 下发失败不等于生成失败）', summary.ok === 3, 'ok=' + summary.ok);
  check('5 A 的 subscribeAccepted 被写回 false', col('users').docs.get('u1').subscribeAccepted === false, 'u1=' + col('users').docs.get('u1').subscribeAccepted);
  check('6 E 的 subscribeAccepted 被写回 false（errMsg 形态同一处理）', col('users').docs.get('u5').subscribeAccepted === false, 'u5=' + col('users').docs.get('u5').subscribeAccepted);
  check('7 真故障用户 B 的 subscribeAccepted 保持不变（不误改授权标记）', col('users').docs.get('u2').subscribeAccepted === true, 'u2=' + col('users').docs.get('u2').subscribeAccepted);
  check('8 负对照 43104 不算 unsubscribed（识别面未扩大）', summary.unsubscribed === 2 && col('users').docs.get('u4').subscribeAccepted === true, 'u4=' + col('users').docs.get('u4').subscribeAccepted);
  check('9 每个用户只下发一次（43101 不做无谓重试）', sendLog.length === 5 && new Set(sendLog).size === 5, 'calls=' + sendLog.length);
  check('10 成功用户 C 未受影响', col('users').docs.get('u3').subscribeAccepted === true, 'u3=' + col('users').docs.get('u3').subscribeAccepted);
  check('11 汇总日志含 unsubscribed 字段（可观测）', !!(line && /unsubscribed=2/.test(line)), line ? 'ok' : '无日志行');

  console.log('\n######## 通过 ' + pass + ' / 失败 ' + fail + ' ########');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS FATAL:', (e && e.stack) || e);
  process.exit(1);
});
