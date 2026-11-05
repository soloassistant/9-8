#!/usr/bin/env node
/**
 * verify-entitlement-rollbacks.mjs —— 退款后权益回滚对账的行为断言
 *
 * 覆盖三件事（都用内存库真跑，不 grep）：
 *   1. failed → 跑一次 → rolled_back，且到期日恰好扣 30 天；
 *   2. 永久失败（用户已注销）→ 第 3 次转 manual_required；
 *   3. 崩溃恢复（上次已扣成功但状态没写成）→ 只补状态，绝不二次扣减。
 *
 * 用法：node .tools/verify-entitlement-rollbacks.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import mockLib from './lib/wx-server-sdk-mock.cjs';

const { createMockCloud } = mockLib;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_FILE = path.join(REPO, 'cloudfunctions', 'reconcileEntitlementRollbacks', 'index.js');
const BUILDINS = new Set(Module.builtinModules);
const MS_DAY = 24 * 60 * 60 * 1000;
const realLog = console.log.bind(console);
const out = (...a) => realLog(...a);
console.log = () => {};
console.warn = () => {};
console.error = () => {};

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond === true) { passCount += 1; return true; }
  failures.push(name);
  out(`  ✗ ${name}${detail === undefined ? '' : ' —— ' + detail}`);
  return false;
}
const json = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

function boot(seed) {
  const cloud = createMockCloud({ context: { OPENID: '', APPID: 'wx-mock', UNIONID: '', ENV: 'mock' }, seed });
  const realRequire = createRequire(FN_FILE);
  const fakeRequire = (id) => {
    if (id === 'wx-server-sdk') return cloud;
    if (id.startsWith('.') || path.isAbsolute(id) || BUILDINS.has(id) || id.startsWith('node:')) return realRequire(id);
    throw new Error('mock-unexpected-dependency: ' + id);
  };
  const mod = { exports: {} };
  vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(FN_FILE, 'utf8')}\n})`, { filename: FN_FILE })(
    mod.exports, fakeRequire, mod, FN_FILE, path.dirname(FN_FILE)
  );
  return { cloud, main: mod.exports.main };
}

const failedOrder = (extra = {}) => [Object.assign({
  _id: 'o1', orderId: 'ord_1', openid: 'openid-owner-A', months: 1,
  price: 990, status: 'refunded', refundStatus: 'refunded',
  entitlementRollbackStatus: 'failed', entitlementRollbackAttempts: 0
}, extra)];

/* 1. failed → rolled_back，且只扣一次 30 天 */
{
  out('\n[1] 回滚失败一次后被对账修好');
  // 原到期日 = now + 31 天 → 扣 30 天后仍剩 1 天，用于验证 subscribed 按新到期日重算
  const seedExpiry = new Date(Date.now() + 31 * MS_DAY).toISOString();
  const { cloud, main } = boot({ orders: failedOrder(), users: [{ _id: 'u-a', openid: 'openid-owner-A', expiredAt: seedExpiry, subscribed: true }] });
  const res = await main();
  const order = cloud.__docs('orders')[0];
  const expected = new Date(new Date(seedExpiry).getTime() - 30 * MS_DAY).toISOString();
  ok('任务统计 rolledBack=1', res.ok === true && res.rolledBack === 1, json(res));
  ok('订单进入终态 rolled_back', order.entitlementRollbackStatus === 'rolled_back', json(order.entitlementRollbackStatus));
  ok('到期日恰好扣 30 天', cloud.__docs('users')[0].expiredAt === expected, `${json(cloud.__docs('users')[0].expiredAt)} vs ${json(expected)}`);
  ok('订阅仍有效时 subscribed=true', cloud.__docs('users')[0].subscribed === true, json(cloud.__docs('users')[0]));
}

/* 2. 永久失败（用户不存在）→ 第 3 次 manual_required */
{
  out('\n[2] 永久失败累计 3 次转人工');
  const { cloud, main } = boot({ orders: failedOrder({ openid: 'ghost-openid' }), users: [] });
  const states = [];
  for (let i = 0; i < 3; i += 1) {
    await main();
    states.push([cloud.__docs('orders')[0].entitlementRollbackStatus, cloud.__docs('orders')[0].entitlementRollbackAttempts]);
  }
  out('  三次后状态: ' + json(states));
  ok('第 1 次仍 failed、attempts=1', states[0][0] === 'failed' && states[0][1] === 1, json(states[0]));
  ok('第 2 次仍 failed、attempts=2', states[1][0] === 'failed' && states[1][1] === 2, json(states[1]));
  ok('第 3 次转 manual_required', states[2][0] === 'manual_required' && states[2][1] === 3, json(states[2]));
  ok('错误原因落库（可诊断）', String(cloud.__docs('orders')[0].entitlementRollbackError).includes('user-not-found'), json(cloud.__docs('orders')[0].entitlementRollbackError));
}

/* 3. 崩溃恢复：上次已扣到位但状态没写成 → 只补状态，不二次扣 */
{
  out('\n[3] 已扣到位后重跑不重复扣');
  const target = new Date(Date.now() + MS_DAY).toISOString();
  const { cloud, main } = boot({
    orders: failedOrder({ entitlementRollbackBase: new Date(new Date(target).getTime() + 30 * MS_DAY).toISOString(), entitlementRollbackTarget: target }),
    users: [{ _id: 'u-a', openid: 'openid-owner-A', expiredAt: target, subscribed: true }]
  });
  await main();
  ok('只补状态为 rolled_back', cloud.__docs('orders')[0].entitlementRollbackStatus === 'rolled_back', json(cloud.__docs('orders')[0].entitlementRollbackStatus));
  ok('到期日保持不变（无二次扣减）', cloud.__docs('users')[0].expiredAt === target, `${json(cloud.__docs('users')[0].expiredAt)} vs ${json(target)}`);
}

out(`\nPASS ${passCount} / FAIL ${failures.length}`);
if (failures.length) {
  out('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
