#!/usr/bin/env node
/**
 * verify-sync-pull.mjs —— SY-03 回归：打开态「先拉后推」与打开态刷新。
 *
 * 复现（修复前）：
 *   30 秒轮询只调 pushNow ⇒ 另一台设备删除后，本机已打开页面 65 秒仍不生效，刷新才拉到。
 *
 * 本脚本不直接调 pullNow —— 它**捕获 initCloudSync 注册的 setInterval 回调并手动触发一次**，
 * 这正是线上每 30 秒发生的事。因此把 pollTick 里的 pullRemote 删掉，本脚本必红。
 *
 * 断言：
 *   1. 定时器间隔 30s；触发一次 tick 后 B 本地同 key 变空、meta 对齐墓碑 ts、收到 apply 通知；
 *      A 端墓碑存在且 ts 与空数组行一致。
 *   2. B 本地有未推送改动 + 远端较新 → 不被静默覆盖，产生待裁决冲突。
 *   3. decideSyncRefresh：无关 key → ignore；命中非编辑 → refresh；编辑中 → defer。
 *
 * 用法: node .tools/verify-sync-pull.mjs
 * 退出码: 0 = 全绿；1 = 断言失败；2 = harness 自身出错
 */
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const STUBS = path.join(ROOT, '.tools', 'stubs');
const require = createRequire(import.meta.url);
const OWNER = 'A';

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

const stubPlugin = {
  name: 'stub-cloud-deps',
  setup(build) {
    build.onResolve({ filter: /^\.\/cloudAuth$/ }, () => ({ path: path.join(STUBS, 'stub-cloud-auth.cjs') }));
    build.onResolve({ filter: /^\.\/cloudDb$/ }, () => ({ path: path.join(STUBS, 'stub-cloud-db.cjs') }));
  }
};

async function compile(entry) {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
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
  return built.outputFiles[0].text;
}

const cloudText = await compile('src/services/cloudSync.ts');
const conflictText = await compile('src/utils/syncConflict.ts');
const refreshText = await compile('src/utils/syncRefresh.ts');
const conflictMod = { exports: {} };
new Function('module', 'exports', conflictText)(conflictMod, conflictMod.exports);
const { valueHash } = conflictMod.exports;
const refreshMod = { exports: {} };
new Function('module', 'exports', refreshText)(refreshMod, refreshMod.exports);
const { decideSyncRefresh } = refreshMod.exports;

/** 一台设备：独立 localStorage + 共享云端；记录 setInterval 回调，模拟 30s tick */
async function createDevice(sharedDb) {
  const store = new Map();
  const timers = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    process,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearInterval: () => {},
    Date,
    Promise,
    JSON,
    Math,
    AbortController,
    __STORE__: store,
    __CLOUD_DB__: sharedDb,
    __CLOUD_SESSION__: null,
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
  vm.runInContext(cloudText, sandbox, { filename: 'device-cloudSync.ts' });
  const mod = sandbox.module.exports;
  function meta(owner = OWNER) {
    return JSON.parse(store.get(`cloud-sync-meta:${owner}`) || '{}');
  }
  function confirm(owner = OWNER) {
    return JSON.parse(store.get(`cloud-sync-confirm:${owner}`) || '{}');
  }
  return {
    mod,
    store,
    meta,
    confirm,
    async login(uid) {
      sandbox.__CLOUD_SESSION__ = uid ? { user: { id: uid } } : null;
      await tick(20);
    },
    /** 本地「已确认」状态：值 + meta + 上次推送哈希，用来构造 clean 设备 */
    seedConfirmed(key, value, ts, owner = OWNER) {
      store.set(key, JSON.stringify({ data: value }));
      const m = meta(owner);
      m[key] = ts;
      store.set(`cloud-sync-meta:${owner}`, JSON.stringify(m));
      const c = confirm(owner);
      c[key] = valueHash(value);
      store.set(`cloud-sync-confirm:${owner}`, JSON.stringify(c));
    },
    seedDirty(key, value, ts, owner = OWNER) {
      store.set(key, JSON.stringify({ data: value }));
      const m = meta(owner);
      m[key] = ts;
      store.set(`cloud-sync-meta:${owner}`, JSON.stringify(m));
    },
    read(key) {
      const raw = store.get(key);
      if (!raw) return undefined;
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && 'data' in o ? o.data : o;
    },
    get timer() {
      return timers.length ? timers[timers.length - 1] : null;
    },
    async runPollTick() {
      const t = timers[timers.length - 1];
      if (!t) throw new Error('没有注册轮询定时器');
      await t.fn();
      await tick(20);
    }
  };
}

const db = { rows: {}, calls: [] };
const A = await createDevice(db);
const B = await createDevice(db);
await A.login(OWNER);
await A.mod.initCloudSync();
await B.login(OWNER);
await B.mod.initCloudSync();
await tick(60);

section('断言 0：轮询存在且间隔 = 30s');
assert('A 注册了轮询定时器', !!A.timer);
assert('B 注册了轮询定时器', !!B.timer);
assert('轮询间隔为 30000ms（≤30s）', A.timer.ms === 30_000);

section('断言 1：A 删除 → B 触发一次轮询 tick → 本地变空 + 收到 apply 通知');
A.seedConfirmed('ledgerEntries', [{ id: 'l-1', amount: 20 }], 1000);
await A.mod.syncNow(['ledgerEntries']);
await tick(20);
B.seedConfirmed('ledgerEntries', [{ id: 'l-1', amount: 20 }], 1000);

const applied = [];
B.mod.subscribeSyncApplied((keys) => applied.push(...keys));

A.seedConfirmed('ledgerEntries', [], 2000);
await A.mod.syncNow(['ledgerEntries']);
await tick(20);
const tombstone = db.rows[OWNER]['ledgerEntries#deletedAt'];
const emptyRow = db.rows[OWNER].ledgerEntries;
assert('A 端墓碑存在', !!tombstone);
assert('墓碑 ts 与空数组行 ts 一致', Number(tombstone.clientTs) === Number(emptyRow.clientTs));
assert('云端 ledgerEntries 已是空数组', Array.isArray(emptyRow.value) && emptyRow.value.length === 0);

const t0 = Date.now();
await B.runPollTick();
const elapsed = Date.now() - t0;
assert('轮询 tick（≤30s）后 B 本地变空', Array.isArray(B.read('ledgerEntries')) && B.read('ledgerEntries').length === 0);
assert('B 收到 apply 通知且含 ledgerEntries', applied.includes('ledgerEntries'));
assert('B 的 meta 已对齐墓碑 ts', Number(B.meta().ledgerEntries) === Number(tombstone.clientTs));
assert('本次 tick 耗时 < 30s（不含等待下一个周期）', elapsed < 30_000);

section('断言 2：B 本地有未推送改动 + 远端较新 → 不被静默覆盖');
A.seedConfirmed('shoppingList', [{ id: 's-1' }], 1100);
await A.mod.syncNow(['shoppingList']);
await tick(20);
B.seedConfirmed('shoppingList', [{ id: 's-1' }], 1100);

B.seedDirty('shoppingList', [{ id: 's-b' }], 1500); // 本地改了但没推出去
db.rows[OWNER].shoppingList = { key: 'shoppingList', value: [{ id: 's-a' }], clientTs: 2000 };
await B.runPollTick();

assert('B 本地未被静默覆盖', B.read('shoppingList')[0]?.id === 's-b');
assert('产生待裁决冲突', B.mod.getSyncConflicts().some((c) => c.key === 'shoppingList'));
assert('冲突期间该键不推送', (db.rows[OWNER].shoppingList.value || []).every((e) => e.id !== 's-b'));

section('断言 3：decideSyncRefresh 三分支');
assert(
  '无关 key → ignore',
  decideSyncRefresh({ changed: ['shoppingList'], watched: ['ledgerEntries'], editing: false }) === 'ignore'
);
assert(
  '命中且非编辑 → refresh',
  decideSyncRefresh({ changed: ['ledgerEntries'], watched: ['ledgerEntries'], editing: false }) === 'refresh'
);
assert(
  '命中且编辑中 → defer',
  decideSyncRefresh({ changed: ['ledgerEntries'], watched: ['ledgerEntries'], editing: true }) === 'defer'
);

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
