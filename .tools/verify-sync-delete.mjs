#!/usr/bin/env node
/**
 * verify-sync-delete.mjs —— 缺陷 B3 回归（删除永不同步，含健康轨迹）。
 *
 * 复现（修复前）：
 *   设备 1 删除最后一条账目 → 本地变 [] → collectLocal 跳过空数组（仅 watchlist 例外）
 *   → 云端仍是旧列表；设备 2 刷新/重登时把旧列表拉回来（删除「复活」）。
 *   运动记录 sportRuns 同理。
 *
 * 方案：显式墓碑行 `<key>#deletedAt`（只在用户明确删除时产生），接收端据此清空；
 * 非删除场景的「远端空数组不覆盖本地非空」保护继续生效。
 *
 * 本脚本用两个隔离的 localStorage（两台设备）+ 共享的按 owner 隔离 user_kv 跑真实同步逻辑：
 *   1. 设备1 推送账目/运动两条记录 → 设备2 拉取成功（两台设备同一账号）；
 *   2. 设备1 删除最后一条账目并 forced 推送 → 云端出现墓碑 → 设备2 刷新后被清空；
 *   3. 注入「远端空数组、无墓碑（ts 更新）」→ 设备2 本地非空**不被覆盖**（保护仍生效）；
 *   4. 运动记录走同一路径：未 forced 的 [] 不上推、无墓碑；forced 后设备2 清空。
 *
 * 用法: node .tools/verify-sync-delete.mjs
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

let bundleText = null;
async function compileOnce() {
  if (bundleText) return bundleText;
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
  bundleText = built.outputFiles[0].text;
  return bundleText;
}

/** 一台「设备」：独立 localStorage，共享同一份云端 user_kv */
async function createDevice(sharedDb) {
  const text = await compileOnce();
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
  vm.runInContext(text, sandbox, { filename: 'device-cloudSync.ts' });

  const mod = sandbox.module.exports;
  const api = {
    mod,
    store,
    sandbox,
    async login(uid) {
      sandbox.__CLOUD_SESSION__ = uid ? { user: { id: uid } } : null;
      const listeners = sandbox.__AUTH_LISTENERS__;
      if (listeners) {
        for (const cb of [...listeners]) {
          try {
            cb(sandbox.__CLOUD_SESSION__);
          } catch {}
        }
      }
      await tick(30);
    },
    /** 不经过 Taro 钩子直接写本地：模拟用户写入后的 localStorage + meta 状态 */
    seed(key, value, metaTs, owner = OWNER) {
      store.set(key, JSON.stringify({ data: value }));
      const metaPath = `cloud-sync-meta:${owner}`;
      const meta = JSON.parse(store.get(metaPath) || '{}');
      meta[key] = metaTs;
      store.set(metaPath, JSON.stringify(meta));
    },
    read(key) {
      const raw = store.get(key);
      if (!raw) return undefined;
      try {
        const o = JSON.parse(raw);
        return o && typeof o === 'object' && 'data' in o ? o.data : o;
      } catch {
        return undefined;
      }
    }
  };
  return api;
}

const db = { rows: {}, calls: [] };
const devices = await createDevice(db);
const other = await createDevice(db);

/* 设备 1 与设备 2：同一账号 A */
await devices.login(OWNER);
await devices.mod.initCloudSync();
await other.login(OWNER);
await other.mod.initCloudSync();

section('1. 设备1 写入账目/运动记录并推送，设备2 拉取到位');
const LEDGER = [{ id: 'l-1', amount: 20, categoryId: 'food' }];
const RUNS = [{ id: 'r-1', km: 5, at: '2026-11-03' }];
devices.seed('ledgerEntries', LEDGER, 1000);
devices.seed('sportRuns', RUNS, 1000);
await devices.mod.syncNow();
await tick(10);
assert('设备1 已把账目推上云', JSON.stringify(db.rows.A.ledgerEntries.value) === JSON.stringify(LEDGER));
assert('设备1 已把运动记录推上云', JSON.stringify(db.rows.A.sportRuns.value) === JSON.stringify(RUNS));

await other.login(OWNER);
await tick(10);
assert('设备2 拉到账目', JSON.stringify(other.read('ledgerEntries')) === JSON.stringify(LEDGER));
assert('设备2 拉到运动记录', JSON.stringify(other.read('sportRuns')) === JSON.stringify(RUNS));

section('2. 设备1 删除最后一条账目 → 墓碑 → 设备2 刷新后不再复活');
devices.seed('ledgerEntries', [], 2000);
await devices.mod.syncNow(['ledgerEntries']);
await tick(10);
const tomb = db.rows.A['ledgerEntries#deletedAt'];
assert('云端存在账目墓碑行', !!tomb);
assert('墓碑携带删除时间 ts=2000', Number(tomb.clientTs) === 2000);
assert('云端账目值已变为空数组', Array.isArray(db.rows.A.ledgerEntries.value) && db.rows.A.ledgerEntries.value.length === 0);

await other.login(OWNER);
await tick(10);
assert('设备2 的账目被清空（删除跨端生效）', Array.isArray(other.read('ledgerEntries')) && other.read('ledgerEntries').length === 0);

section('3. 非删除场景：远端空数组（无墓碑）不覆盖本地非空');
// 先让设备2 有一份「已确认」的非空购物清单（从云端正常拉取）
const SHOP = [{ id: 's-1', name: '牛奶' }];
devices.seed('shoppingList', SHOP, 1000);
await devices.mod.syncNow();
await tick(10);
await other.login(OWNER);
await tick(10);
assert('设备2 拉到购物清单', JSON.stringify(other.read('shoppingList')) === JSON.stringify(SHOP));

// 模拟历史残影：远端出现「更新的空数组」但没有墓碑
db.rows.A.shoppingList = { key: 'shoppingList', value: [], clientTs: 3000 };
await other.login(OWNER);
await tick(10);
assert(
  '无墓碑的远端空数组被拒绝覆盖（保护仍生效）',
  JSON.stringify(other.read('shoppingList')) === JSON.stringify(SHOP)
);

section('4. 运动记录（健康轨迹）：未 forced 的 [] 不上推，forced 后跨端清空');
devices.seed('sportRuns', [], 4000);
await devices.mod.syncNow(); // 不带 force：模拟「非删除场景」的空数组
await tick(10);
assert('未 forced：云端运动记录仍是旧值', JSON.stringify(db.rows.A.sportRuns.value) === JSON.stringify(RUNS));
assert('未 forced：没有运动墓碑', !db.rows.A['sportRuns#deletedAt']);
await other.login(OWNER);
await tick(10);
assert('未 forced：设备2 的运动记录未变', JSON.stringify(other.read('sportRuns')) === JSON.stringify(RUNS));

await devices.mod.syncNow(['sportRuns']);
await tick(10);
assert('forced：云端出现运动墓碑', !!db.rows.A['sportRuns#deletedAt']);
await other.login(OWNER);
await tick(10);
assert('forced：设备2 的运动记录被清空（健康轨迹删除跨端生效）', Array.isArray(other.read('sportRuns')) && other.read('sportRuns').length === 0);

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
