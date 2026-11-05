#!/usr/bin/env node
/**
 * verify-refund-attempts-purge.mjs —— refund_attempts 清理任务的**行为层**断言
 *
 * 为什么单独一条门禁：
 *   refund_attempts._id 同时是退款并发闸门（add 主键冲突只放一个进）。
 *   清理任务一旦误删 pending/accepted，幂等锁与审计凭据就没了，而语法层完全看不出来。
 *   本文件用内存库真实执行云函数，只断言「删了什么、留了什么」。
 *
 * 用法：node .tools/verify-refund-attempts-purge.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import mockLib from './lib/wx-server-sdk-mock.cjs';

const { createMockCloud } = mockLib;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_FILE = path.join(REPO, 'cloudfunctions', 'purgeRefundAttempts', 'index.js');
const FN_DIR = path.dirname(FN_FILE);

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond === true) {
    passCount += 1;
    return true;
  }
  failures.push(name);
  console.log(`  ✗ ${name}${detail === undefined ? '' : ' —— ' + detail}`);
  return false;
}
const json = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

const BUILTINS = new Set(Module.builtinModules);
function loadFromSource(src, cloud) {
  const realRequire = createRequire(FN_FILE);
  const fakeRequire = (id) => {
    if (id === 'wx-server-sdk') return cloud;
    if (typeof id === 'string' && (id.startsWith('.') || path.isAbsolute(id) || BUILTINS.has(id) || id.startsWith('node:'))) {
      return realRequire(id);
    }
    throw new Error(`mock-unexpected-dependency: ${id}`);
  };
  const mod = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${src}\n})`,
    { filename: FN_FILE }
  );
  wrapper(mod.exports, fakeRequire, mod, FN_FILE, FN_DIR);
  return mod.exports.main;
}

function boot(seed) {
  const cloud = createMockCloud({
    context: { OPENID: 'openid-admin', APPID: 'wx-mock', UNIONID: '', ENV: 'mock' },
    seed
  });
  return { cloud, main: loadFromSource(fs.readFileSync(FN_FILE, 'utf8'), cloud) };
}

const daysAgo = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

/* ================================================================== *
 * 1. 只删 180 天前的 failed；accepted / pending / 未到期 failed 原位
 * ================================================================== */
async function caseOnlyOldFailedRemoved() {
  const seed = {
    refund_attempts: [
      { _id: 'old-failed-1', status: 'failed', createTime: daysAgo(200) },
      { _id: 'old-failed-2', status: 'failed', createTime: daysAgo(200) },
      { _id: 'old-accepted', status: 'accepted', createTime: daysAgo(200) },
      // 锁：即使很老也不能按龄删
      { _id: 'old-pending', status: 'pending', createTime: daysAgo(200) },
      { _id: 'old-failed-boundary', status: 'failed', createTime: daysAgo(181) },
      { _id: 'recent-failed', status: 'failed', createTime: daysAgo(10) }
    ]
  };
  const { cloud, main } = boot(seed);
  const res = await main();
  console.log(`  结果: ${json(res)}`);

  ok('恰好删除 3 条（2 条 200 天 + 1 条 181 天前的 failed）', res.deleted === 3, json(res));
  const ids = cloud.__docs('refund_attempts').map((d) => d._id).sort();
  ok('accepted 永久保留', ids.includes('old-accepted'), json(ids));
  ok('pending 永不按龄删（锁不能丢）', ids.includes('old-pending'), json(ids));
  ok('未到 180 天的 failed 保留', ids.includes('recent-failed'), json(ids));
  ok('剩下的正好是 3 条', ids.length === 3, json(ids));
  ok('返回体里 scanned 反映本轮命中数', res.scanned === 3, json(res.scanned));
}

/* ================================================================== *
 * 2. 重跑幂等：同一批数据第二次扫描应删 0 条
 * ================================================================== */
async function caseSecondRunNoop() {
  const seed = {
    refund_attempts: [
      { _id: 'old-failed-1', status: 'failed', createTime: daysAgo(200) },
      { _id: 'old-accepted', status: 'accepted', createTime: daysAgo(200) },
      { _id: 'old-pending', status: 'pending', createTime: daysAgo(200) }
    ]
  };
  const { cloud, main } = boot(seed);
  const first = await main();
  ok('首轮删 1 条', first.deleted === 1, json(first));
  const second = await main();
  ok('次轮删 0 条（已清理干净）', second.deleted === 0, json(second));
  ok('两轮后 accepted 与 pending 仍在',
    cloud.__docs('refund_attempts').map((d) => d._id).sort().join(',') === 'old-accepted,old-pending',
    json(cloud.__docs('refund_attempts').map((d) => d._id)));
}

/* ================================================================== *
 * 3. 无记录时正常返回，不报错
 * ================================================================== */
async function caseEmpty() {
  const { main } = boot({ refund_attempts: [] });
  const res = await main();
  ok('空集合返回 ok 且 deleted=0', res.ok === true && res.deleted === 0, json(res));
}

await caseOnlyOldFailedRemoved();
await caseSecondRunNoop();
await caseEmpty();

if (failures.length) {
  console.log(`\nFAIL ${failures.length}: ${failures.join(' | ')}`);
  process.exit(1);
}
console.log(`\nPASS ${passCount} / FAIL 0`);
