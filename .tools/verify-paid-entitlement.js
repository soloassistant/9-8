#!/usr/bin/env node
/**
 * verify-paid-entitlement.js —— P0「付了钱但订阅权益不生效」的行为验证。
 *
 * 全部用**内存桩**替掉 wx-server-sdk / cloudPay，不连真云、不发网络请求。
 * 覆盖两条对账路径：pay-callback（回调）与 queryOrder（主动查单）。
 *
 * ⚠️ 断言铁律：cond 必须是 boolean。非 boolean 直接抛错 ——
 *    防止「失败分支返回说明字符串」被 truthy 判成 PASS 的历史事故。
 *
 * 用法：node .tools/verify-paid-entitlement.js
 * 退出码：0 = 全 PASS
 */
'use strict';
const Module = require('module');
const origLoad = Module._load;

/* =====================================================================
 * 忠实内存 DB：where 记录查询键、doc.update 记录写盘、按字段等值过滤
 * ===================================================================== */
const state = {
  orders: [],
  users: [],
  userQueries: [],
  orderUpdates: [],
  userUpdates: []
};

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const matches = (doc, q) => Object.keys(q).every((k) => doc[k] === q[k]);

function makeQuery(name, query) {
  let lim = null;
  const api = {
    limit(n) {
      lim = n;
      return api;
    },
    async get() {
      let rows = state[name].filter((d) => matches(d, query));
      if (lim !== null) rows = rows.slice(0, lim);
      return { data: clone(rows) };
    }
  };
  return api;
}

const dbStub = {
  collection(name) {
    return {
      where(query) {
        if (name === 'users') state.userQueries.push(clone(query));
        return makeQuery(name, query);
      },
      doc(id) {
        return {
          async update({ data }) {
            const arr = state[name];
            const i = arr.findIndex((d) => d._id === id);
            if (i < 0) throw new Error('doc not found: ' + id);
            arr[i] = { ...arr[i], ...clone(data) };
            if (name === 'orders') state.orderUpdates.push({ id, data: clone(data) });
            if (name === 'users') state.userUpdates.push({ id, data: clone(data) });
            return { stats: { updated: 1 } };
          },
          async get() {
            const d = state[name].find((x) => x._id === id);
            if (!d) throw new Error('document not exists');
            return { data: clone(d) };
          }
        };
      },
      async add({ data }) {
        const doc = { _id: name + '-auto-' + (state[name].length + 1), ...clone(data) };
        state[name].push(doc);
        return { _id: doc._id };
      },
      async get() {
        return { data: clone(state[name]) };
      }
    };
  }
};

/** 查单桩：微信通道固定返回「已支付」 */
const cloudPayStub = {
  async queryOrder() {
    return { returnCode: 'SUCCESS', trade_state: 'SUCCESS', transaction_id: 'WX-TRADE-1' };
  }
};

Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database: () => dbStub,
      getWXContext: () => ({ OPENID: 'buyer-openid' }),
      cloudPay: cloudPayStub
    };
  }
  return origLoad.apply(this, arguments);
};

const payCallback = require('D:/Agent/晨报/cloudfunctions/pay-callback/index.js');
const queryOrder = require('D:/Agent/晨报/cloudfunctions/queryOrder/index.js');

/* =====================================================================
 * 断言
 * ===================================================================== */
let pass = 0;
const failures = [];
function assert(name, cond) {
  if (typeof cond !== 'boolean') {
    throw new TypeError(`断言 ${name} 的 cond 必须是 boolean，实际是 ${typeof cond}`);
  }
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

/* =====================================================================
 * 测试夹具
 * ===================================================================== */
function reset() {
  state.orders.length = 0;
  state.users.length = 0;
  state.userQueries.length = 0;
  state.orderUpdates.length = 0;
  state.userUpdates.length = 0;
}

function seedOrder(over) {
  const o = {
    _id: 'order-doc-1',
    orderId: 'ORDER-1',
    openid: 'buyer-openid',
    status: 'pending',
    channel: 'wechat',
    price: 900,
    months: 1,
    planId: 'monthly',
    ...over
  };
  state.orders.push(o);
  return o;
}

function seedUser(openid, over) {
  const u = { _id: 'user-doc-1', openid, subscribed: false, expiredAt: null, ...over };
  state.users.push(u);
  return u;
}

/** 模拟微信 cloudPay 回调（detectChannel 认 payment.paySign） */
const fireCallback = (orderId) =>
  payCallback.main({ payment: { paySign: 'stub' }, outTradeNo: orderId, transactionId: 'T1' }, {});

const queriesAllUseOpenid = () =>
  state.userQueries.length > 0 &&
  state.userQueries.every(
    (q) => Object.prototype.hasOwnProperty.call(q, 'openid') && !Object.prototype.hasOwnProperty.call(q, '_openid')
  );

const hasSubscribedTrue = () => {
  const u = state.userUpdates[0];
  return !!u && u.data && u.data.subscribed === true;
};
const hasValidExpiredAt = () => {
  const u = state.userUpdates[0];
  return !!u && typeof u.data.expiredAt === 'string' && !isNaN(new Date(u.data.expiredAt).getTime());
};

/* =====================================================================
 * 1. pay-callback 成功路径
 * ===================================================================== */
(async () => {
  reset();
  seedOrder({ orderId: 'ORDER-OK' });
  seedUser('buyer-openid');
  const rOk = await fireCallback('ORDER-OK');

  // 微信通道把内部结果包一层：{ code:0, message:'success', data:{ paid:true } }
  assert('PAY/成功/返回 paid=true', !!rOk && rOk.code === 0 && !!rOk.data && rOk.data.paid === true);
  assert('PAY/查询键是 openid（不是 _openid）', queriesAllUseOpenid());
  assert('PAY/预检 + 发放各查一次 users', state.userQueries.length >= 2);
  assert('PAY/订单置为 paid', state.orderUpdates.length === 1 && state.orderUpdates[0].data.status === 'paid');
  assert('PAY/用户更新恰好 1 次', state.userUpdates.length === 1);
  assert('PAY/patch 同时写 subscribed:true', hasSubscribedTrue());
  assert('PAY/patch 同时写 expiredAt', hasValidExpiredAt());

  /* ---------- 2. pay-callback 用户不存在：订单不得置 paid ---------- */
  reset();
  seedOrder({ orderId: 'ORDER-GHOST', openid: 'ghost-openid' });
  const rGhost = await fireCallback('ORDER-GHOST');

  assert('PAY/缺用户/订单未被置 paid', state.orderUpdates.length === 0);
  assert(
    'PAY/缺用户/返回失败（code=-1 且含「用户不存在」）',
    !!rGhost && rGhost.code === -1 && /用户不存在/.test(String(rGhost.error))
  );
  assert('PAY/缺用户/用户未被更新', state.userUpdates.length === 0);

  /* ---------- 3. pay-callback 幂等：重复回调不叠加 ---------- */
  reset();
  seedOrder({ orderId: 'ORDER-IDEM' });
  seedUser('buyer-openid');
  await fireCallback('ORDER-IDEM');
  assert('PAY/幂等/首次确实发放', state.userUpdates.length === 1);
  const payFirstExpired = state.userUpdates[0] ? state.userUpdates[0].data.expiredAt : undefined;
  const rIdem = await fireCallback('ORDER-IDEM');

  assert('PAY/幂等/第二次走 alreadyPaid', !!rIdem && rIdem.code === 0 && !!rIdem.data && rIdem.data.alreadyPaid === true);
  assert('PAY/幂等/用户不再更新', state.userUpdates.length === 1);
  assert('PAY/幂等/expiredAt 不叠加', !!state.userUpdates[0] && state.userUpdates[0].data.expiredAt === payFirstExpired);
  assert('PAY/幂等/订单只更新一次', state.orderUpdates.length === 1);

  /* =====================================================================
   * 4. queryOrder 成功路径
   * ===================================================================== */
  reset();
  seedOrder({ orderId: 'Q-ORDER-OK' });
  seedUser('buyer-openid');
  const qOk = await queryOrder.main({ orderId: 'Q-ORDER-OK' });

  assert('QUERY/成功/返回 paid 且已对账', !!qOk && qOk.paid === true && qOk.reconciled === true);
  assert('QUERY/查询键是 openid（不是 _openid）', queriesAllUseOpenid());
  assert('QUERY/预检 + 发放各查一次 users', state.userQueries.length >= 2);
  assert('QUERY/订单置为 paid', state.orderUpdates.length === 1 && state.orderUpdates[0].data.status === 'paid');
  assert('QUERY/用户更新恰好 1 次', state.userUpdates.length === 1);
  assert('QUERY/patch 同时写 subscribed:true', hasSubscribedTrue());
  assert('QUERY/patch 同时写 expiredAt', hasValidExpiredAt());

  /* ---------- 5. queryOrder 用户不存在：订单不得置 paid ---------- */
  reset();
  // 订单归属仍是当前 OPENID（否则会先被 main() 的归属校验挡掉，测不到「用户不存在」预检）；
  // users 集合里刻意不 seed 该 openid。
  seedOrder({ orderId: 'Q-GHOST' });
  const qGhost = await queryOrder.main({ orderId: 'Q-GHOST' });

  assert('QUERY/缺用户/订单未被置 paid', state.orderUpdates.length === 0);
  assert(
    'QUERY/缺用户/返回 reconcile_failed 且含「用户不存在」',
    !!qGhost && qGhost.channelStatus === 'reconcile_failed' && /用户不存在/.test(String(qGhost.error))
  );

  /* ---------- 6. queryOrder 幂等：本地已 paid 不重复对账 ---------- */
  reset();
  seedOrder({ orderId: 'Q-IDEM' });
  seedUser('buyer-openid');
  await queryOrder.main({ orderId: 'Q-IDEM' });
  assert('QUERY/幂等/首次确实发放', state.userUpdates.length === 1);
  const qFirstExpired = state.userUpdates[0] ? state.userUpdates[0].data.expiredAt : undefined;
  const qIdem = await queryOrder.main({ orderId: 'Q-IDEM' });

  assert('QUERY/幂等/第二次 paid 但不重复对账', !!qIdem && qIdem.paid === true && qIdem.reconciled === false);
  assert('QUERY/幂等/用户不再更新', state.userUpdates.length === 1);
  assert('QUERY/幂等/expiredAt 不叠加', !!state.userUpdates[0] && state.userUpdates[0].data.expiredAt === qFirstExpired);

  /* ---------- 汇总 ---------- */
  console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
  if (failures.length) {
    console.log('FAIL 集合：');
    for (const n of failures) console.log(`  - ${n}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('HARNESS CRASH:', err && err.stack ? err.stack : err);
  process.exit(2);
});
