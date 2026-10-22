/**
 * 查询当前用户订单列表云函数
 *
 * 调用方：前端 mine 页「订阅记录」入口
 *
 * @param {object} event
 *   - limit   可选，默认 20，最大 50
 *   - skip    可选，分页偏移
 *
 * @returns {object} { ok, orders: OrderSummary[] }
 *   OrderSummary = { orderId, channel, planId, status, price, months, createTime,
 *                    paidTime, refundStatus, alipayTradeNo }
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_LIMIT = 50;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: 'no openid' };

  const limit = Math.min(Number(event.limit) || 20, MAX_LIMIT);
  const skip = Number(event.skip) || 0;

  try {
    const res = await db
      .collection('orders')
      .where({ openid: OPENID })
      .orderBy('createTime', 'desc')
      .skip(skip)
      .limit(limit)
      .get();

    const orders = res.data.map(summarize);
    return { ok: true, orders, total: orders.length };
  } catch (err) {
    console.error('[ordersList] 查询失败:', err.message);
    return { ok: false, error: err.message || String(err) };
  }
};

function summarize(o) {
  return {
    orderId: o.orderId,
    channel: o.channel || 'wechat',
    planId: o.planId,
    price: Number(o.price) / 100,           // 元（前端好展示）
    months: o.months,
    status: o.status,                        // created / paid / closed / failed
    payStatus: o.payStatus,
    refundStatus: o.refundStatus || 'none',  // none / refunding / refunded / refund_failed
    createTime: o.createTime,
    paidTime: o.paidTime || null,
    alipayTradeNo: o.alipayTradeNo || null,
    douyinPrepayId: o.douyinPrepayId || null,
    isEarlyBird: o.planId === 'earlybird_monthly'
  };
}
