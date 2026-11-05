#!/usr/bin/env node
/**
 * verify-funds-idempotency.mjs —— R4 退款幂等的**行为层**断言（不 grep）
 *
 * 为什么单独一条门禁：
 *   `.tools/verify-cloudfunctions-flow.mjs` 已覆盖退款的基础守卫，但它没有「第三方调用计数」，
 *   因此「重试打了第二笔」「并发同时发起」这类**资损**问题在那边结构性不可见。
 *   本文件用进程内桩计数 cloudPay.refund，直接断言调用次数与 refundNo。
 *
 * 断言纪律（与 cloudflow 一致）：
 *   · 只有 cond === true 才 PASS；失败分支不返回任何真值字符串；
 *   · 汇总只有一行 `PASS n / FAIL m`；m>0 时 process.exit(1)。
 *
 * 用法：
 *   node .tools/verify-funds-idempotency.mjs
 *   node .tools/verify-funds-idempotency.mjs --verbose
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import mockLib from './lib/wx-server-sdk-mock.cjs';

const { createMockCloud } = mockLib;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_FILE = path.join(REPO, 'cloudfunctions', 'refundOrder', 'index.js');
const FN_DIR = path.dirname(FN_FILE);
const VERBOSE = process.argv.includes('--verbose');

const realLog = console.log.bind(console);
const out = (...a) => realLog(...a);
if (!VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}
const OWNER = 'openid-owner-A';
const ORDER_ID = 'ord_1';
const MS_DAY = 24 * 60 * 60 * 1000;

let passCount = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond === true) {
    passCount += 1;
    return true;
  }
  failures.push(name);
  out(`  ✗ ${name}${detail === undefined ? '' : ' —— ' + detail}`);
  return false;
}
const json = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

/* ---------------- 云函数加载（fake require：wx-server-sdk → mock） ---------------- */
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

/**
 * 起一个场景：内存库 + cloudPay 桩计数。
 * refund/queryRefund 都是测试显式声明的替身，调用次数由本文件断言。
 */
function boot({ seed = {}, refund, queryRefund } = {}) {
  const cloud = createMockCloud({
    context: { OPENID: OWNER, APPID: 'wx-mock', UNIONID: '', ENV: 'mock' },
    seed
  });
  const calls = { refund: [], queryRefund: [] };
  cloud.cloudPay = {
    refund: async (p) => {
      calls.refund.push(p);
      return refund ? refund(p) : { status: 'SUCCESS', refundId: 'wx_rf_1' };
    },
    queryRefund: async (p) => {
      calls.queryRefund.push(p);
      return queryRefund ? queryRefund(p) : { errCode: 'REFUND_NOT_EXIST' };
    }
  };
  return { cloud, calls, main: loadFromSource(fs.readFileSync(FN_FILE, 'utf8'), cloud) };
}

function paidOrder(extra = {}) {
  return [Object.assign({
    _id: 'o1', orderId: ORDER_ID, openid: OWNER, channel: 'wechat',
    planId: 'monthly', price: 990, months: 1, status: 'paid'
  }, extra)];
}
function aUser(expiredAt) {
  return [{ _id: 'u-a', openid: OWNER, expiredAt, subscribed: true }];
}
const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();

/* ================================================================== *
 * 1. 同一订单连续退款 3 次 → 第三方只被调用 1 次
 *    （第一次通道超时 = 结果未知；后两次必须判「处理中」，不许再打通道）
 * ================================================================== */
async function caseSequential() {
  out('\n[1] 连续 3 次退款');
  const userExpiredAt = new Date(Date.now() + MS_DAY).toISOString();
  const { cloud, calls, main } = boot({
    seed: { orders: paidOrder(), users: aUser(userExpiredAt) },
    refund: () => { throw new Error('mock timeout'); }
  });

  const r1 = await main({ orderId: ORDER_ID });
  out(`  第1次: ok=${r1.ok} unknown=${!!r1.unknown}`);
  const order1 = cloud.__docs('orders')[0];
  ok('确定性派生 refundNo = Rord_1-01', order1.refundNo === 'Rord_1-01', json(order1.refundNo));
  ok('调用前落库：refund_attempts 有一条 pending', cloud.__docs('refund_attempts').length === 1 && cloud.__docs('refund_attempts')[0].status === 'pending', json(cloud.__docs('refund_attempts')));

  const r2 = await main({ orderId: ORDER_ID });
  const r3 = await main({ orderId: ORDER_ID });
  out(`  第2/3次: processing=${!!r2.processing}/${!!r3.processing}`);
  ok('第2次判处理中（未知结果不许重发）', r2.ok === false && r2.processing === true, json(r2));
  ok('第3次判处理中', r3.ok === false && r3.processing === true, json(r3));
  ok('第三方退款接口只被调用 1 次', calls.refund.length === 1, `refundCalls=${calls.refund.length}`);
  ok('三次调用共用同一个 outRefundNo', calls.refund.every((c) => c.outRefundNo === 'Rord_1-01'), json(calls.refund.map((c) => c.outRefundNo)));
  ok('失败时不得扣减订阅', cloud.__docs('users')[0].expiredAt === userExpiredAt, json(cloud.__docs('users')[0].expiredAt));
}

/* ================================================================== *
 * 2. 并发两次 → 只有一次进入「真正发起」分支
 * ================================================================== */
async function caseConcurrent() {
  out('\n[2] 并发两次退款');
  const userExpiredAt = new Date(Date.now() + MS_DAY).toISOString();
  const { cloud, calls, main } = boot({
    seed: { orders: paidOrder(), users: aUser(userExpiredAt) },
    refund: async () => { await new Promise((r) => setTimeout(r, 20)); return { status: 'SUCCESS', refundId: 'wx_rf_c' }; }
  });

  const [a, b] = await Promise.all([main({ orderId: ORDER_ID }), main({ orderId: ORDER_ID })]);
  out(`  结果 A: ok=${a.ok} processing=${!!a.processing}; B: ok=${b.ok} processing=${!!b.processing}`);
  ok('并发只发起 1 次通道退款', calls.refund.length === 1, `refundCalls=${calls.refund.length}`);
  ok('恰好一个成功、一个被判处理中', [a.ok, b.ok].filter((x) => x === true).length === 1 && [a, b].some((r) => r.processing === true), json([a, b]));
  ok('订单只落一次终态 refunded', cloud.__docs('orders')[0].refundStatus === 'refunded', json(cloud.__docs('orders')[0].refundStatus));
  ok('refund_attempts 只有 1 条（同一个 refundNo）', cloud.__docs('refund_attempts').length === 1, json(cloud.__docs('refund_attempts').map((d) => d._id)));
  const expectedExpiry = new Date(new Date(userExpiredAt).getTime() - 30 * MS_DAY).toISOString();
  ok('权益只扣一次（expiredAt 恰好减 30 天）', cloud.__docs('users')[0].expiredAt === expectedExpiry, `${json(cloud.__docs('users')[0].expiredAt)} vs ${json(expectedExpiry)}`);
}

/* ================================================================== *
 * 3. 10 分钟 stale 接管：必须先查第三方，查清 accepted 就不再发
 * ================================================================== */
async function caseStale() {
  out('\n[3] stale 接管先查单');
  const { cloud, calls, main } = boot({
    seed: {
      orders: paidOrder({ refundStatus: 'refunding', refundNo: 'Rord_1-01', refundAttempt: 1, refundLockAt: minutesAgo(11) }),
      users: aUser(new Date(Date.now() + MS_DAY).toISOString()),
      refund_attempts: [{ _id: 'Rord_1-01', orderId: ORDER_ID, channel: 'wechat', status: 'pending', createTime: minutesAgo(11) }]
    },
    queryRefund: () => ({ status: 'SUCCESS', refundId: 'wx_rf_stale' })
  });

  const res = await main({ orderId: ORDER_ID });
  out(`  recovered=${!!res.recovered}`);
  ok('stale 场景逆查询 1 次', calls.queryRefund.length === 1, `queryCalls=${calls.queryRefund.length}`);
  ok('查清已退后绝不重发第二笔', calls.refund.length === 0, `refundCalls=${calls.refund.length}`);
  ok('按查询结果补写 refunded（recovered）', res.ok === true && res.recovered === true, json(res));
  ok('尝试记录补成 accepted + 第三方流水号', cloud.__docs('refund_attempts')[0].status === 'accepted' && cloud.__docs('refund_attempts')[0].thirdPartyNo === 'wx_rf_stale', json(cloud.__docs('refund_attempts')[0]));
}

/* ================================================================== *
 * 4. stale 但查明确认「通道没有这笔」→ 允许同号重发（仍只有一个逻辑退款）
 * ================================================================== */
async function caseStaleNotFound() {
  out('\n[4] stale 且通道确认无此单');
  const { calls, main } = boot({
    seed: {
      orders: paidOrder({ refundStatus: 'refunding', refundNo: 'Rord_1-01', refundAttempt: 1, refundLockAt: minutesAgo(11) }),
      users: aUser(new Date(Date.now() + MS_DAY).toISOString()),
      refund_attempts: [{ _id: 'Rord_1-01', orderId: ORDER_ID, channel: 'wechat', status: 'pending', createTime: minutesAgo(11) }]
    },
    queryRefund: () => ({ errCode: 'REFUND_NOT_EXIST' })
  });

  const res = await main({ orderId: ORDER_ID });
  ok('确认无此单后同号重发成功', res.ok === true && res.refundNo === 'Rord_1-01', json(res));
  ok('重发仍用同一 refundNo（逻辑上只有一笔退款）', calls.refund.length === 1 && calls.refund[0].outRefundNo === 'Rord_1-01', json(calls.refund.map((c) => c.outRefundNo)));
}

/* ================================================================== *
 * 5. 变异验证：改坏必红（在内存里改源码，不写文件）
 * ================================================================== */
async function mutationChecks() {
  out('\n[5] 变异验证');
  const realSrc = fs.readFileSync(FN_FILE, 'utf8');

  // M1：确定性派生 → 随机数。断言 [1] 的 refundNo 校验必须失败。
  const mutSrc1 = realSrc.replace(
    /function deriveRefundNo\(orderId, attempt\) \{[\s\S]*?\n\}/,
    "function deriveRefundNo(orderId) { return `refund_${orderId}_${Date.now()}`; }"
  );
  ok('变异点 M1 确实改到了源码', mutSrc1 !== realSrc, 'deriveRefundNo 未匹配到');
  const userExpiredAt = new Date(Date.now() + MS_DAY).toISOString();
  const { cloud: c1, main: main1 } = bootWithSource(mutSrc1, {
    seed: { orders: paidOrder(), users: aUser(userExpiredAt) },
    refund: () => { throw new Error('mock timeout'); }
  });
  await main1({ orderId: ORDER_ID });
  const mutNo = c1.__docs('orders')[0].refundNo;
  ok('M1 变异后 refundNo 不再是 Rord_1-01（断言 [1] 转红）', mutNo !== 'Rord_1-01', json(mutNo));

  // M2：去掉「调用前落库」→ 并发两次都会真正发起（断言 [2] 转红）。
  const mutSrc2 = realSrc.replace(
    /const reservation = await reserveAttempt\(\{[\s\S]*?\n  \}\);?/,
    'const reservation = { created: true, existing: null };'
  );
  ok('变异点 M2 确实改到了源码', mutSrc2 !== realSrc, 'reserveAttempt 块未匹配到');
  const { calls: calls2, main: main2 } = bootWithSource(mutSrc2, {
    seed: { orders: paidOrder(), users: aUser(new Date(Date.now() + MS_DAY).toISOString()) },
    refund: async () => { await new Promise((r) => setTimeout(r, 20)); return { status: 'SUCCESS', refundId: 'wx_rf_m2' }; }
  });
  await Promise.all([main2({ orderId: ORDER_ID }), main2({ orderId: ORDER_ID })]);
  ok('M2 变异后并发发起 2 次（断言 [2] 转红）', calls2.refund.length === 2, `refundCalls=${calls2.refund.length}`);
}

/** 同 boot，但用给定的源码（供变异用） */
function bootWithSource(src, { seed, refund, queryRefund }) {
  const cloud = createMockCloud({
    context: { OPENID: OWNER, APPID: 'wx-mock', UNIONID: '', ENV: 'mock' },
    seed
  });
  const calls = { refund: [], queryRefund: [] };
  cloud.cloudPay = {
    refund: async (p) => { calls.refund.push(p); return refund(p); },
    queryRefund: async (p) => { calls.queryRefund.push(p); return queryRefund ? queryRefund(p) : { errCode: 'REFUND_NOT_EXIST' }; }
  };
  return { cloud, calls, main: loadFromSource(src, cloud) };
}

/* ---------------- 跑 ---------------- */
const t0 = Date.now();
await caseSequential();
await caseConcurrent();
await caseStale();
await caseStaleNotFound();
await mutationChecks();
const elapsed = Date.now() - t0;
out(`\nPASS ${passCount} / FAIL ${failures.length}（${elapsed}ms）`);
if (failures.length) {
  out('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
