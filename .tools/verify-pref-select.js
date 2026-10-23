#!/usr/bin/env node
/**
 * verify-pref-select.js —— H5 偏好选位回归闸门。
 *
 * 守的是「用户点了偏好，资讯真的会变」这件事：
 *   改前 H5 的 getBriefing 是 `hotspot.items.slice(0, 3)` —— 硬切前 3 条，
 *   「我的」页里选的科学/文化/健康**完全不参与**；而真正的选位在未部署的云函数里。
 *   于是出现"选项出现了、能点、但点了没有任何变化"的假功能。
 *
 * 本脚本**真执行** `src/utils/prefSelect.ts`（编译后跑真实数据夹具），并断言 cloud.ts 的接线。
 * 判据一律 `cond === true`（失败分支返回说明字符串时，`if (cond)` 会把失败判成 PASS）。
 *
 * 用法: node .tools/verify-pref-select.js
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
const out = ts.transpileModule(read('src/utils/prefSelect.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 }
}).outputText;
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('exports', 'require', 'module', '__filename', '__dirname', out)(
  mod.exports,
  (id) => {
    throw new Error('prefSelect 不应有静态依赖，却 require 了: ' + id);
  },
  mod,
  'src/utils/prefSelect.ts',
  ROOT
);
const { selectByPreference, itemTag, itemTs } = mod.exports;

/* ===================== 真实数据夹具 ===================== */

const raw = JSON.parse(read('.tools/fixtures/pref-pool.json'));
const POOL = Array.isArray(raw) ? raw : raw.items || [];
const tagOf = (it) => itemTag(it);
const sourceOf = (it) => it.source || '';

ok('夹具可用（60 条真实抓取）', POOL.length >= 50 && POOL.some((i) => tagOf(i) === '科学'));

/* ===================== 1. 无偏好：退化为时间倒序，不造假 ===================== */

const plain = selectByPreference(POOL, [], 10);
ok('无偏好 → 返回 limit 条', plain.length === 10);
const tsSorted = POOL.slice().sort((a, b) => itemTs(b) - itemTs(a));
ok(
  '无偏好 → 顺序等于全池时间倒序（不引入任何"偏好命中"假逻辑）',
  plain.every((it, i) => it === tsSorted[i])
);

// ⚠️ 上面这条在**夹具本身已按时间倒序存放**时是空转的：把 `sorted` 那行排序整个删掉，
//    输入顺序不变、结果也不变，断言照样绿。所以这里再用一份确定性打乱的池子复测一遍 ——
//    打乱后"删排序"会立刻让结果变成乱序，被抓到。
// 用固定种子的 LCG（不用 Math.random），保证每次运行输入相同、结论可复现。
function shuffled(arr) {
  const a = arr.slice();
  let seed = 20261023;
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}
const POOL_SHUFFLED = shuffled(POOL);
ok(
  '打乱池子后确实与原顺序不同（否则这条复测无意义）',
  POOL_SHUFFLED.some((it, i) => it !== POOL[i])
);
const plainShuffled = selectByPreference(POOL_SHUFFLED, [], 10);
ok(
  '无偏好 + 打乱输入 → 仍返回时间倒序前 10（抓住"删掉排序"这类变异）',
  plainShuffled.length === 10 && plainShuffled.every((it, i) => it === tsSorted[i])
);

/* ===================== 2. 有偏好：偏好条目确实靠前 ===================== */

const science = selectByPreference(POOL, ['科学'], 3);
ok('偏好「科学」→ 返回 3 条', science.length === 3);
ok('偏好「科学」→ 首条就是科学', tagOf(science[0]) === '科学');
// 预算 = min(minPerPref×命中数, max(1, limit-1)) = min(3, 2) = 2 → 2 席科学 + 1 席广度
ok(
  '偏好「科学」→ 偏好保底 2 席（limit-1）后由广度补足',
  science.filter((it) => tagOf(it) === '科学').length === 2
);
ok('偏好「科学」→ 第 3 席是广度（非科学）', tagOf(science[2]) !== '科学');

// 承接上面打乱池子的复测：选位结果必须与入参顺序无关。
// 这条同时是"广度补足/收尾排序"在乱序输入下的交叉校验。
const sciShuffled = selectByPreference(POOL_SHUFFLED, ['科学'], 3);
ok(
  '有偏好 + 打乱输入 → 结果与未打乱完全一致（选位不依赖入参顺序）',
  sciShuffled.length === 3 && sciShuffled.every((it, i) => it === science[i])
);

const two = selectByPreference(POOL, ['科学', '文化'], 3);
ok('两个偏好 → 两个偏好标签各至少 1 席', two.filter((i) => tagOf(i) === '科学').length >= 1 && two.filter((i) => tagOf(i) === '文化').length >= 1);
ok('两个偏好 → 仍受 limit 约束', two.length === 3);

// 偏好顺序影响的是**占席**，不是最终展示顺序（收尾排序是"偏好置前 + 时间倒序"，
// 与云端 selectForUser 一致）。预算紧时靠前的偏好先拿到席位：
//   limit=2 → budget=min(3×2, 1)=1，base=0、rest=1 → 第一个偏好拿 1 席，第二个 0 席。
const tight1 = selectByPreference(POOL, ['文化', '科学'], 2);
const tight2 = selectByPreference(POOL, ['科学', '文化'], 2);
ok(
  '预算紧张时靠前的偏好先占席',
  tight1.filter((i) => tagOf(i) === '文化').length === 1 &&
    tight1.filter((i) => tagOf(i) === '科学').length === 0 &&
    tight2.filter((i) => tagOf(i) === '科学').length === 1 &&
    tight2.filter((i) => tagOf(i) === '文化').length === 0
);
// 最终展示顺序：偏好条目必须排在非偏好条目之前（④ 收尾排序）
const mixed = selectByPreference(POOL, ['科学'], 5);
const firstNonPref = mixed.findIndex((i) => tagOf(i) !== '科学');
ok(
  '收尾排序：偏好条目排在非偏好条目之前',
  mixed.slice(0, firstNonPref === -1 ? mixed.length : firstNonPref).every((i) => tagOf(i) === '科学')
);

// 偏好标签池里没有货 → 不假装命中
const empty = selectByPreference(POOL, ['不存在的类目'], 3);
ok(
  '偏好标签在池里没货 → 退化为时间倒序（不造假命中）',
  empty.length === 3 && empty.every((it, i) => it === tsSorted[i])
);

/* ===================== 3. 多样性：同一来源最多 3 条 ===================== */

const manyFromOne = [];
for (let i = 0; i < 8; i += 1) {
  manyFromOne.push({
    title: 'same-source-' + i,
    source: '同源',
    tags: ['科学'],
    createTime: new Date(Date.UTC(2026, 9, 23, 12, 0, i)).toISOString()
  });
}
manyFromOne.push({ title: 'other', source: '别的源', tags: ['文化'], createTime: new Date(Date.UTC(2026, 9, 23, 13)).toISOString() });

const capped = selectByPreference(manyFromOne, ['科学'], 6);
const perSource = {};
for (const it of capped) perSource[sourceOf(it)] = (perSource[sourceOf(it)] || 0) + 1;
ok('同一来源最多 3 条（maxPerSource 生效）', (perSource['同源'] || 0) <= 3);

// 全池同源且超过单源配额：**多样性优先于填满**（与云端一致：宁可少一条，不让一个源连占）
const allSame = manyFromOne.filter((i) => sourceOf(i) === '同源');
const filled = selectByPreference(allSame, ['科学'], 4);
ok('单源超过配额时不硬凑满（多样性优先）', filled.length === 3);

/* ===================== 4. 边界 ===================== */

ok('空池 → 空数组', selectByPreference([], ['科学'], 3).length === 0);
ok('limit=0 → 空数组', selectByPreference(POOL, ['科学'], 0).length === 0);
ok('limit 大于池长 → 返回全池', selectByPreference(POOL, ['科学'], 9999).length === POOL.length);
ok('非数组入参不抛', selectByPreference(null, ['科学'], 3).length === 0);

const dedup = selectByPreference(POOL, ['科学', '科学', 42, null], 3);
ok('非字符串/重复偏好被清洗后行为一致', dedup.length === 3 && tagOf(dedup[0]) === '科学');

const noTags = selectByPreference(
  [
    { title: 'a', source: 's1', createTime: new Date(Date.UTC(2026, 9, 23, 10)).toISOString() },
    { title: 'b', source: 's2', createTime: new Date(Date.UTC(2026, 9, 23, 11)).toISOString() }
  ],
  ['科学'],
  2
);
ok('无 tags 的条目归入「其他」参与广度', noTags.length === 2);

/* ===================== 5. cloud.ts 接线（防"函数写好了但没人调"） ===================== */

const cloudSrc = read('src/services/cloud.ts');
// 剥注释：cloud.ts 里有一段**故意留着**的说明性注释提到 `hotspot.items.slice(0, 3)`，
// 不剥的话这条断言会被自己的文档判成违规（假 FAIL）。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cloud = stripComments(cloudSrc);
ok('getBriefing 走偏好选位', cloud.includes('selectByPreference(hotspot.items, prefs, 3)'));
ok('getHotspot 也按偏好重排', cloud.includes('selectByPreference(payload.items, prefs, payload.items.length)'));
ok(
  '不再有 slice(0, 3) 硬切（旧缺陷）',
  cloud.includes('hotspot.items.slice(0, 3)') === false
);
ok('偏好取自 user-settings（与「我的」页同一份）', cloud.includes("readProfileSettings().preferences"));

/* ===================== 汇总 ===================== */

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + `  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
