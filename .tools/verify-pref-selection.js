// 偏好「选集合」验证 —— 扩池（HOTSPOT_POOL_SIZE）后，偏好必须改变**集合**而不只是顺序。
//
// 背景（2026-10-23 实测）：
//   37 个源、供给里科学 32.1% / 文化 20.3% / 健康 6.4%，但缓存前按 10 条截断，
//   最终 10 条里科学 1、文化 1、健康 0 —— 偏好只拿到「已截断集合内」的重排权，形同虚设。
//
// 本脚本用**冻结的真实池夹具**（.tools/fixtures/pref-pool.json，来自一次真实 fetchAllSources）
// 钉住下面这些性质，避免网络抖动导致 CI 不稳定：
//   1) 无偏好/非法偏好 → 纯时间倒序，取前 10（口径不变）；
//   2) prefs=['科学'] → 科学 ≥ 3 且首条为科学；
//   3) prefs=['健康'] → 健康 ≥ 1（改动前恒为 0）；
//   4) 老缓存只有 10 条也能跑，不抛错、不重复；
//   5) 任何场景都尊重单源上限 MAX_ITEMS_PER_SOURCE=3。
//
// 断言全部要求 `=== true`：失败分支若返回非空字符串会被 truthy 判成 PASS（本项目踩过）。
const Module = require('module');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = require(path.join(ROOT, '.tools', 'fixtures', 'pref-pool.json'));

// 冻结的缓存文档：模拟「已扩池」的线上缓存（60 条），供 action=hotspot 端到端断言
// —— 出口必须仍是 10 条，不能因为扩池让资讯库突然变 60 条。
const CACHED_DOC = {
  key: 'hotspot',
  items: FIXTURE,
  sourceHealth: [],
  softItems: [],
  updateTime: new Date().toISOString()
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    const collection = () => ({
      doc: () => ({
        get: async () => ({ data: CACHED_DOC }),
        set: async () => ({ stats: { created: 1 } })
      }),
      where: () => ({
        orderBy: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) })
      })
    });
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database: () => ({ collection }),
      getWXContext: () => ({ OPENID: 'test' })
    };
  }
  return origLoad.apply(this, arguments);
};

const ws = require(path.join(ROOT, 'cloudfunctions', 'webSearch', 'index.js'));
const { selectForUser } = ws.__internals;

const LIMIT = 10;
const MAX_PER_SOURCE = 3; // 与 cloudfunctions/webSearch/index.js 的 MAX_ITEMS_PER_SOURCE 保持一致

let pass = 0;
let fail = 0;
function check(name, fn) {
  let cond;
  let err;
  try {
    cond = fn();
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  if (cond === true) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name + (err ? '  →  throw: ' + err : ''));
  }
}

const tagOf = (it) => ((it && Array.isArray(it.tags) && it.tags[0]) || '其他');
const countTag = (list, tag) => list.filter((it) => tagOf(it) === tag).length;
const idsOf = (list) => list.map((it) => it && it.id).join('|');
const isTsDesc = (list) =>
  list.every((it, i) => i === 0 || Date.parse(list[i - 1].createTime) >= Date.parse(it.createTime));
const maxPerSource = (list) => {
  const m = new Map();
  for (const it of list) m.set(it.source, (m.get(it.source) || 0) + 1);
  return Math.max(0, ...m.values());
};
const uniqueIds = (list) => new Set(list.map((it) => it.id)).size === list.length;
const tsSorted = (list) => list.slice().sort((a, b) => Date.parse(b.createTime) - Date.parse(a.createTime));

const noPref = selectForUser(FIXTURE, undefined, LIMIT);

/* ---------- 1. 无偏好 / 非法偏好：退化为时间倒序 ---------- */
check('无偏好(undefined) 返回 10 条', () => (noPref.length === LIMIT ? true : 'got ' + noPref.length));
check('无偏好输出严格时间倒序', () => (isTsDesc(noPref) ? true : 'order broken'));
check('无偏好 = 全池时间倒序前 10 条', () =>
  idsOf(noPref) === idsOf(tsSorted(FIXTURE).slice(0, LIMIT)) ? true : 'set/order mismatch'
);
check('空数组偏好与 undefined 同结果', () =>
  idsOf(selectForUser(FIXTURE, [], LIMIT)) === idsOf(noPref) ? true : 'mismatch'
);
check('非数组偏好(字符串)不报错且退化为时间倒序', () => {
  const out = selectForUser(FIXTURE, '科学', LIMIT);
  return idsOf(out) === idsOf(noPref) ? true : 'mismatch';
});
check('未知偏好 tag 退化为时间倒序', () => {
  const out = selectForUser(FIXTURE, ['不存在的偏好'], LIMIT);
  return idsOf(out) === idsOf(noPref) ? true : 'mismatch';
});

/* ---------- 2. 缓存池宽度：必须显著大于出口条数，否则偏好改不了集合 ---------- */
const POOL_SIZE = ws.HOTSPOT_POOL_SIZE;
const POOL_LIMIT = ws.HOTSPOT_ITEMS_LIMIT;

check('缓存池宽度 >= 出口条数的 3 倍', () =>
  POOL_SIZE >= POOL_LIMIT * 3 ? true : 'pool=' + POOL_SIZE + ' limit=' + POOL_LIMIT
);
check('按配置池宽截取后，prefs=[科学] 仍能选到 >=3 条', () => {
  const pool = FIXTURE.slice(0, POOL_SIZE); // 夹具本身是真实缓存池的 ts 倒序，截断即模拟实际缓存宽度
  const n = countTag(selectForUser(pool, ['科学'], POOL_LIMIT), '科学');
  return n >= 3 ? true : 'only ' + n + ' (pool=' + pool.length + ')';
});

/* ---------- 3. prefs=['科学']：集合必须变 ---------- */
const sci = selectForUser(FIXTURE, ['科学'], LIMIT);
check("prefs=['科学'] 返回 10 条", () => (sci.length === LIMIT ? true : 'got ' + sci.length));
check("prefs=['科学'] 科学条数 >= 3", () => {
  const n = countTag(sci, '科学');
  return n >= 3 ? true : 'only ' + n;
});
check("prefs=['科学'] 首条 tag 为科学", () => (tagOf(sci[0]) === '科学' ? true : 'first=' + tagOf(sci[0])));
check("prefs=['科学'] 偏好条目全部排在非偏好之前", () => {
  const firstNonPref = sci.findIndex((it) => tagOf(it) !== '科学');
  if (firstNonPref === -1) return true;
  return sci.slice(firstNonPref).every((it) => tagOf(it) !== '科学') ? true : 'pref interleaved';
});
check("prefs=['科学'] 仍保留广度（非偏好 tag 至少 4 个）", () => {
  const tags = new Set(sci.filter((it) => tagOf(it) !== '科学').map(tagOf));
  return tags.size >= 4 ? true : 'breadth=' + tags.size;
});

/* ---------- 3. prefs=['健康']：改动前恒为 0 ---------- */
const health = selectForUser(FIXTURE, ['健康'], LIMIT);
check("prefs=['健康'] 健康条数 >= 1", () => {
  const n = countTag(health, '健康');
  return n >= 1 ? true : 'only ' + n;
});
check("prefs=['健康'] 首条 tag 为健康", () => (tagOf(health[0]) === '健康' ? true : 'first=' + tagOf(health[0])));

/* ---------- 4. 多偏好 ---------- */
const two = selectForUser(FIXTURE, ['科学', '文化'], LIMIT);
check("prefs=['科学','文化'] 两个偏好都 >= 3 条", () => {
  const a = countTag(two, '科学');
  const b = countTag(two, '文化');
  return a >= 3 && b >= 3 ? true : 'science=' + a + ' culture=' + b;
});

/* ---------- 5. 退化与老缓存兼容 ---------- */
check('空池返回 []', () => {
  const out = selectForUser([], ['科学'], LIMIT);
  return Array.isArray(out) && out.length === 0 ? true : 'got ' + JSON.stringify(out);
});
check('老缓存仅 10 条时不报错且仍返回 10 条', () => {
  const out = selectForUser(FIXTURE.slice(0, 10), ['科学'], LIMIT);
  return out.length === LIMIT ? true : 'got ' + out.length;
});
check('老缓存仅 10 条时无重复 id', () => {
  const out = selectForUser(FIXTURE.slice(0, 10), ['科学'], LIMIT);
  return uniqueIds(out) ? true : 'duplicate id';
});

/* ---------- 6. 不变量：单源上限 / 去重 / 确定性 ---------- */
const cases = [noPref, sci, health, two];
check('所有场景单源条数 <= 3', () => (cases.every((l) => maxPerSource(l) <= MAX_PER_SOURCE) ? true : 'cap violated'));
check('所有场景无重复 id', () => (cases.every((l) => uniqueIds(l)) ? true : 'duplicate id'));
check('同一输入两次调用结果一致（确定性）', () => {
  const a = idsOf(selectForUser(FIXTURE, ['科学'], LIMIT));
  const b = idsOf(selectForUser(FIXTURE, ['科学'], LIMIT));
  return a === b ? true : 'unstable';
});

/* ---------- 7. 出口回归：action=hotspot 仍必须是 10 条、时间倒序 ---------- */
(async () => {
  let hotspot = null;
  let hotspotErr = '';
  try {
    hotspot = await ws.main({ action: 'hotspot' });
  } catch (e) {
    hotspotErr = e && e.message ? e.message : String(e);
  }
  check('action=hotspot 调用不抛错', () => (hotspotErr ? hotspotErr : true));
  check('action=hotspot 对外仍是 10 条（扩池不外溢）', () =>
    Array.isArray(hotspot && hotspot.data) && hotspot.data.length === LIMIT
      ? true
      : 'got ' + (hotspot && hotspot.data ? hotspot.data.length : '(no data)')
  );
  check('action=hotspot 输出时间倒序', () =>
    Array.isArray(hotspot && hotspot.data) && isTsDesc(hotspot.data) ? true : 'order broken'
  );

  /* 多样性：扩池后出口若直接 slice(0,10)，高产源会连占 3 席（单源上限 3），
     十家媒体的观感塌成三家 —— 「今日热点」的广度价值就没了。
     出口必须走 pickDiverseHotspot：每源最多 1 条。（2026-10-23 补） */
  const srcs = Array.isArray(hotspot && hotspot.data) ? hotspot.data.map((x) => x.source) : [];
  check('action=hotspot 每源最多 1 条', () => (new Set(srcs).size === srcs.length ? true : 'dup source: ' + srcs.join(',')));
  check('action=hotspot 10 条来自 10 个不同源', () =>
    srcs.length === LIMIT && new Set(srcs).size === LIMIT ? true : 'unique=' + new Set(srcs).size + '/' + srcs.length
  );

  /* 兜底：不同源不足 total 时必须允许同源补足，不能返回短页面 */
  const fewSources = [
    { source: 'A', title: 'a1', createTime: '2026-10-23T03:00:00.000Z' },
    { source: 'A', title: 'a2', createTime: '2026-10-23T02:00:00.000Z' },
    { source: 'B', title: 'b1', createTime: '2026-10-23T01:00:00.000Z' }
  ];
  const filled = ws.__internals.pickDiverseHotspot(fewSources, LIMIT);
  check('源不足时同源补足到 target', () => (filled.length === 3 ? true : 'got ' + filled.length));
  check('源不足时仍优先每源各 1 条', () =>
    filled[0].source === 'A' && filled[1].source === 'B' ? true : filled.map((x) => x.source).join(',')
  );
  check('空入参返回空数组', () => (ws.__internals.pickDiverseHotspot(null, LIMIT).length === 0 ? true : 'not empty'));

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exit(1);
})();
