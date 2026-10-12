const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PLANS = {
  earlybird_monthly: { price: 690, months: 1, label: '早鸟月付' },
  monthly: { price: 990, months: 1, label: '月付' },
  yearly: { price: 8800, months: 12, label: '年付' }
};

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 取不到微信上下文就拒绝：订单表以 openid 归属，openid 为 undefined 会产出无主订单，
  // 后续 payCallback 延长订阅时长时无法定位到人。
  if (!OPENID) throw new Error('no openid');
  const planId = event && event.planId;
  const plan = PLANS[planId];
  if (!plan) throw new Error('invalid planId');

  // 早鸟资格校验：前 500 名（按订单数计）
  if (planId === 'earlybird_monthly') {
    const countRes = await db
      .collection('orders')
      .where({ planId: 'earlybird_monthly', status: 'paid' })
      .count();
    if (countRes.total >= 500) {
      throw new Error('earlybird quota exhausted');
    }
  }

  const orderId = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const order = {
    orderId,
    openid: OPENID,
    planId,
    price: plan.price,
    months: plan.months,
    status: 'created',
    createTime: new Date().toISOString()
  };

  // TODO：主体资质与商户号就绪后，接入 cloud.cloudPay.unifiedOrder 统一下单，
  // 并新增 payCallback 云函数：支付成功回调中把订单置为 paid、延长 users.expiredAt、早鸟置 isEarlyBird。
  await db.collection('orders').add({ data: order });

  return {
    orderId,
    planId,
    price: plan.price / 100,
    status: 'created'
  };
};
