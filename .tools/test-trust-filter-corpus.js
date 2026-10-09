// 防过度修复：对**线上真实语料**跑过滤器，确认不误杀。
// 单测里的「正常新闻」是我自己挑的，可能挑得偏乐观；
// 真实语料有 20 个源、措辞千奇百怪，才是判据。
const Module = require('module');
const origLoad = Module._load;
function anyStub() {
  const fn = function () {
    return fn;
  };
  return new Proxy(fn, { get: () => anyStub(), apply: () => anyStub(), construct: () => anyStub() });
}
Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    return { DYNAMIC_CURRENT_ENV: 'test', init: () => {}, database: () => anyStub(), getWXContext: () => anyStub() };
  }
  return origLoad.apply(this, arguments);
};

const fs = require('fs');
const { assessNewsItem, filterNewsItems } = require('../cloudfunctions/webSearch/index.js').__internals;

const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8');
const parsed = JSON.parse(raw);
const items = Array.isArray(parsed) ? parsed : parsed.items || [];

console.log('真实语料：' + items.length + ' 条，updatedAt=' + (parsed.updatedAt || 'n/a'));

const dropped = [];
for (const it of items) {
  const r = assessNewsItem(it);
  if (r) dropped.push({ source: it.source, title: String(it.title || '').slice(0, 70), reason: r });
}

console.log('命中过滤：' + dropped.length + ' 条');
if (dropped.length) {
  console.log('--- 逐条（这些是误杀候选，必须逐个看过再决定是收窄规则还是确属毒条目）---');
  dropped.forEach((d, i) => console.log(`${i + 1}. [${d.source}] (${d.reason}) ${d.title}`));
}

// 整批过一遍，确认护栏与 kept 行为
const r = filterNewsItems(items);
console.log(`filterNewsItems → kept=${r.kept.length} dropped=${r.dropped.length}`);

const verdict = dropped.length === 0 ? 'PASS 真实语料零误杀' : 'REVIEW 存在误杀候选，需人工逐条确认';
console.log('\n' + verdict);
process.exit(dropped.length === 0 ? 0 : 2);
