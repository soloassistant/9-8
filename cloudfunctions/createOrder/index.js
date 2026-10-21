/**
 * 创建订阅订单 + 路由到对应支付通道下单
 *
 * 原功能不变：planId 校验、早鸟额度守卫、落 orders 集合。
 * 新增：channel 路由分发到 pay-wechat / pay-alipay / pay-douyin 云函数，
 *      三通道支付参数回填订单，返回统一 payment 结构给前端调起。
 *
 * 多通道买家标识映射：
 *   - wechat  → openid（cloud.getWXContext()）
 *   - alipay  → buyerId（event.buyerId，2088 开头 userId）
 *   - douyin  → openid（event.openid，抖音小程序 code2Session 换得）
 *
 * 调用方：前端订阅页，运行在 Taro getEnv() 对应编译目标
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PLANS = {
  earlybird_monthly: { price: 690, months: 1, label: '早鸟月付' },
  monthly: { price: 990, months: 1, label: '月付' },
  yearly: { price: 8800, months: 12, label: '年付' }
};

const VALID_CHANNELS = ['wechat', 'alipay', 'douyin'];

exports.main = async (event) => {
  // ========== 0. 基础校验 ==========
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('no openid');

  const planId = event && event.planId;
  const plan = PLANS[planId];
  if (!plan) throw new Error('invalid planId: ' + planId);

  const channel = (event && event.channel) || 'wechat';
  if (!VALID_CHANNELS.includes(channel)) {
    throw new Error('invalid channel: ' + channel + '，可选 wechat / alipay / douyin');
  }

  // 通道特定入参校验
  if (channel === 'alipay' && !event.buyerId) {
    throw new Error('alipay 通道需要 buyerId（2088 开头的支付宝 userId）');
  }
  if (channel === 'douyin' && !event.openid) {
    throw new Error('douyin 通道需要 openid（抖音小程序 code → code2Session）');
  }

  // ========== 1. 早鸟额度守卫 ==========
  if (planId === 'earlybird_monthly') {
    const countRes = await db
      .collection('orders')
      .where({ planId: 'earlybird_monthly', status: 'paid' })
      .count();
    if (countRes.total >= 500) {
      throw new Error('earlybird quota exhausted');
    }
  }

  // ========== 2. 创建本地订单 ==========
  const totalAmountFen = plan.price;                       // 单位：分（3 通道统一内部用分）
  const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const order = {
    orderId,
    openid: OPENID,
    channel,                                                 // 新增：支付通道
    planId,
    price: totalAmountFen,                                   // 分
    months: plan.months,
    status: 'created',
    payStatus: 'pending',                                    // 新增：待通道支付
    createTime: new Date().toISOString()
  };
  if (channel === 'alipay') order.buyerId = event.buyerId;
  if (channel === 'douyin') order.douyinOpenid = event.openid;

  // 保留 add() 返回的文档 _id：第 4 步回填必须按 _id 寻址。
  // orderId 是业务号不是文档 _id，doc(orderId) 会打到不存在的文档上（回填静默丢失）。
  const addRes = await db.collection('orders').add({ data: order });

  // ========== 3. 路由到对应支付云函数 ==========
  const channelPayload = buildChannelPayload({ channel, order, plan, event, totalAmountFen });
  let payResult;
  try {
    payResult = await cloud.callFunction({
      name: 'pay-' + channel,
      data: channelPayload
    });
  } catch (callErr) {
    // 订单已落库，但通道下单失败。保留订单让用户重试，不自动删除。
    throw new Error(`[pay-${channel}] 下单失败: ${callErr.message || callErr.errMsg || String(callErr)}；订单已创建 ${orderId}，可重试`);
  }

  if (!payResult || !payResult.result || !payResult.result.ok) {
    throw new Error(`[pay-${channel}] 下单返回异常: ${JSON.stringify(payResult && payResult.result)}`);
  }

  // ========== 4. 回填订单的通道支付参数 ==========
  const channelResult = payResult.result;
  const patch = { channelPayStatus: 'pending' };
  if (channel === 'alipay') patch.alipayTradeNo = channelResult.tradeNo;
  if (channel === 'douyin') patch.douyinPrepayId = channelResult.prepayId;
  if (channel === 'wechat') patch.wechatPayment = channelResult.payment;

  await db.collection('orders').doc(addRes._id).update({ data: patch });

  // ========== 5. 返回给前端 ==========
  return {
    ok: true,
    orderId,
    planId,
    price: totalAmountFen / 100,                              // 元
    channel,
    payment: buildClientPayment(channel, channelResult, orderId),
    status: 'created'
  };
};

/** 构造各通道支付云函数入参 */
function buildChannelPayload({ channel, order, plan, event, totalAmountFen }) {
  const base = {
    planId: order.planId,
    orderId: order.orderId,
    totalAmount: totalAmountFen,                              // 统一传分，通道内部自行转元
    subject: plan.label,
    attach: JSON.stringify({ orderId: order.orderId, months: order.months })
  };
  if (channel === 'alipay') base.buyerId = event.buyerId;
  if (channel === 'douyin') base.openid = event.openid;
  // wechat：云函数间 cloud.callFunction 拿不到 WXContext，必须显式把 openid 传给 pay-wechat
  //（否则 pay-wechat 的 OPENID 校验必抛 'no openid'，微信支付整链在第 3 步挂掉）
  if (channel === 'wechat') base.openid = order.openid;
  return base;
}

/** 构造前端消费的统一 payment 结构 */
function buildClientPayment(channel, channelResult, orderId) {
  if (channel === 'wechat') {
    // Taro.requestPayment({ provider: 'wxpay', ...payment })
    return {
      channel,
      wechatPay: channelResult.payment                         // { timeStamp, nonceStr, package, signType, paySign }
    };
  }
  if (channel === 'alipay') {
    // my.tradePay({ tradeNO: '...', success, fail })
    return {
      channel,
      alipayTradeNo: channelResult.tradeNo,
      tradeNO: channelResult.tradeNo                          // 前端直接用的字段名
    };
  }
  if (channel === 'douyin') {
    // 抖音小程序 Taro.requestPayment 或原生 JSB
    return {
      channel,
      douyinPrepayId: channelResult.prepayId,
      prepayId: channelResult.prepayId
    };
  }
  throw new Error('unknown channel: ' + channel);
}
