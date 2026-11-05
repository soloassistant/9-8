/**
 * 三通道退款云函数
 *
 * 退款接口支持情况：
 *   - wechat  ✅ cloud.cloudPay.refund（云开发内置，最简洁）
 *   - alipay  ✅ alipay.trade.refund（alipay-sdk）
 *   - douyin  ❌ 抖音支付暂未开放小程序 JSAPI 退款接口（2026-10 实测商家平台文档无此接口）
 *             → 返回人工退款指引，由用户联系客服处理
 *
 * 安全要素：
 *   1. 归属校验：退款单必须是当前 openid 的订单（防越权）
 *   2. 状态校验：只有 paid 状态才能退款，已退款/已关闭直接拒绝
 *   3. 金额校验：退款金额 ≤ 订单金额（防超额退款）
 *   4. 幂等：refundNo = R<orderId>-<attempt> 确定性派生，重试/接管永远同一单号（微信 outRefundNo / 支付宝 out_request_no）
 *   5. 调用前落库：refund_attempts._id = refundNo，插入成功才拿到「发起权」，并发只放一个进
 *   6. 10 分钟 stale：接管必须先查通道真实状态；查不清转人工，绝不盲发第二笔
 *   7. 退款成功 → 先落退款事实，再扣减订阅；权益失败不回写退款状态
 *
 * @param {object} event
 *   - orderId     必填，本地订单号 ord_xxx
 *   - refundAmountFen  可选；**只接受等于订单金额**，其他一律拒绝（仅支持全额退款）
 *   - reason      可选，退款原因（最长 200 字，通道原样记录）
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ========== 配置 ==========
const cfg = {
  alipayAppId: process.env.PAY_ALIPAY_APP_ID || '',
  alipayPrivateKey: process.env.PAY_ALIPAY_PRIVATE_KEY || '',
  alipayPublicKey: process.env.PAY_ALIPAY_PUBLIC_KEY || '',
  alipaySellerId: process.env.PAY_ALIPAY_SELLER_ID || '',
  alipayEnv: process.env.PAY_ALIPAY_ENV === 'sandbox' ? 'sandbox' : 'prod'
};
const ALIPAY_GATEWAY = cfg.alipayEnv === 'sandbox'
  ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
  : 'https://openapi.alipay.com/gateway.do';
const REFUND_STALE_MS = 10 * 60 * 1000; // stale 接管阈值：10 分钟
const ATTEMPTS = 'refund_attempts';

// ========== 主入口 ==========
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('no openid');

  const { orderId, refundAmountFen, reason } = event;
  if (!orderId) throw new Error('orderId required');

  // ========== 1. 查订单 ==========
  const orderRes = await db.collection('orders').where({ orderId }).limit(1).get();
  if (!orderRes.data || orderRes.data.length === 0) {
    return { ok: false, error: '订单不存在' };
  }
  const order = orderRes.data[0];

  // ========== 2. 归属校验 ==========
  if (order.openid !== OPENID) {
    return { ok: false, error: '无权限操作此订单' };
  }

  // ========== 3. 状态校验（R4 状态机）==========
  if (order.status === 'refunded' || order.refundStatus === 'refunded') {
    return { ok: true, orderId, alreadyRefunded: true }; // 幂等：已退款不再触达通道
  }
  if (order.status !== 'paid') {
    return { ok: false, error: '订单未支付或已处理' };
  }
  const now = Date.now();
  if (order.refundStatus === 'refunding') {
    const lockAt = Date.parse(order.refundLockAt || order.refundTime || '');
    // 锁未过期 → 处理中；过期 → 走 stale 接管（复用旧单号，先查单）
    if (Number.isFinite(lockAt) && now - lockAt < REFUND_STALE_MS) {
      return { ok: false, error: '订单退款处理中或已退款', processing: true };
    }
  }

  // ========== 4. 金额校验：仅支持全额退款 ==========
  // 当前状态机只有一个 refunded 终态，权益也按整单 months 全额回滚；
  // 允许部分退款会造成「退 1 分却撤全部权益」，且剩余金额因终态再也退不了。
  // 因此显式拒绝任何非全额请求，且必须在写订单 / 落尝试记录 / 调通道之前返回。
  const orderAmount = Number(order.price); // 分
  if (refundAmountFen !== undefined && refundAmountFen !== null && Number(refundAmountFen) !== orderAmount) {
    return { ok: false, error: '仅支持全额退款' };
  }
  const refundAmount = orderAmount;
  if (!refundAmount || refundAmount < 1) {
    return { ok: false, error: '退款金额无效' };
  }

  // ========== 5. 幂等键 + 调用前落库 ==========
  const channel = order.channel || 'wechat';
  const prevAttempt = Number(order.refundAttempt) || 0;
  // 上次已把单号发往通道（失败/超时）→ 复用同一单号；只有确认通道无此单才 +1
  const reuse = !!order.refundNo && (order.refundStatus === 'refund_failed' || order.refundStatus === 'refunding');
  const attempt = reuse ? prevAttempt : prevAttempt + 1;
  const refundNo = reuse ? order.refundNo : deriveRefundNo(orderId, attempt);
  const refundReason = (reason || '用户申请退款').slice(0, 200);

  // refund_attempts._id 唯一 = 并发锁：插入成功才允许发起通道调用
  const reservation = await reserveAttempt({
    orderId, openid: OPENID, channel, attempt, refundNo,
    amountFen: refundAmount, status: 'pending', createTime: new Date(now).toISOString()
  });
  if (!reservation.created) {
    const handled = await handleExistingAttempt(reservation.existing, { order, refundNo, refundAmount, now });
    if (handled) return handled;
  }

  await db.collection('orders').doc(order._id).update({
    data: {
      refundStatus: 'refunding', refundAttempt: attempt, refundNo, refundAmount, refundReason,
      refundTime: order.refundTime || new Date(now).toISOString(), refundLockAt: new Date(now).toISOString()
    }
  });

  try {
    let channelResult;
    switch (channel) {
      case 'wechat':
        channelResult = await refundWechat({ orderId, orderAmount, refundAmount, refundNo, refundReason });
        break;
      case 'alipay':
        channelResult = await refundAlipay({ order, refundAmount, refundNo, refundReason });
        break;
      case 'douyin':
        // 抖音支付暂不开放退款接口 → 返回人工指引
        channelResult = { ok: false, manualRefund: true, message: '抖音支付暂不支持小程序自动退款，请联系客服处理' };
        // 抖音的 refundStatus 改回 pending（未退款），让订单仍处于 paid 状态
        await markAttempt(refundNo, { status: 'failed', lastError: 'douyin manual refund' });
        await db.collection('orders').doc(order._id).update({
          data: {
            refundStatus: 'pending', refundNo: null, refundAmount: null, refundReason: null, refundTime: null,
            refundManualReason: 'douyin 通道不支持自动退款，需人工'
          }
        });
        return channelResult;
      default:
        throw new Error('未知支付通道: ' + channel);
    }

    // ========== 6. 通道明确失败 ==========
    if (!channelResult.ok) {
      await markAttempt(refundNo, { status: 'failed', lastError: String(channelResult.message || '通道退款失败').slice(0, 200) });
      await db.collection('orders').doc(order._id).update({
        data: { refundStatus: 'refund_failed', refundError: channelResult.message || '通道退款失败', refundLockAt: null }
      });
      return { ok: false, error: channelResult.message || '通道退款失败', channel };
    }

    // ========== 7. 两段提交：先落退款事实，再算权益 ==========
    await markAttempt(refundNo, { status: 'accepted', thirdPartyNo: channelResult.refundNo || refundNo, finishTime: new Date().toISOString() });
    await finalizeRefunded(order, refundNo, channelResult.refundNo);
    return { ok: true, orderId, channel, refundAmount, refundNo };
  } catch (err) {
    // 结果未知（可能已发到通道）：保持 refunding + pending，绝不写成「一键重试」的失败态
    console.error('[refundOrder] 通道结果未知:', err.message);
    await markAttempt(refundNo, { lastError: String(err.message || err).slice(0, 200), lastAttemptAt: new Date().toISOString() });
    // 只落人工对账原因，供后台看见；不加用户侧重试入口
    await db.collection('orders').doc(order._id).update({
      data: { refundManualReason: '通道结果未知，需人工对账（未重发）' }
    }).catch(() => {});
    return { ok: false, error: err.message || String(err), channel, unknown: true };
  }
};

// ========== 通道退款实现 ==========

async function refundWechat({ orderId, orderAmount, refundAmount, refundNo, refundReason }) {
  // cloudPay.refund 参数参考官方文档：
  // https://developers.weixin.qq.com/miniprogram/dev/wxcloud/reference-sdk-api/openapi/cloudPay/refund.html
  const res = await cloud.cloudPay.refund({
    outTradeNo: orderId,
    outRefundNo: refundNo,
    totalFee: Number(orderAmount),       // 原订单总金额（分），微信强制要求
    refundFee: refundAmount,              // 退款金额（分）
    refundDesc: refundReason,
    subMchId: process.env.PAY_WX_SUB_MCH_ID || '',
    envId: cloud.DYNAMIC_CURRENT_ENV
  });
  if (res && res.status === 'SUCCESS') {
    return { ok: true, refundNo: res.refundId };
  }
  return { ok: false, message: (res && res.errMsg) || '微信退款失败' };
}

async function refundAlipay({ order, refundAmount, refundNo, refundReason }) {
  if (!cfg.alipayAppId || !cfg.alipayPrivateKey || !cfg.alipayPublicKey) {
    return { ok: false, message: '支付宝退款未配置（缺少环境变量）' };
  }
  const AlipaySdk = require('alipay-sdk').default;
  const alipay = new AlipaySdk({
    appId: cfg.alipayAppId,
    privateKey: cfg.alipayPrivateKey,
    alipayPublicKey: cfg.alipayPublicKey,
    gateway: ALIPAY_GATEWAY
  });

  // 用 tradeNo（已回填在 pay-callback 或 pay-alipay 返回值里）
  const tradeNo = order.alipayTradeNo;
  if (!tradeNo) return { ok: false, message: '订单缺少支付宝 trade_no，无法退款' };

  const yuan = (refundAmount / 100).toFixed(2);
  const result = await alipay.exec('alipay.trade.refund', {
    bizContent: {
      out_trade_no: order.orderId,
      trade_no: tradeNo,
      refund_amount: yuan,
      out_request_no: refundNo,
      refund_reason: refundReason
    }
  });

  const resp = result && result.alipay_trade_refund_response;
  if (resp && resp.code === '10000') {
    return { ok: true, refundNo: resp.gmt_refund_pay || refundNo };
  }
  return { ok: false, message: (resp && resp.msg) || '支付宝退款失败' };
}

// ========== 辅助：回滚用户订阅 ==========

async function rollbackUserSubscription(openid, monthsToRollback) {
  const users = db.collection('users');
  const userRes = await users.where({ openid }).limit(1).get();
  if (!userRes.data || !userRes.data.length) return;
  const user = userRes.data[0];

  // 简化策略：订阅到期时间 - months × 30 天（安全边界，精确计算可后续优化）
  const rollbackMs = monthsToRollback * 30 * 24 * 60 * 60 * 1000;
  let newExpiredAt;
  if (user.expiredAt) {
    const original = new Date(user.expiredAt).getTime() - rollbackMs;
    newExpiredAt = new Date(original).toISOString();
  } else {
    newExpiredAt = new Date(Date.now() - rollbackMs).toISOString();
  }

  // 如果回滚后已早于当前时间 → 取消订阅
  const now = Date.now();
  const isStillSubscribed = new Date(newExpiredAt).getTime() > now;

  await users.doc(user._id).update({
    data: {
      expiredAt: newExpiredAt,
      subscribed: isStillSubscribed,
      updatedAt: new Date().toISOString()
    }
  });
}

// ========== R4 幂等：尝试记录 / 确定性单号 / stale 查单 ==========

/** 确定性派生：同一订单同一 attempt 永远同一单号（≤64 字节） */
function deriveRefundNo(orderId, attempt) {
  const safe = String(orderId).replace(/[^A-Za-z0-9_-]/g, '');
  return `R${safe}-${String(attempt).padStart(2, '0')}`.slice(0, 64);
}

/** 调用前插入尝试记录；_id 冲突 = 已有尝试，返回 existing */
async function reserveAttempt(meta) {
  try {
    await db.collection(ATTEMPTS).add({ data: Object.assign({ _id: meta.refundNo }, meta) });
    return { created: true, existing: null };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (err && (err.errCode === -1 || /duplicate|主键冲突|已存在/i.test(msg))) {
      let existing = null;
      try {
        existing = (await db.collection(ATTEMPTS).doc(meta.refundNo).get()).data || null;
      } catch (e) {
        if (e && e.errCode !== -1) throw e;
      }
      return { created: false, existing };
    }
    throw err;
  }
}

async function markAttempt(refundNo, patch) {
  await db.collection(ATTEMPTS).doc(refundNo).update({ data: patch }).catch((err) => {
    console.error('[refundOrder] 尝试记录回写失败:', refundNo, err.message);
  });
}

/**
 * 已存在尝试：accepted → 补写终态并幂等返回；pending 未超时 → 处理中；
 * pending 已超时 → 先查通道，查不清转人工；failed / 确认无此单 → 同号重发（通道幂等）。
 * @returns 已处理则返回业务结果；null 表示可以继续发起
 */
async function handleExistingAttempt(existing, { order, refundNo, refundAmount, now }) {
  if (!existing) return null;
  if (existing.status === 'accepted') {
    await finalizeRefunded(order, refundNo, existing.thirdPartyNo);
    return { ok: true, orderId: order.orderId, alreadyRefunded: true, refundNo };
  }
  const createdAt = Date.parse(existing.createTime || existing.lastAttemptAt || '');
  if (existing.status === 'pending' && Number.isFinite(createdAt) && now - createdAt < REFUND_STALE_MS) {
    return { ok: false, error: '订单退款处理中或已退款', processing: true };
  }
  if (existing.status !== 'pending') return null;

  const snap = await queryRefundState(existing.channel || order.channel, order, refundNo);
  if (snap.state === 'accepted') {
    await markAttempt(refundNo, { status: 'accepted', thirdPartyNo: snap.thirdPartyNo, finishTime: new Date().toISOString() });
    await finalizeRefunded(order, refundNo, snap.thirdPartyNo);
    return { ok: true, orderId: order.orderId, recovered: true, refundNo };
  }
  if (snap.state !== 'not_found') {
    await db.collection('orders').doc(order._id).update({
      data: { refundManualReason: '退款结果未知，需人工对账（未发起第二笔）' }
    }).catch(() => {});
    return { ok: false, manualReconcile: true, error: '退款结果未知，需人工对账后再处理（未发起第二笔）', refundNo };
  }
  return null; // 通道确认无此单 → 同号重发，不会产生第二笔
}

/** 查通道退款真实状态：accepted / not_found / unknown（unknown 一律不重发） */
async function queryRefundState(channel, order, refundNo) {
  try {
    // 支付宝查询需要额外 SDK 调用，当前一律转人工（宁可不动钱）
    if (channel !== 'wechat') return { state: 'unknown' };
    if (typeof cloud.cloudPay.queryRefund === 'function') {
      const res = await cloud.cloudPay.queryRefund({
        outRefundNo: refundNo,
        subMchId: process.env.PAY_WX_SUB_MCH_ID || '',
        envId: cloud.DYNAMIC_CURRENT_ENV
      });
      const code = String((res && (res.errCode || res.err_code)) || '');
      if (res && res.status === 'SUCCESS') return { state: 'accepted', thirdPartyNo: res.refundId };
      if (/NOT[_-]?FOUND|NOT[_-]?EXIST/i.test(code + String((res && res.errMsg) || ''))) return { state: 'not_found' };
      return { state: 'unknown' };
    }
    // 退到查单：REFUND 是全额退款终态，其余一律"未知"（不能据此重发）
    const res = await cloud.cloudPay.queryOrder({
      outTradeNo: order.orderId,
      subMchId: process.env.PAY_WX_SUB_MCH_ID || '',
      nonce_str: String(Date.now())
    });
    const state = (res && (res.trade_state || res.tradeState)) || '';
    return state === 'REFUND' ? { state: 'accepted', thirdPartyNo: res.transactionId } : { state: 'unknown' };
  } catch (err) {
    console.error('[refundOrder] 查退款状态失败:', err.message);
    return { state: 'unknown' };
  }
}

/** 退款事实落地 + 权益回滚（第二段，权益失败不得改写退款状态） */
async function finalizeRefunded(order, refundNo, thirdPartyNo) {
  await db.collection('orders').doc(order._id).update({
    data: {
      status: 'refunded',
      refundStatus: 'refunded',
      refundChannelNo: thirdPartyNo || refundNo,
      refundFinishTime: new Date().toISOString(),
      refundLockAt: null
    }
  });
  try {
    if (order.months) await rollbackUserSubscription(order.openid, order.months);
  } catch (err) {
    console.error('[refundOrder] 权益回滚失败（交对账重试）:', err.message);
    await db.collection('orders').doc(order._id).update({
      data: { entitlementRollbackStatus: 'failed', entitlementRollbackError: String(err.message || err).slice(0, 200) }
    }).catch(() => {});
  }
}
