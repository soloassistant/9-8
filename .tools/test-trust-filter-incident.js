// 回归用例：2026-10-08 真实投毒事件。
// 单测里的语料是我自己编的，可能挑得偏乐观；这个 fixture 是
// `qa-real-data/real-out.txt` 里**用户当时实际看到的**三条，逐一断言。
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

const fx = JSON.parse(fs.readFileSync('D:/Agent/.tools/fixtures/incident-2026-10-08-poisoned-feed.json', 'utf8'));
const items = fx.items;

let pass = 0,
  fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ' → ' + detail : ''}`);
  }
}

console.log('投毒源条目: ' + JSON.stringify(items[2]));

// ① 投毒那条必须被判 defaced
check('真实投毒载荷被判定为 defaced', assessNewsItem(items[2]) === 'defaced', String(assessNewsItem(items[2])));

// ② 两条正常条目必须放行（这条同等重要：过宽的规则会把当天 3 条情报砍成 1 条）
check('正常条目#1 放行', assessNewsItem(items[0]) === null, String(assessNewsItem(items[0])));
check('正常条目#2 放行', assessNewsItem(items[1]) === null, String(assessNewsItem(items[1])));

// ③ 整批过滤：正好拦掉投毒那条，另外两条完整保留
const r = filterNewsItems(items);
check('整批过滤后恰好剩 2 条', r.kept.length === 2, `kept=${r.kept.length}`);
check('整批过滤恰好拦掉 1 条', r.dropped.length === 1, `dropped=${r.dropped.length}`);
check('被拦的是量子位那条', r.dropped[0] && r.dropped[0].source === '量子位', JSON.stringify(r.dropped[0]));
check(
  '保留的两条来源未变',
  r.kept[0].source === 'InfoQ中文' && r.kept[1].source === '什么值得买',
  r.kept.map((k) => k.source).join(',')
);

// ④ 全毒场景：defaced 属高置信规则 → 必须 fail-closed 全部丢弃，护栏不得放行。
//    （旧断言把「单条全毒触发护栏 → 放行」固化成预期，等于把绕过缺陷写进了测试；已更正。）
const onlyPoison = [items[2]];
const r2 = filterNewsItems(onlyPoison);
check('单条全毒（1/1）→ 全部丢弃（fail-closed）', r2.kept.length === 0 && r2.dropped.length === 1, `kept=${r2.kept.length} dropped=${r2.dropped.length}`);

// ⑤ 唯一存活源被投毒：MAX_ITEMS_PER_SOURCE=3 → 列表塌缩成 3 条全毒 → 不得整体放行
const threePoison = [items[2], items[2], items[2]];
const r3 = filterNewsItems(threePoison);
check('3/3 全毒 → kept.length === 0（堵住唯一存活源绕过）', r3.kept.length === 0, `kept=${r3.kept.length}`);

// ⑥ 2 毒 + 1 正常：只剩正常那条，毒条目不得出现在结果里
const twoPoisonOneGood = [items[2], items[2], items[0]];
const r4 = filterNewsItems(twoPoisonOneGood);
check(
  '2 毒 + 1 正常 → 只剩 1 条正常且毒条目不在结果里',
  r4.kept.length === 1 && r4.kept[0] === items[0] && r4.kept.every((k) => k.title !== 'hacked by trenggalek6etar'),
  `kept=${r4.kept.length} titles=${r4.kept.map((k) => k.title).join(' | ')}`
);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
