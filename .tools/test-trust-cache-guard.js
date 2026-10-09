#!/usr/bin/env node
/**
 * test-trust-cache-guard.js
 *
 * 验证：内容信任过滤「全丢」时，不会把**空结果**写进 1 小时全局共享缓存 hotspotCache
 * （否则一次全量过滤会让热点页空一整个小时），并覆盖缺陷 A 的**零宽混淆**变体。
 *
 * 做法：用真实模块 + 忠实内存 DB（.doc(id).set 真 upsert / .limit 真截断 / .doc(id).get 不存在抛错）
 *      + 把全部 RSS 源都喂「零宽混淆毒 feed」（`hacked\u200Bby trenggalek6etar`）。
 *
 * 退出码：0 = 全 PASS
 */
'use strict';
const Module = require('module');
const https = require('https');
const EventEmitter = require('events');

const origLoad = Module._load;

let pass = 0,
  fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`);
  }
}

/* ---------------- 忠实内存 DB ---------------- */
const stores = {};
let autoId = 1;
const writes = { hotspotSet: 0 };
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
function matchWhere(doc, where) {
  if (!where) return true;
  return Object.keys(where).every((k) => doc[k] === where[k]);
}
function makeCollection(name) {
  const state = { where: null, orderBy: null, limit: null };
  const api = {
    where(f) { state.where = f; return api; },
    orderBy(f, d) { state.orderBy = { field: f, dir: d }; return api; },
    limit(n) { state.limit = n; return api; },
    async get() {
      let rows = (stores[name] || []).filter((d) => matchWhere(d, state.where));
      if (state.orderBy) {
        const { field, dir } = state.orderBy;
        rows = rows.slice().sort((a, b) => {
          const av = a[field], bv = b[field];
          const c = av < bv ? -1 : av > bv ? 1 : 0;
          return dir === 'desc' ? -c : c;
        });
      }
      if (typeof state.limit === 'number') rows = rows.slice(0, state.limit);
      return { data: clone(rows) };
    },
    async add({ data }) {
      const doc = { _id: name + '-auto-' + autoId++, ...clone(data) };
      (stores[name] = stores[name] || []).push(doc);
      return { _id: doc._id };
    },
    doc(id) {
      return {
        async get() {
          const d = (stores[name] || []).find((x) => x._id === id);
          if (!d) { const e = new Error('document not exists'); e.errCode = -1; throw e; }
          return { data: clone(d) };
        },
        async set({ data }) {
          const arr = (stores[name] = stores[name] || []);
          const i = arr.findIndex((x) => x._id === id);
          const doc = { _id: id, ...clone(data) };
          if (i >= 0) arr[i] = doc; else arr.push(doc);
          if (name === 'hotspotCache') writes.hotspotSet++; // 记账：空结果若写入即被抓到
          return { stats: { updated: i >= 0 ? 1 : 0, created: i < 0 ? 1 : 0 } };
        }
      };
    }
  };
  return api;
}
const dbStub = { collection: (name) => makeCollection(name) };

Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    return { init() {}, DYNAMIC_CURRENT_ENV: 'test', database: () => dbStub, getWXContext: () => ({ OPENID: 'test-openid' }) };
  }
  return origLoad.apply(this, arguments);
};

/* ---------------- https：全部 RSS 源返回「混淆毒 feed」 ---------------- */
// 混淆字符在三种变体间切换（零宽 / 软连字符 / 不可见分隔）——
// 前两者分别覆盖缺陷 A 与缺陷 C，用来证明**任一变体都不能把毒源写进全局缓存**。
const ZW = String.fromCharCode(0x200b);   // U+200B 零宽空格
const SHY = String.fromCharCode(0x00ad);  // U+00AD 软连字符
const INV = String.fromCharCode(0x2063);  // U+2063 不可见分隔符
let POISON_CHAR = ZW;
const makePoison = () => 'hacked' + POISON_CHAR + 'by trenggalek6etar';
function poisonRssXml() {
  const d = new Date().toUTCString();
  const poison = makePoison();
  const item = `<item><title>${poison}</title><link>https://ex.com/x</link><description></description><pubDate>${d}</pubDate></item>`;
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${item}${item}${item}</channel></rss>`;
}
function fakeResponse(code, body) {
  const res = new EventEmitter();
  res.statusCode = code; res.headers = {};
  res.setEncoding = () => {}; res.resume = () => {};
  process.nextTick(() => { res.emit('data', body); res.emit('end'); });
  return res;
}
function makeReq() {
  const req = new EventEmitter();
  req.write = () => {}; req.end = () => {};
  req.destroy = (e) => process.nextTick(() => req.emit('error', e || new Error('destroyed')));
  return req;
}
function hook() {
  return function (url, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const req = makeReq();
    if (cb) process.nextTick(() => cb(fakeResponse(200, poisonRssXml())));
    return req;
  };
}
https.get = hook();
https.request = hook();

/* ---------------- 载入真实模块 ---------------- */
const ws = require('D:/Agent/cloudfunctions/webSearch/index.js');
const { filterNewsItems, getHotspotNews } = ws.__internals;
const poisonItem = () => ({ title: makePoison(), summary: '', source: '量子位', tags: [] });

// 三种混淆变体：零宽空格（缺陷 A）/ 软连字符 + 不可见分隔（缺陷 C）
const POISON_VARIANTS = [
  ['零宽空格 U+200B', ZW],
  ['软连字符 U+00AD', SHY],
  ['不可见分隔 U+2063', INV]
];

(async () => {
  for (const [label, ch] of POISON_VARIANTS) {
    POISON_CHAR = ch;

    const r1 = filterNewsItems([poisonItem()]);
    ok(`[${label}] 混淆毒条 1/1 → kept.length===0`, r1.kept.length === 0, r1.kept.length);
    const r3 = filterNewsItems([poisonItem(), poisonItem(), poisonItem()]);
    ok(`[${label}] 混淆毒条 3/3 → kept.length===0（护栏不得放行）`, r3.kept.length === 0, r3.kept.length);

    // A：无旧缓存 + 全源投毒（含混淆）→ 过滤后 0 条
    writes.hotspotSet = 0;
    delete stores['hotspotCache'];
    let eA = null, rA = null;
    try { rA = await getHotspotNews(); } catch (e) { eA = e; }
    ok(`[${label}] 全毒 feed → 空结果未写入 hotspotCache`, writes.hotspotSet === 0, writes.hotspotSet);
    ok(`[${label}] 全毒 feed 无旧缓存 → 抛受控错误「所有 RSS 源抓取失败」`, eA && /所有 RSS 源抓取失败/.test(eA.message), eA && eA.message);

    // B：有旧缓存 → 降级复用旧缓存，仍不写空
    writes.hotspotSet = 0;
    stores['hotspotCache'] = [
      { _id: 'hotspot', key: 'hotspot', items: [{ title: '旧缓存正常条目', source: 'X' }], sourceHealth: [], updateTime: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }
    ];
    let eB = null, rB = null;
    try { rB = await getHotspotNews(); } catch (e) { eB = e; }
    ok(`[${label}] 有旧缓存 → 空结果未写入 hotspotCache`, writes.hotspotSet === 0, writes.hotspotSet);
    ok(`[${label}] 有旧缓存 → 降级复用旧缓存而非空白`, eB === null && rB && rB.items.length === 1 && rB.fromCache === true, eB && String(eB));
  }

  // C：真实入口 main(action='hotspot') 不抛未捕获异常（用零宽混淆变体，与缺陷 A 对齐）
  POISON_CHAR = ZW;
  writes.hotspotSet = 0;
  delete stores['hotspotCache'];
  let eC = null, rC = null;
  try { rC = await ws.main({ action: 'hotspot' }); } catch (e) { eC = e; }
  ok('main(action=hotspot) 不抛未捕获异常（返回受控 code）', eC === null && rC && rC.code === -1, eC && String(eC));

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
