/**
 * 微信小程序支付云函数
 *
 * 功能：wx.cloud.cloudPay.unifiedOrder（云开发内置，最简洁）
 *      返回 paySign 等参数给前端 Taro.requestPayment
 *
 * 配置方式：云开发控制台 → 云环境设置 → 微信支付 → 绑定商户号 + 上传 API 密钥/证书
 *          云函数代码里无需硬编码任何敏感字段
 *
 * @param {object} event
 *   - orderId          本地订单号（ord_xxx）
 *   - internalToken    必填，createOrder 用 PAY_INTERNAL_TOKEN 签发的 HMAC（客户端无法伪造）
 *   - attach           可选，附加数据（异步通知原样返回）
 *   金额 / 套餐 / openid 一律从 orders 读，入参里的 totalAmount / planId / openid 会被忽略
 */

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PLANS = {
  earlybird_monthly: { price: 690, label: '晨报·早鸟月付' },
  monthly: { price: 990, label: '晨报·月付' },
  yearly: { price: 8800, label: '晨报·年付' }
};

/**
 * A3：金额/套餐/归属一律以 orders 为准，入参 totalAmount / planId / openid 全部忽略。
 * 客户端 callFunction 直调无法伪造 internalToken（HMAC 密钥只在云环境变量里）。
 */
function signInternalToken(orderId) {
  const secret = process.env.PAY_INTERNAL_TOKEN || '';
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update('pay:' + orderId).digest('hex');
}

function verifyInternalToken(orderId, token) {
  const expect = signInternalToken(orderId);
  const got = String(token || '');
  if (!expect || got.length !== expect.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expect, 'utf8'));
  } catch (e) {
    return false;
  }
}

/** 校验内部调用并返回可信订单；任何入参金额/套餐/买家标识都不参与 */
async function loadOrderForPayment(event, ctxOpenid, channel) {
  const orderId = event && event.orderId;
  if (!orderId) throw new Error('orderId required');
  if (!verifyInternalToken(orderId, event.internalToken)) {
    throw new Error('拒绝未授权调用：internalToken 无效（仅允许 createOrder 内部调用）');
  }
  const snap = await db.collection('orders').where({ orderId }).get();
  const order = snap.data && snap.data[0];
  if (!order) throw new Error('订单不存在: ' + orderId);
  if (order.channel && order.channel !== channel) {
    throw new Error('订单通道不匹配: order=' + order.channel + ' fn=' + channel);
  }
  if (ctxOpenid && order.openid !== ctxOpenid) {
    throw new Error('订单归属不匹配');
  }
  const fee = Number(order.price);
  if (!Number.isFinite(fee) || fee < 1) throw new Error('订单金额异常: ' + order.price);
  return order;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 云函数间 cloud.callFunction 拿不到 WXContext（OPENID 为空）时靠 internalToken 鉴权；
  // 前端直连不仅有 OPENID，还必须有合法 internalToken，二者都校验。
  const order = await loadOrderForPayment(event, OPENID, 'wechat');
  const orderId = order.orderId;
  const openid = order.openid;
  const fee = Number(order.price);
  const plan = PLANS[order.planId];
  const label = plan ? plan.label : '晨报订阅';

  try {
    const res = await cloud.cloudPay.unifiedOrder({
      body: label,
      outTradeNo: orderId,
      totalFee: fee,
      feeType: 'CNY',
      // subMchId 仅服务商模式（有多个商户号）需要；直连商户留空字符串。
      // 读取 PAY_WX_SUB_MCH_ID 环境变量，不按 env 名猜（env 名里出现 'prod' 不代表是生产）。
      subMchId: process.env.PAY_WX_SUB_MCH_ID || '',
      attach: (event && event.attach) || '',
      envId: cloud.DYNAMIC_CURRENT_ENV,
      functionName: 'pay-callback'
    });

    // cloudPay.unifiedOrder 返回：{ payment: { timeStamp, nonceStr, package, signType, paySign } }
    if (res && res.payment && res.payment.paySign) {
      return {
        ok: true,
        channel: 'wechat',
        payment: res.payment,
        orderId,
        openid
      };
    }
    throw new Error('wx.cloudPay 响应格式异常: ' + JSON.stringify(res));
  } catch (err) {
    // cloudPay 在商户号未绑定、密钥未上传、环境不支持时会抛错
    const msg = (err && err.errMsg) || err.message || String(err);
    throw new Error(`wx.cloudPay.unifiedOrder 失败: ${msg}`);
  }
};
