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
 *   - totalAmount      金额，单位：分（微信支付单位是分）
 *   - subject          订单标题
 *   - attach           可选，附加数据（异步通知原样返回）
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const PLANS = {
  earlybird_monthly: { price: 690, label: '晨报·早鸟月付' },
  monthly: { price: 990, label: '晨报·月付' },
  yearly: { price: 8800, label: '晨报·年付' }
};

exports.main = async (event) => {
  // createOrder 经 cloud.callFunction 调用时被调函数拿不到 WXContext，
  // 优先用显式传入的 event.openid，其次才回落 getWXContext（兼容直接触发）
  const { OPENID } = cloud.getWXContext();
  const openid = event.openid || OPENID;
  const { planId, orderId, totalAmount, subject, attach } = event;

  if (!openid) throw new Error('no openid');
  if (!orderId) throw new Error('orderId required');

  const plan = PLANS[planId];
  const label = subject || (plan ? plan.label : '晨报订阅');
  const fee = Number(totalAmount);
  if (!fee || fee < 1) throw new Error('invalid totalAmount');

  try {
    const res = await cloud.cloudPay.unifiedOrder({
      body: label,
      outTradeNo: orderId,
      totalFee: fee,
      feeType: 'CNY',
      subMchId: cloud.DYNAMIC_CURRENT_ENV.includes('prod')
        ? process.env.PAY_WX_SUB_MCH_ID || ''
        : '',
      attach: attach || '',
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
