#!/usr/bin/env node
/**
 * verify-account-isolation.mjs —— 缺陷 B1 回归（换账号数据串号 / 隐私）。
 *
 * 复现（修复前的真实路径）：
 *   A 登录 → 写入 ledgerEntries/collectionStore/sportRuns → 退出（只清登录键）
 *   → B 登录 → initCloudSync 的「先拉后推」把本机残留的 A 数据推入 B 的 user_kv。
 *
 * 本脚本用 esbuild 编译 **src/services/cloudSync.ts**，把 cloudAuth / cloudDb 换成
 * 忠实复刻（按 owner 隔离的 user_kv），在隔离 vm 里跑完整登录/登出/换账号流程：
 *   1. A 写入并推送 → A 的 user_kv 有数据；
 *   2. 登出 → B 登录：断言 B 的 user_kv **没有任何 A 的 key**，本机旧数据被移入
 *      pii-quarantine-A，且 owner 标记变成 B；
 *   3. 切回 A：断言 A 本机数据恢复、能看到自己的数据；
 *   4. 归属不一致且未隔离时 push 直接 abort（B 的 user_kv 不被污染）；
 *   5. 推送请求飞行期间账号被切换 → 不写本地确认记录（after-check 生效）。
 *
 * 用法: node .tools/verify-account-isolation.mjs
 * 退出码: 0 = 全绿；1 = 断言失败；2 = harness 自身出错
 */
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const STUBS = path.join(ROOT, '.tools', 'stubs');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
function assert(name, cond) {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${String(cond)}`);
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}
function section(title) {
  console.log(`\n── ${title} ──`);
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function loadCloudSync() {
  const stubPlugin = {
    name: 'stub-cloud-deps',
    setup(build) {
      build.onResolve({ filter: /^\.\/cloudAuth$/ }, () => ({ path: path.join(STUBS, 'stub-cloud-auth.cjs') }));
      build.onResolve({ filter: /^\.\/cloudDb$/ }, () => ({ path: path.join(STUBS, 'stub-cloud-db.cjs') }));
    }
  };
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/services/cloudSync.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    alias: { '@tarojs/taro': path.join(STUBS, 'stub-taro-storage.cjs'), '@': path.join(ROOT, 'src') },
    define: { 'process.env.TARO_ENV': JSON.stringify('h5') },
    plugins: [stubPlugin],
    logLevel: 'silent'
  });

  const store = new Map();
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Promise,
    JSON,
    Math,
    AbortController,
    __STORE__: store,
    window: {
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear()
      },
      addEventListener: () => {}
    },
    document: { visibilityState: 'visible' }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: 'src/services/cloudSync.ts' });
  return { mod: sandbox.module.exports, sandbox, store };
}

function localValue(store, key) {
  const raw = store.get(key);
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && 'data' in o ? o.data : o;
  } catch {
    return undefined;
  }
}
function taroWrite(store, key, value) {
  store.set(key, JSON.stringify({ data: value }));
  return value;
}

const { mod, sandbox, store } = await loadCloudSync();
// 注意：esbuild 把 stub 内联进 vm，监听器集合挂在 **sandbox** 的 globalThis 上。
// 这里直接操作沙箱状态（不能用 Node require 的 stub —— 那是另一个 realm，状态不共享）。
function setSession(uid) {
  sandbox.__CLOUD_SESSION__ = uid ? { user: { id: uid } } : null;
  const listeners = sandbox.__AUTH_LISTENERS__;
  if (listeners) {
    for (const cb of [...listeners]) {
      try {
        cb(sandbox.__CLOUD_SESSION__);
      } catch {}
    }
  }
}
const DB = sandbox.__CLOUD_DB__;
const OWNER = 'cloud-sync-owner';
const A_DATA = [
  { id: 'a-ledger-1', amount: 12.5, categoryId: 'food' },
  { id: 'a-ledger-2', amount: 30, categoryId: 'traffic' }
];
const A_COLLECTIONS = [{ id: 'a-col-1', title: 'A 的收藏' }];
const A_RUNS = [{ id: 'a-run-1', km: 5, at: '2026-11-04' }];

/* 1. A 登录并写数据、推送 */
section('1. A 登录写数据 → 推送到 A 的 user_kv');
sandbox.__CLOUD_SESSION__ = { user: { id: 'A' } };
await mod.initCloudSync();
taroWrite(store, 'ledgerEntries', A_DATA);
taroWrite(store, 'collectionStore', A_COLLECTIONS);
taroWrite(store, 'sportRuns', A_RUNS);
await mod.syncNow();
await tick(10);
const aRows = Object.keys(DB.rows.A || {});
assert('harness 前提：A 的 user_kv 收到 3 个 key', aRows.length === 3);
assert('A 的 ledgerEntries 已上云', JSON.stringify(DB.rows.A.ledgerEntries.value) === JSON.stringify(A_DATA));

/* 2. 登出 → B 登录 */
section('2. 登出后 B 登录：B 的 user_kv 不得出现 A 的任何 key');
setSession(null); // 登出：cloudSync 只解绑 owner，不应删数据
await tick(10);
assert('登出后本机 A 数据仍在（再次登录 A 能看到自己的数据）', Array.isArray(localValue(store, 'ledgerEntries')));

setSession('B');
await tick(60); // 等 pullRemote().then(pushNow) 走完

const bRows = Object.keys(DB.rows.B || {});
assert('B 的 user_kv 没有任何 key', bRows.length === 0);
assert(
  'B 的 user_kv 不含 A 的 ledgerEntries/collectionStore/sportRuns',
  !bRows.includes('ledgerEntries') && !bRows.includes('collectionStore') && !bRows.includes('sportRuns')
);
assert('本机旧业务键已移出（ledgerEntries 不再留在当前命名空间）', localValue(store, 'ledgerEntries') === undefined);
assert('隔离区 pii-quarantine-A 存在', !!store.get('pii-quarantine-A'));
const quarantine = JSON.parse(store.get('pii-quarantine-A') || '{}');
assert('隔离区保存了 A 的 ledgerEntries 原值', JSON.stringify(JSON.parse(quarantine.ledgerEntries).data) === JSON.stringify(A_DATA));
assert('owner 标记已切到 B', JSON.parse(store.get(OWNER)).owner === 'B');
assert('换账号提示已落库（UI 可显示）', !!JSON.parse(store.get('cloud-sync-owner-notice') || 'null'));
assert('换账号提示来自 A → 去向 B', JSON.parse(store.get('cloud-sync-owner-notice')).from === 'A');

/* 3. 切回 A */
section('3. 切回 A：能看到自己的数据');
setSession('A');
await tick(60);
assert('A 的 ledgerEntries 已回到本机', JSON.stringify(localValue(store, 'ledgerEntries')) === JSON.stringify(A_DATA));
assert('A 的 collectionStore 已回到本机', JSON.stringify(localValue(store, 'collectionStore')) === JSON.stringify(A_COLLECTIONS));
assert('A 的 sportRuns 已回到本机', JSON.stringify(localValue(store, 'sportRuns')) === JSON.stringify(A_RUNS));
assert('A 的隔离区已被消费（不残留重复归档）', !store.get('pii-quarantine-A'));
assert('owner 标记回到 A', JSON.parse(store.get(OWNER)).owner === 'A');

/* 4. 归属不一致且未隔离 → push abort */
section('4. 归属不一致（未隔离）→ push 前直接 abort');
sandbox.__CLOUD_SESSION__ = { user: { id: 'B' } };
store.set(OWNER, JSON.stringify({ owner: 'A', at: Date.now() }));
taroWrite(store, 'hotspot-disabled-sources', ['某来源']);
const bBefore = Object.keys(DB.rows.B || {}).length;
await mod.syncNow();
await tick(10);
assert('B 的 user_kv 仍为空（push 前 owner 校验生效）', Object.keys(DB.rows.B || {}).length === bBefore);
assert('本机数据未被误删（交给 setSyncOwner 隔离）', Array.isArray(localValue(store, 'hotspot-disabled-sources')));

/* 5. 推送飞行期间账号被切换 → after-check 不写确认记录 */
section('5. 推送过程中账号切换 → 不写本地确认记录');
sandbox.__CLOUD_SESSION__ = { user: { id: 'A' } };
store.set(OWNER, JSON.stringify({ owner: 'A', at: Date.now() }));
taroWrite(store, 'intel-watchlist', ['关键词-1']);
const metaBefore = store.get('cloud-sync-meta:A');
sandbox.__KV_AFTER_WRITE__ = () => {
  // 模拟上传请求返回前账号被切走（不调用 setSyncOwner，专门测 after-check）
  sandbox.__CLOUD_SESSION__ = { user: { id: 'B' } };
};
await mod.syncNow();
await tick(10);
assert('账号切换后本地确认记录未被改写（after-check 生效）', store.get('cloud-sync-meta:A') === metaBefore);

/* 6. 单键 >512KB → 不发、不落确认、必须有可见提示（缺陷 X5） */
section('6. 单键超过 512KB：跳过上传但明确提示（不再静默丢弃）');
sandbox.__CLOUD_SESSION__ = { user: { id: 'A' } };
store.set(OWNER, JSON.stringify({ owner: 'A', at: Date.now() }));
store.delete('cloud-sync-oversize-notice');
store.delete('cloud-sync-oversize-toast-at');
const huge = { items: [{ title: 'x'.repeat(600000), url: 'https://example.com' }] };
taroWrite(store, 'browseHistory', huge);
taroWrite(store, 'newsFeedback', [{ id: 'fb-1' }]);
await mod.syncNow();
await tick(10);
assert('超限键没有上云（服务端不会再"静默丢弃"）', !('browseHistory' in (DB.rows.A || {})));
assert('同批正常键仍照常上云', !!DB.rows.A.newsFeedback);
const sizeNotice = mod.getSyncSizeNotice();
assert('超限提示已落库（UI 可见）', !!sizeNotice && sizeNotice.kind === 'oversize');
assert('提示列出 browseHistory 且字节数 > 524288',
  !!sizeNotice && sizeNotice.items.some((it) => it.key === 'browseHistory' && it.bytes > 524288));
const metaAfterA = JSON.parse(store.get('cloud-sync-meta:A') || '{}');
const confirmAfterA = JSON.parse(store.get('cloud-sync-confirm:A') || '{}');
assert('超限键未写 meta（保留重试空间）', metaAfterA.browseHistory === undefined);
assert('超限键未写 confirm（不会被误判为已同步）', confirmAfterA.browseHistory === undefined);

/* 7. 熔断必须有 UI 状态，且可手动重试（缺陷 X6） */
section('7. 连续 5 次云端硬失败 → 熔断状态可见、可重试');
sandbox.__CLOUD_SESSION__ = { user: { id: 'A' } };
store.set(OWNER, JSON.stringify({ owner: 'A', at: Date.now() }));
sandbox.__KV_FAIL__ = true;
let disabledEvents = 0;
let lastDisabled = false;
const unsubDisabled = mod.subscribeSyncDisabled((state) => { disabledEvents++; lastDisabled = state.disabled; });
for (let i = 0; i < 5; i++) await mod.syncNow();
assert('连续 5 次硬失败后进入熔断', mod.getSyncDisabledState().disabled === true);
assert('熔断状态带有失败次数与原因', mod.getSyncDisabledState().failures >= 5 && mod.getSyncDisabledState().reason.length > 0);
assert('订阅方收到熔断状态（UI 能渲染）', disabledEvents >= 2 && lastDisabled);
const callsAtFuse = DB.calls.length;
taroWrite(store, 'newsFeedback', [{ id: 'fb-2' }]);
await mod.syncNow();
assert('熔断期间不再打云端（轮询已停）', DB.calls.length === callsAtFuse);

sandbox.__KV_FAIL__ = false;
const ok = await mod.retrySync();
assert('云端恢复后手动重试成功', ok === true && mod.getSyncDisabledState().disabled === false);
taroWrite(store, 'newsFeedback', [{ id: 'fb-3' }]);
await mod.syncNow();
assert('重试后推送恢复（云端收到新写入）', DB.calls.length > callsAtFuse);

sandbox.__KV_FAIL__ = true;
const ok2 = await mod.retrySync();
assert('仍失败时重试如实返回 false 并保持熔断', ok2 === false && mod.getSyncDisabledState().disabled === true);
unsubDisabled();
sandbox.__KV_FAIL__ = false;

/* 8. 日历云端不落库（2026-11-04）：meta 遗留哨兵 1 + 云端已有 client_ts=1 的空壳时，
 *    本地写入必须抬时间戳、推送必须是真实毫秒且非空内容（否则服务端按「同 ts 判旧」写 0 行）。 */
section('8. dailyPlanStore：本地写入必须记真实时间戳，推送必须真正落库');
await mod.retrySync(); // 先解除上一节的熔断
sandbox.__CLOUD_SESSION__ = { user: { id: 'A' } };
store.set(OWNER, JSON.stringify({ owner: 'A', at: Date.now() }));
// 复现线上现状：云端已有一行 client_ts=1 的空壳（旧版本写的），本地 meta 也残留哨兵 1
DB.rows.A.dailyPlanStore = { key: 'dailyPlanStore', value: { events: [] }, clientTs: 1 };
const metaA = JSON.parse(store.get('cloud-sync-meta:A') || '{}');
metaA.dailyPlanStore = 1;
store.set('cloud-sync-meta:A', JSON.stringify(metaA));
const plan = {
  events: [{ id: 'evt-1', title: 'TEST-云端落库', startTime: '2026-11-04 09:00', status: 'confirmed' }],
  todos: []
};
// 走 Taro H5 的最终落点（与真机一致：Taro.setStorageSync → localStorage.setItem，信封格式）
sandbox.window.localStorage.setItem('dailyPlanStore', JSON.stringify({ data: plan }));
const metaAfterWrite = JSON.parse(store.get('cloud-sync-meta:A') || '{}');
assert('本地写入即抬时间戳（storage 钩子生效，meta 不再是哨兵 1）', metaAfterWrite.dailyPlanStore > 1e12);
// 再压回哨兵 1：覆盖「历史遗留 meta=1」的用户 —— 推送也必须用真实时刻，而不是继续发 1
metaA.dailyPlanStore = 1;
store.set('cloud-sync-meta:A', JSON.stringify(metaA));
await mod.syncNow();
await tick(10);
const row = (DB.rows.A || {}).dailyPlanStore;
assert('推送的 client_ts 是真实毫秒（不再是 1）', !!row && row.clientTs > 1e12);
assert(
  '云端行内容包含刚写入的日程（不是空壳）',
  !!row && Array.isArray(row.value.events) && row.value.events.length === 1 && row.value.events[0].title === 'TEST-云端落库'
);
const cMeta = JSON.parse(store.get('cloud-sync-meta:A') || '{}');
assert('推送确认后本地 meta 已被修复为真实毫秒', cMeta.dailyPlanStore > 1e12);

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
