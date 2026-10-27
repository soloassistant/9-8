/**
 * 查询当前用户订单列表云函数（微信小程序端）
 *
 * 调用方：**小程序端**会员中心的「订阅记录」。
 *
 * ⚠️ H5 不再走这里（2026-10-27）：网页端没有 `Taro.cloud`，调不到微信云函数，
 *    所以 H5 的订阅记录改读 WorkBuddy 云数据库的 `orders` 表
 *    （见 src/services/cloudOrders.ts）。两边各存各的订单，不要混用：
 *    H5 订单不在这个云开发库里，这个函数也读不到 WorkBuddy 云的表。
 *    在 H5 恢复「重试」入口之前，先确认它真的有通道 —— 否则又是一个永远点不成功的按钮。
 *
 * @param {object} event
 *   - limit   可选，默认 20，区间 [1, 50]
 *   - skip    可选，分页偏移，负数按 0 处理
 *
 * @returns {object} { ok, orders: OrderSummary[], count }
 *   OrderSummary = { orderId, channel, planId, status, price, months, createTime,
 *                    paidTime, refundStatus, alipayTradeNo }
 *   count = **本页返回条数**，不是总条数（没做 count 查询；分页请自己按 skip 累加）
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/** 云数据库对负数 limit/skip 会直接报错，而这两个值来自前端、不可信 */
function clampLimit(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}
function clampSkip(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: 'no openid' };

  const limit = clampLimit(event.limit);
  const skip = clampSkip(event.skip);

  try {
    const res = await db
      .collection('orders')
      .where({ openid: OPENID })
      .orderBy('createTime', 'desc')
      .skip(skip)
      .limit(limit)
      .get();

    const orders = res.data.map(summarize);
    return { ok: true, orders, count: orders.length };
  } catch (err) {
    console.error('[ordersList] 查询失败:', err.message);
    return { ok: false, error: err.message || String(err) };
  }
};

function summarize(o) {
  // price 是分值；缺字段时 Number(undefined)/100 = NaN，序列化后前端会渲染成「¥null」
  const fen = Number(o.price);
  return {
    orderId: o.orderId,
    channel: o.channel || 'wechat',
    planId: o.planId,
    price: Number.isFinite(fen) ? fen / 100 : 0, // 元（前端好展示）
    months: o.months,
    status: o.status, // created / paid / closed / failed
    payStatus: o.payStatus,
    refundStatus: o.refundStatus || 'none', // none / refunding / refunded / refund_failed
    createTime: o.createTime,
    paidTime: o.paidTime || null,
    alipayTradeNo: o.alipayTradeNo || null,
    douyinPrepayId: o.douyinPrepayId || null,
    isEarlyBird: o.planId === 'earlybird_monthly'
  };
}
