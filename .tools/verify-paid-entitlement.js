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
const path = require('node:path');
const crypto = require('node:crypto');
const origLoad = Module._load;

// 仓库根由脚本位置派生（本文件在 .tools/ 下），不写死任何绝对路径 —— 否则 Linux runner
// 上 require 会 MODULE_NOT_FOUND，整个 harness 直接跑不起来。
const ROOT = path.resolve(__dirname, '..');

/* =====================================================================
 * 忠实内存 DB：where 记录查询键、doc.update 记录写盘、按字段等值过滤
 * ===================================================================== */
const state = {
  orders: [],
  users: [],
  userQueries: [],
  orderUpdates: [],
  userUpdates: [],
  failUserUpdate: false // 注入「延长订阅失败」分支（断言订单可重试）
};

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

/** 云数据库条件匹配：支持等值 + db.command.exists/in（CAS 抢锁用到） */
const matches = (doc, q) =>
  Object.keys(q).every((k) => {
    const want = q[k];
    if (want && want.__op === 'exists') {
      return want.value ? Object.prototype.hasOwnProperty.call(doc, k) : !Object.prototype.hasOwnProperty.call(doc, k);
    }
    if (want && want.__op === 'in') return want.values.includes(doc[k]);
    return doc[k] === want;
  });

function recordUpdate(name, id, data) {
  if (name === 'orders') state.orderUpdates.push({ id, data: clone(data) });
  if (name === 'users') state.userUpdates.push({ id, data: clone(data) });
}

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
    },
    /** 条件更新（CAS）：原子命中多少行就更新多少行，返回 stats.updated */
    async update({ data }) {
      const rows = state[name].filter((d) => matches(d, query));
      for (const row of rows) {
        const i = state[name].indexOf(row);
        state[name][i] = { ...row, ...clone(data) };
        recordUpdate(name, row._id, data);
      }
      return { stats: { updated: rows.length } };
    }
  };
  return api;
}

const dbStub = {
  command: {
    exists: (value) => ({ __op: 'exists', value }),
    in: (values) => ({ __op: 'in', values })
  },
  collection(name) {
    return {
      where(query) {
        if (name === 'users') state.userQueries.push(clone(query));
        return makeQuery(name, query);
      },
      doc(id) {
        return {
          async update({ data }) {
            if (name === 'users' && state.failUserUpdate) throw new Error('injected: user update failed');
            const arr = state[name];
            const i = arr.findIndex((d) => d._id === id);
            if (i < 0) throw new Error('doc not found: ' + id);
            arr[i] = { ...arr[i], ...clone(data) };
            recordUpdate(name, id, data);
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

/* =====================================================================
 * 支付宝回调夹具：真实 RSA 密钥对（验签必须真的通过，才能测到商户校验）
 * ===================================================================== */
const alipayKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
process.env.PAY_ALIPAY_PUBLIC_KEY = alipayKeys.publicKey;
process.env.PAY_ALIPAY_APP_ID = 'app-test';
process.env.PAY_ALIPAY_SELLER_ID = 'seller-test';

/** 构造一条签名正确的支付宝异步通知（over 里的 undefined 键会被删除，用于测缺字段） */
function alipayNotify(over) {
  const p = Object.assign(
    {
      app_id: 'app-test',
      seller_id: 'seller-test',
      out_trade_no: 'AL-1',
      trade_no: 'AL-TRADE-1',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '9.00',
      sign_type: 'RSA2'
    },
    over || {}
  );
  for (const k of Object.keys(p)) {
    if (p[k] === undefined) delete p[k];
  }
  const content = Object.keys(p).sort().map((k) => k + '=' + p[k]).join('&');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(content, 'utf8');
  signer.end();
  p.sign = signer.sign(alipayKeys.privateKey, 'base64');
  return { body: Object.keys(p).map((k) => k + '=' + encodeURIComponent(p[k])).join('&') };
}
/** 云函数上下文桩：默认模拟「云开发平台回调来源」（非小程序客户端） */
const wxCtx = { OPENID: 'buyer-openid', SOURCE: 'wx_server' };

Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init() {},
      database: () => dbStub,
      getWXContext: () => ({ ...wxCtx }),
      cloudPay: cloudPayStub
    };
  }
  return origLoad.apply(this, arguments);
};

const payCallback = require(path.join(ROOT, 'cloudfunctions', 'pay-callback', 'index.js'));
const queryOrder = require(path.join(ROOT, 'cloudfunctions', 'queryOrder', 'index.js'));

/* =====================================================================
 * 断言
 * ===================================================================== */
let pass = 0;
const failures = [];
function assert(name, cond) {
  if (typeof cond !== 'boolean') {
    throw new TypeError(`断言 ${name} 的 cond 必须是 boolean，实际是 ${typeof cond}`);
  }
  if (cond === true) {
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
  state.failUserUpdate = false;
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

/** 模拟微信 cloudPay 回调（detectChannel 认 payment.paySign；金额取订单价） */
const fireCallback = (orderId) => {
  const order = state.orders.find((o) => o.orderId === orderId) || {};
  return payCallback.main(
    { payment: { paySign: 'stub' }, outTradeNo: orderId, transactionId: 'T1', totalFee: order.price },
    {}
  );
};

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
  assert('PAY/订单置为 paid', state.orderUpdates.length >= 1 && state.orderUpdates[0].data.status === 'paid');
  assert(
    'PAY/权益状态机走完 applied',
    state.orders[0].status === 'paid' && state.orders[0].entitlementStatus === 'applied'
  );
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
  const payFirstOrderWrites = state.orderUpdates.length;
  const rIdem = await fireCallback('ORDER-IDEM');

  assert('PAY/幂等/第二次走 alreadyPaid', !!rIdem && rIdem.code === 0 && !!rIdem.data && rIdem.data.alreadyPaid === true);
  assert('PAY/幂等/用户不再更新', state.userUpdates.length === 1);
  assert('PAY/幂等/expiredAt 不叠加', !!state.userUpdates[0] && state.userUpdates[0].data.expiredAt === payFirstExpired);
  assert('PAY/幂等/第二次不再写订单', state.orderUpdates.length === payFirstOrderWrites);

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
  assert('QUERY/订单置为 paid', state.orderUpdates.length >= 1 && state.orderUpdates[0].data.status === 'paid');
  assert(
    'QUERY/权益状态机走完 applied',
    state.orders[0].status === 'paid' && state.orders[0].entitlementStatus === 'applied'
  );
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

  /* ---------- 7. B2 回归：延长失败 → 订单可重试 → 重试只加一次月 ---------- */
  reset();
  seedOrder({ orderId: 'ORDER-RETRY' });
  seedUser('buyer-openid');
  state.failUserUpdate = true;
  const rFail = await fireCallback('ORDER-RETRY');

  assert('B2/延长失败/本次返回失败', !!rFail && rFail.code === -1);
  assert('B2/延长失败/订单仍为 paid（不是永久卡死）', state.orders[0].status === 'paid');
  assert('B2/延长失败/权益状态回滚为 failed（可重试）', state.orders[0].entitlementStatus === 'failed');
  assert('B2/延长失败/用户未被写入', state.userUpdates.length === 0);
  const paidTimeAfterFail = state.orders[0].paidTime;
  assert('B2/延长失败/支付时间已落盘', typeof paidTimeAfterFail === 'string' && paidTimeAfterFail.length > 0);

  state.failUserUpdate = false;
  const rRetry = await fireCallback('ORDER-RETRY');
  assert('B2/重试/成功且返回 paid', !!rRetry && rRetry.code === 0 && rRetry.data.paid === true);
  assert('B2/重试/用户只被写 1 次', state.userUpdates.length === 1);
  assert('B2/重试/权益最终 applied', state.orders[0].entitlementStatus === 'applied');
  assert('B2/重试/支付时间不被重试改写', state.orders[0].paidTime === paidTimeAfterFail);

  /* ---------- 8. B2 回归：两个并发回调只加一次月 ---------- */
  reset();
  seedOrder({ orderId: 'ORDER-RACE' });
  seedUser('buyer-openid');
  const [rA, rB] = await Promise.all([fireCallback('ORDER-RACE'), fireCallback('ORDER-RACE')]);

  assert('B2/并发/至少一个回调成功', (!!rA && rA.code === 0) || (!!rB && rB.code === 0));
  assert('B2/并发/用户只被写 1 次（只加一次月）', state.userUpdates.length === 1);
  assert('B2/并发/权益最终 applied', state.orders[0].entitlementStatus === 'applied');

  /* ---------- 9. B2 回归：已 paid 但未 applied 的订单，queryOrder 能补发 ---------- */
  reset();
  // 模拟历史失败订单：paid 已经写进去，但权益从未发放（旧实现会永久漏发）
  seedOrder({ orderId: 'Q-RECOVER', status: 'paid', entitlementStatus: 'failed', paidTime: '2026-10-01T00:00:00.000Z' });
  seedUser('buyer-openid');
  const qRecover = await queryOrder.main({ orderId: 'Q-RECOVER' });

  assert('B2/查单补发/返回已支付', !!qRecover && qRecover.paid === true);
  assert('B2/查单补发/用户被写 1 次', state.userUpdates.length === 1);
  assert('B2/查单补发/权益最终 applied', state.orders[0].entitlementStatus === 'applied');

  /* ---------- 10. X7：支付成功但对账失败必须有可见提示（前端接线） ---------- */
  // 这一节是**静态接线断言**（不渲染 React）：缺陷不是云端有没有补发，而是前端
  // 把失败咽进 console.warn，用户付完钱只看到「支付成功」，之后没有任何说明。
  const fs = require('node:fs');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'src/pages/membership/index.tsx'), 'utf8');
  assert('X7/UI/正确解包 callFunction 的 result', /\(q as \{ result\?: unknown \} \| null\)\?\.result \?\? q/.test(uiSrc));
  assert('X7/UI/不再把 {result} 直读为业务对象', !/const qRes = q as \{/.test(uiSrc));
  assert('X7/UI/失败分支写入可见状态', (uiSrc.match(/setReconcileIssue\(\{/g) || []).length >= 4);
  assert('X7/UI/提示含订单号与客服指引', /订单号 \$\{paidOrderId\}/.test(uiSrc) && /联系客服/.test(uiSrc));
  assert('X7/UI/提供重新核对入口', /handleRecheck/.test(uiSrc) && /重新核对/.test(uiSrc));
  assert('X7/UI/卡片真实渲染（不是只存 state）', /reconcileIssue \? \(/.test(uiSrc) && /reconcileCard/.test(uiSrc));

  const cbSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'pay-callback', 'index.js'), 'utf8');

  /* ---------- 12. A2：支付宝回调必须校验商户身份 ---------- */
  // 改前：验签通过就入账，从不读 params.app_id / seller_id ⇒ 他人应用的合法通知
  // 只要 out_trade_no 撞上本站订单号，也能把本站订单置为 paid。
  const alipayBlock = cbSrc.slice(cbSrc.indexOf('async function handleAlipay'), cbSrc.indexOf('function assertAlipayMerchant'));
  const posSign = alipayBlock.indexOf('verifyAlipayNotifySign');
  const posMerchant = alipayBlock.indexOf('assertAlipayMerchant(params)');
  const posPaid = alipayBlock.indexOf('confirmOrderPaid({');
  assert('A2/源码锚点/验签在前、商户校验在后', posSign >= 0 && posMerchant > posSign);
  assert('A2/源码锚点/商户校验早于写库', posMerchant >= 0 && posMerchant < posPaid);

  // 12.1 正常回调（app_id/seller_id 匹配）必须能入账，确认没误杀合法回调
  reset();
  seedOrder({ orderId: 'AL-1', channel: 'alipay' });
  seedUser('buyer-openid');
  const alOk = await payCallback.main(alipayNotify({}), {});
  assert('A2/合法回调/返回 200 success', !!alOk && alOk.httpCode === 200 && alOk.body === 'success');
  assert('A2/合法回调/订单置为 paid', state.orders[0].status === 'paid');
  assert('A2/合法回调/用户权益发放', state.userUpdates.length === 1);

  // 12.2 app_id 不一致 → 400 且不写库
  reset();
  seedOrder({ orderId: 'AL-1', channel: 'alipay' });
  seedUser('buyer-openid');
  const alApp = await payCallback.main(alipayNotify({ app_id: 'app-evil' }), {});
  assert('A2/app_id 不一致/返回 400', !!alApp && alApp.httpCode === 400 && alApp.body === 'fail');
  assert('A2/app_id 不一致/订单未变', state.orderUpdates.length === 0 && state.orders[0].status === 'pending');
  assert('A2/app_id 不一致/权益未发放', state.userUpdates.length === 0);

  // 12.3 seller_id 不一致 → 400 且不写库
  reset();
  seedOrder({ orderId: 'AL-1', channel: 'alipay' });
  seedUser('buyer-openid');
  const alSeller = await payCallback.main(alipayNotify({ seller_id: 'seller-evil' }), {});
  assert('A2/seller_id 不一致/返回 400', !!alSeller && alSeller.httpCode === 400 && alSeller.body === 'fail');
  assert('A2/seller_id 不一致/订单未变', state.orderUpdates.length === 0 && state.orders[0].status === 'pending');

  // 12.4 缺 app_id → 400（缺字段按不一致处理）
  reset();
  seedOrder({ orderId: 'AL-1', channel: 'alipay' });
  seedUser('buyer-openid');
  const alNoApp = await payCallback.main(alipayNotify({ app_id: undefined }), {});
  assert('A2/缺 app_id/返回 400', !!alNoApp && alNoApp.httpCode === 400 && alNoApp.body === 'fail');
  assert('A2/缺 app_id/订单未变', state.orderUpdates.length === 0 && state.orders[0].status === 'pending');
  /* ---------- 11. A1：微信回调伪造/验签/金额（客户端直调必须打不进来） ---------- */
  // 改前：只要 event.payment.paySign 存在就入账，且微信分支 amountFen 恒为 undefined
  // 跳过金额比对 ⇒ 小程序端 callFunction 可直接把任意订单改成 paid。
  const wechatBlock = cbSrc.slice(cbSrc.indexOf('async function handleWeChat'), cbSrc.indexOf('function assertWechatPlatformInvocation'));
  assert(
    'A1/源码锚点/微信分支先做来源校验再写库',
    wechatBlock.indexOf('assertWechatPlatformInvocation()') >= 0 &&
      wechatBlock.indexOf('assertWechatPlatformInvocation()') < wechatBlock.indexOf('confirmOrderPaid({')
  );
  assert(
    'A1/源码锚点/微信分支调用验签且验签在建单前',
    wechatBlock.indexOf('verifyWechatNotify(event)') >= 0 &&
      wechatBlock.indexOf('verifyWechatNotify(event)') < wechatBlock.indexOf('confirmOrderPaid({')
  );
  assert(
    'A1/源码锚点/微信分支把金额透传给 confirmOrderPaid',
    /resolveWechatAmountFen\(event, orderId\)/.test(wechatBlock) && /amountFen\s*\n?/.test(wechatBlock) &&
      /confirmOrderPaid\([^)]*amountFen/s.test(wechatBlock)
  );
  assert('A1/源码锚点/来源校验显式拒绝 wx_client', /source === 'wx_client'/.test(cbSrc));

  // 11.1 小程序客户端来源（SOURCE=wx_client）伪造回调 → 拒绝且不写库
  reset();
  seedOrder({ orderId: 'ORDER-SPOOF' });
  seedUser('buyer-openid');
  wxCtx.SOURCE = 'wx_client';
  const rSpoof = await fireCallback('ORDER-SPOOF');
  wxCtx.SOURCE = 'wx_server';
  assert('A1/客户端直调/返回失败', !!rSpoof && rSpoof.code === -1);
  assert('A1/客户端直调/订单未被置 paid', state.orderUpdates.length === 0);
  assert('A1/客户端直调/用户权益未被发放', state.userUpdates.length === 0);

  // 11.2 无 SOURCE 但带用户 OPENID（客户端伪造的另一形态）→ 拒绝
  reset();
  seedOrder({ orderId: 'ORDER-SPOOF2' });
  seedUser('buyer-openid');
  const savedSource = wxCtx.SOURCE;
  delete wxCtx.SOURCE;
  const rSpoof2 = await fireCallback('ORDER-SPOOF2');
  wxCtx.SOURCE = savedSource;
  assert('A1/无来源带 OPENID/返回失败', !!rSpoof2 && rSpoof2.code === -1);
  assert('A1/无来源带 OPENID/订单未被置 paid', state.orderUpdates.length === 0);

  // 11.3 金额不一致 → 拒绝入账
  reset();
  seedOrder({ orderId: 'ORDER-CHEAP', price: 900 });
  seedUser('buyer-openid');
  const rCheap = await payCallback.main(
    { payment: { paySign: 'stub' }, outTradeNo: 'ORDER-CHEAP', transactionId: 'T1', totalFee: 1 },
    {}
  );
  assert('A1/金额不一致/返回失败', !!rCheap && rCheap.code === -1);
  assert('A1/金额不一致/订单未被置 paid', state.orderUpdates.length === 0);

  // 11.4 回调缺金额 → 主动查单；查单也没 total_fee → 拒绝（fail-closed）
  reset();
  seedOrder({ orderId: 'ORDER-NOFEE' });
  seedUser('buyer-openid');
  const rNoFee = await payCallback.main(
    { payment: { paySign: 'stub' }, outTradeNo: 'ORDER-NOFEE', transactionId: 'T1' },
    {}
  );
  assert('A1/缺金额且查单无 total_fee/返回失败', !!rNoFee && rNoFee.code === -1);
  assert('A1/缺金额且查单无 total_fee/订单未被置 paid', state.orderUpdates.length === 0);

  // 11.5 带微信签名头但未配置平台公钥 → 拒绝（有签名头就必须验过）
  reset();
  seedOrder({ orderId: 'ORDER-SIGNED' });
  seedUser('buyer-openid');
  const rSigned = await payCallback.main(
    {
      payment: { paySign: 'stub' },
      outTradeNo: 'ORDER-SIGNED',
      transactionId: 'T1',
      totalFee: 900,
      body: '{}',
      headers: {
        'Wechatpay-Signature': 'ZmFrZQ==',
        'Wechatpay-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Wechatpay-Nonce': 'n1'
      }
    },
    {}
  );
  assert('A1/带签名头但无公钥/返回失败', !!rSigned && rSigned.code === -1 && /signature invalid/.test(String(rSigned.error)));
  assert('A1/带签名头但无公钥/订单未被置 paid', state.orderUpdates.length === 0);

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
