#!/usr/bin/env node
/**
 * verify-local-write.js —— X8「本地写失败吞提示」回归闸门。
 *
 * 现象：账本 / 购物清单 / 收藏的写盘函数只 `console.warn` 就继续返回成功值，
 * 页面据此弹「已记一笔 / 已删除 / 已加入」，刷新后数据其实没落盘（收藏还会复活）。
 *
 * 本脚本**执行**真实数据层（TS 转译 + Taro storage 桩，写盘时抛错模拟 QuotaExceeded），
 * 断言所有写入失败都返回 null/false/抛出，让调用方必须展示失败。
 *
 * 用法: node .tools/verify-local-write.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond === true) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name);
  }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------- Taro storage 桩：fail=true 时 setStorageSync 抛错 ---------- */
const mem = new Map();
const taro = {
  fail: false,
  getStorageSync: (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : undefined),
  setStorageSync: (k, v) => {
    if (taro.fail) throw new Error('QuotaExceededError');
    mem.set(k, JSON.stringify(v));
  }
};
global.__TARO_STUB__ = taro;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'localwrite-'));
const stubFile = path.join(tmp, 'taro.js');
fs.writeFileSync(stubFile, 'module.exports = { __esModule: true, default: global.__TARO_STUB__ };', 'utf8');

const ts = require('typescript');
function transpile(rel) {
  return ts.transpileModule(read(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true }
  }).outputText;
}
fs.writeFileSync(path.join(tmp, 'ledgerExport.js'), transpile('src/utils/ledgerExport.ts'), 'utf8');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@tarojs/taro') return stubFile;
  if (request === '../utils/ledgerExport') return path.join(tmp, 'ledgerExport.js');
  if (request === 'dayjs') return require.resolve(path.join(ROOT, 'node_modules', 'dayjs'));
  return origResolve.call(this, request, parent, ...rest);
};

function loadModule(rel, name) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, transpile(rel), 'utf8');
  return require(file);
}
const ledger = loadModule('src/data/ledger.ts', 'ledger.js');
const shopping = loadModule('src/data/shopping.ts', 'shopping.js');
const collection = loadModule('src/data/collectionStore.ts', 'collection.js');

/* ---------- 1. 账本 ---------- */
console.log('\n── 1. 账本写失败必须如实返回失败 ──');
taro.fail = false;
mem.set(ledger.LEDGER_KEYS.categories, JSON.stringify([{ id: 'c-food', name: '餐饮', kind: 'expense', icon: '🍜', builtin: true }]));
mem.set(ledger.LEDGER_KEYS.entries, JSON.stringify([
  { id: 'old-1', kind: 'expense', amount: 10, categoryId: 'c-food', note: '', date: '2026-11-04', createdAt: '2026-11-04T02:00:00.000Z' }
]));
const addedOk = ledger.addEntry({ kind: 'expense', amount: 20, categoryId: 'c-food', note: '', date: '2026-11-04' });
ok('正常写盘 addEntry 返回条目', !!addedOk);
taro.fail = true;
ok('写盘失败 addEntry 返回 null', ledger.addEntry({ kind: 'expense', amount: 5, categoryId: 'c-food', note: '', date: '2026-11-04' }) === null);
ok('写盘失败 updateEntry 返回 null', ledger.updateEntry('old-1', { amount: 99 }) === null);
ok('写盘失败 removeEntry 返回 false', ledger.removeEntry('old-1') === false);
ok('写盘失败 saveBudget 返回 null', ledger.saveBudget({ month: 2000 }) === null);
ok('写盘失败 addCategory 返回 null', ledger.addCategory('新分类', 'expense') === null);
taro.fail = false;
ok('恢复后 removeEntry 返回 true', ledger.removeEntry('old-1') === true);

/* ---------- 2. 购物清单 ---------- */
console.log('\n── 2. 购物清单写失败必须如实返回失败 ──');
mem.set('shoppingList', JSON.stringify([
  { id: 's-1', name: '牛奶', prices: [], createdAt: 1, bought: false }
]));
const shopFn = shopping.default || shopping;
taro.fail = true;
ok('写盘失败 add 返回 null', shopFn({ action: 'add', name: '面包' }) === null);
ok('写盘失败 toggleBought 返回 null', shopFn({ action: 'toggleBought', id: 's-1' }) === null);
ok('写盘失败 remove 返回 null', shopFn({ action: 'remove', id: 's-1' }) === null);
ok('写盘失败 addPrice 返回 null', shopFn({ action: 'addPrice', id: 's-1', platform: '京东', price: 9.9 }) === null);
ok('写盘失败 setTargetPrice 返回 null', shopFn({ action: 'setTargetPrice', id: 's-1', price: 5 }) === null);
ok('写盘失败 clearTargetPrice 返回 null', shopFn({ action: 'clearTargetPrice', id: 's-1' }) === null);

/* ---------- 3. 收藏 ---------- */
console.log('\n── 3. 收藏写失败必须抛错/返回 null ──');
mem.set('collectionStore', JSON.stringify([
  { id: 'c-1', title: '标题', url: 'https://example.com', source: '测试', savedAt: 1 }
]));
taro.fail = true;
let threw = false;
try {
  collection.addCollection({ title: '新收藏', url: 'https://example.com/2', source: '测试' });
} catch (e) {
  threw = /collection-save-failed/.test(e.message);
}
ok('写盘失败 addCollection 抛出 collection-save-failed', threw);
ok('写盘失败 removeCollection 返回 null', collection.removeCollection('c-1') === null);
taro.fail = false;
ok('恢复后 removeCollection 返回新列表', Array.isArray(collection.removeCollection('c-1')));

/* ---------- 4. 页面不得忽视失败（源码断言） ---------- */
console.log('\n── 4. 页面接线 ──');
const ledgerPage = read('src/pages/ledger/index.tsx');
ok('预算保存失败有提示', ledgerPage.includes("apiLedgerSaveBudget") && ledgerPage.includes("common.saveFailed"));
const libraryPage = read('src/pages/library/index.tsx');
ok('取消收藏失败不刷新 UI', /if \(!next\)/.test(libraryPage) && libraryPage.includes('common.saveFailed'));
const shoppingPage = read('src/pages/shopping/index.tsx');
ok('购物清单加购失败有提示', /if \(added\)[^]*else[^]*common\.saveFailed/.test(shoppingPage));

console.log(`\n=== local-write: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
