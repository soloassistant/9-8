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
 *   4. 通道幂等：微信用 outRefundNo（订单号 + 退款序号），支付宝用 out_request_no
 *   5. 退款成功 → 扣减订阅到期时间（months 按比例折算；简化处理：直接置 expiredAt 为订阅前值）
 *
 * @param {object} event
 *   - orderId     必填，本地订单号 ord_xxx
 *   - refundAmountFen  可选，退款金额（分），默认全额
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

  // ========== 3. 状态校验 ==========
  if (order.status !== 'paid') {
    return { ok: false, error: '订单未支付或已处理' };
  }
  if (order.refundStatus === 'refunded' || order.refundStatus === 'refunding') {
    return { ok: false, error: '订单退款处理中或已退款' };
  }

  // ========== 4. 金额校验 ==========
  const orderAmount = Number(order.price); // 分
  const refundAmount = refundAmountFen ? Number(refundAmountFen) : orderAmount;
  if (!refundAmount || refundAmount < 1) {
    return { ok: false, error: '退款金额无效' };
  }
  if (refundAmount > orderAmount) {
    return { ok: false, error: '退款金额超过订单金额' };
  }

  // ========== 5. 按通道路由 ==========
  const channel = order.channel || 'wechat';
  const refundNo = `refund_${orderId}_${Date.now()}`;
  const refundReason = (reason || '用户申请退款').slice(0, 200);

  // 先把订单标记为 refunding（避免并发重复退款）
  await db.collection('orders').doc(order._id).update({
    data: { refundStatus: 'refunding', refundNo, refundAmount, refundReason, refundTime: new Date().toISOString() }
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
        await db.collection('orders').doc(order._id).update({
          data: { refundStatus: 'pending', refundNo: null, refundAmount: null, refundReason: null, refundTime: null }
        });
        return channelResult;
      default:
        throw new Error('未知支付通道: ' + channel);
    }

    // ========== 6. 退款成功回写 ==========
    if (channelResult.ok) {
      await db.collection('orders').doc(order._id).update({
        data: {
          refundStatus: 'refunded',
          refundChannelNo: channelResult.refundNo || null,
          refundFinishTime: new Date().toISOString()
        }
      });
      // 扣减订阅权益：简化处理——重置用户 expiredAt 为订阅前值
      // 精确计算应结合 extendUserExpiredAt 的实际延长；这里用最保守策略
      if (order.months) {
        await rollbackUserSubscription(OPENID, order.months);
      }
      return { ok: true, orderId, channel, refundAmount, refundNo };
    }

    // 通道返回失败：回滚 refundStatus
    await db.collection('orders').doc(order._id).update({
      data: { refundStatus: 'pending', refundNo: null, refundAmount: null, refundReason: null }
    });
    return { ok: false, error: channelResult.message || '通道退款失败', channel };
  } catch (err) {
    console.error('[refundOrder] 异常:', err.message);
    // 异常时保持 refunding 状态 + 记录错误日志，便于人工排查
    await db.collection('orders').doc(order._id).update({
      data: { refundStatus: 'refund_failed', refundError: err.message || String(err) }
    });
    return { ok: false, error: err.message || String(err), channel };
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
