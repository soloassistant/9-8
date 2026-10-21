import type { CreateOrderResult } from '@/types';
import type { CreateOrderPayload } from '@/services/api';

/**
 * mock: createOrder —— H5 降级返回（无微信上下文，走不到真实云函数）。
 * 返回结构与云函数 createOrder 对齐，前端调用方无须区分来源。
 */
export default function createOrder(payload?: CreateOrderPayload): CreateOrderResult {
  const planId = payload?.planId || 'earlybird_monthly';
  const channel = payload?.channel || 'wechat';
  const priceMap: Record<typeof planId, number> = {
    earlybird_monthly: 6.9,
    monthly: 9.9,
    yearly: 88
  };
  const priceYuan = priceMap[planId] ?? 0;
  const orderId = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  console.info('[mock:createOrder] plan:', planId, 'channel:', channel);

  // 三通道各自的 mock payment 参数（结构同真实云函数）
  const payment: CreateOrderResult['payment'] = { channel };
  if (channel === 'wechat') {
    payment.wechatPay = {
      timeStamp: String(Math.floor(Date.now() / 1000)),
      nonceStr: 'mock_nonce_' + Math.random().toString(36).slice(2, 16),
      package: 'prepay_id=wx_mock_prepay_id',
      signType: 'RSA',
      paySign: 'MOCK_PAY_SIGN'
    };
  } else if (channel === 'alipay') {
    payment.tradeNO = 'MOCK_ALIPAY_TRADE_NO_' + Date.now();
  } else if (channel === 'douyin') {
    payment.prepayId = 'MOCK_DOUYIN_PREPAY_ID_' + Date.now();
  }

  return {
    ok: true,
    orderId,
    planId,
    price: priceYuan,
    channel,
    payment,
    status: 'created'
  };
}
