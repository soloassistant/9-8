/**
 * 三通道支付前端统一门面
 *
 * 三端自动路由：
 *   微信小程序  → wechat（wx.requestPayment，openid 由云函数自动取）
 *   支付宝小程序 → alipay（my.tradePay，需 buyerId）
 *   抖音小程序  → douyin（tt.requestPayment，需 openid）
 *   H5          → 不支持真实支付，getPayChannel() 返回 null
 *
 * 通道特定标识符：
 *   - wechat：无（openid 由 cloud.getWXContext() 拿）
 *   - alipay：buyerId（2088 开头 userId）—— my.getAuthCode → 服务端换 alipay.system.oauth.token
 *   - douyin：openid —— tt.login → 服务端 code2Session（auth-douyin 云函数，2026-10-21 已落地）
 *     ⚠️ 抖音支付未设独立沙箱，联调直接在正式环境；上线前需配齐 PAY_DY_* 云环境变量
 */

import Taro from '@tarojs/taro';
import type { PayChannel, CreateOrderResult } from '@/types';

/** 云函数 callFunction 返回的 result 字段结构（auth-alipay / auth-douyin 统一格式） */
interface CloudResult {
  ok: boolean;
  buyerId?: string;
  openid?: string;
  error?: string;
  [k: string]: unknown;
}

/** 当前运行环境对应的支付通道；H5 不支持真实支付返回 null */
export function getPayChannel(): PayChannel | null {
  // Taro 4 编译目标值：weapp / alipay / tt / h5
  const env = process.env.TARO_ENV;
  if (env === 'weapp') return 'wechat';
  if (env === 'alipay') return 'alipay';
  if (env === 'tt') return 'douyin';
  return null; // h5 或其他
}

/** 支付宝小程序运行时全局对象（Taro 类型未声明，用 unknown 收窄） */
interface AlipayRuntime {
  getAuthCode?: (opt: { scopes: string[]; success?: (r: { authCode?: string }) => void; fail?: (e: unknown) => void }) => void;
  tradePay?: (opt: { tradeNO: string; success?: () => void; fail?: (e: { errMsg?: string } | null) => void }) => void;
}
/** 抖音小程序运行时全局对象 */
interface DouyinRuntime {
  requestPayment?: (opt: { prepayId: string; success?: () => void; fail?: (e: { errMsg?: string } | null) => void }) => void;
}

/** 从 globalThis 安全取小程序平台原生全局对象（绕过 direct cast，unknown 先行收窄） */
function getPlatformRuntime<T>(key: 'my' | 'tt'): T | undefined {
  const g = globalThis as unknown as Record<string, unknown>;
  const v = g[key];
  return v as T | undefined;
}

/**
 * 拉起支付前的通道特定鉴权。
 * wechat 无额外需求（openid 由云函数拿），直接返回 null。
 * alipay 拿 buyerId（2088 开头 userId），douyin 拿 openid。
 *
 * 真实链路（2026-10-21 已落地云函数）：
 *   - alipay：my.getAuthCode({ scopes:['auth_user'] }) → authCode
 *             → callFunction('auth-alipay', { authCode }) → buyerId
 *   - douyin：tt.login() → code → callFunction('auth-douyin', { code }) → openid
 *   - wechat：Taro.login() 可选，但云函数 pay-wechat 用 cloud.getWXContext() 自动拿
 */
export async function getChannelAuth(
  channel: PayChannel
): Promise<{ buyerId?: string; openid?: string } | null> {
  if (channel === 'wechat') return null;

  // 微信云开发 callFunction 在非 weapp 端（alipay/tt）需要先初始化 cloud
  // 这里安全地包一层：cloud 不可用 → 返回空字符串（上游会用这个值调 createOrder，云函数内有兜底）
  const callCloud = async (name: string, data: Record<string, unknown>): Promise<CloudResult | null> => {
    // Taro.cloud 类型仅 weapp 端声明，非 weapp 端用 unknown 收窄避免 any
    const tUnknown = Taro as unknown as { cloud?: unknown };
    const cloud = tUnknown.cloud as { callFunction?: (opt: { name: string; data?: unknown }) => Promise<unknown> } | undefined;
    if (!cloud || typeof cloud.callFunction !== 'function') {
      console.warn('[pay] Taro.cloud.callFunction unavailable');
      return null;
    }
    try {
      const res = await cloud.callFunction({ name, data });
      // callFunction 返回结构 { result, errMsg }
      const r = res as { result?: unknown } | null;
      return ((r && r.result != null) ? r.result : res) as CloudResult;
    } catch (e) {
      console.warn('[pay] cloud.callFunction(' + name + ') failed:', e);
      return null;
    }
  };

  if (channel === 'alipay') {
    if (process.env.TARO_ENV !== 'alipay') {
      return { buyerId: '' };
    }
    try {
      const runtime = getPlatformRuntime<AlipayRuntime>('my');
      if (!runtime?.getAuthCode) {
        console.warn('[pay] my.getAuthCode unavailable');
        return { buyerId: '' };
      }
      const authCode = await new Promise<string | undefined>((resolve, reject) => {
        runtime.getAuthCode!({
          scopes: ['auth_user'],
          success: (r) => resolve(r.authCode),
          fail: (e) => reject(e)
        });
      });
      if (!authCode) return { buyerId: '' };

      // 调 auth-alipay 云函数换 buyerId（2088 开头）
      const result = await callCloud('auth-alipay', { authCode });
      if (result && result.ok && result.buyerId) {
        console.log('[pay] ✅ alipay buyerId 已获取');
        return { buyerId: result.buyerId, openid: result.buyerId };
      }
      console.warn('[pay] auth-alipay 返回异常:', result?.error || result);
      return { buyerId: '' };
    } catch (e) {
      console.warn('[pay] alipay getAuthCode → auth-alipay 失败:', e);
      return { buyerId: '' };
    }
  }

  if (channel === 'douyin') {
    if (process.env.TARO_ENV !== 'tt') {
      return { openid: '' };
    }
    try {
      const codeRes = await Taro.login();
      const code = codeRes.code;
      if (!code) return { openid: '' };

      // 调 auth-douyin 云函数换 openid
      const result = await callCloud('auth-douyin', { code });
      if (result && result.ok && result.openid) {
        console.log('[pay] ✅ douyin openid 已获取');
        return { openid: result.openid };
      }
      console.warn('[pay] auth-douyin 返回异常:', result?.error || result);
      return { openid: '' };
    } catch (e) {
      console.warn('[pay] douyin login → auth-douyin 失败:', e);
      return { openid: '' };
    }
  }

  return null;
}

/**
 * 调起小程序原生支付。
 * @param channel 当前编译目标对应的通道
 * @param payment createOrder 云函数返回的 payment 对象
 * @returns Promise：成功 resolve，失败 reject（用户取消也算 reject，调用方可区分）
 */
export function invokePayment(
  channel: PayChannel,
  payment: CreateOrderResult['payment']
): Promise<{ success: boolean; errMsg?: string }> {
  return new Promise((resolve, reject) => {
    if (channel === 'wechat') {
      const wp = payment.wechatPay;
      if (!wp) {
        reject(new Error('缺少 wechatPay 参数'));
        return;
      }
      // Taro 类型滞后：provider 字段仅 weapp 微信支付场景有效，当前类型定义未包含
      Taro.requestPayment({
        // @ts-expect-error — provider 为微信小程序真实运行时需要，但 Taro 类型定义缺失
        provider: 'wxpay',
        timeStamp: wp.timeStamp,
        nonceStr: wp.nonceStr,
        package: wp.package,
        signType: wp.signType as 'RSA' | 'MD5',
        paySign: wp.paySign,
        success: () => resolve({ success: true }),
        fail: (err: { errMsg?: string } | null) => reject(new Error(err?.errMsg || 'wx.requestPayment failed'))
      });
      return;
    }

    if (channel === 'alipay') {
      // 支付宝小程序原生 API：my.tradePay({ tradeNO })
      if (process.env.TARO_ENV !== 'alipay') {
        reject(new Error('alipay payment only available in alipay build target'));
        return;
      }
      const tradeNO = payment.tradeNO;
      if (!tradeNO) {
        reject(new Error('缺少 tradeNO 参数'));
        return;
      }
      const myGlobal = getPlatformRuntime<AlipayRuntime>('my');
      if (!myGlobal || typeof myGlobal.tradePay !== 'function') {
        reject(new Error('my.tradePay unavailable'));
        return;
      }
      myGlobal.tradePay({
        tradeNO,
        success: () => resolve({ success: true }),
        fail: (err: { errMsg?: string } | null) => reject(new Error(err?.errMsg || 'my.tradePay failed'))
      });
      return;
    }

    if (channel === 'douyin') {
      if (process.env.TARO_ENV !== 'tt') {
        reject(new Error('douyin payment only available in tt build target'));
        return;
      }
      const prepayId = payment.prepayId;
      if (!prepayId) {
        reject(new Error('缺少 prepayId 参数'));
        return;
      }
      const ttGlobal = getPlatformRuntime<DouyinRuntime>('tt');
      if (!ttGlobal || typeof ttGlobal.requestPayment !== 'function') {
        reject(new Error('tt.requestPayment unavailable'));
        return;
      }
      ttGlobal.requestPayment({
        prepayId,
        success: () => resolve({ success: true }),
        fail: (err: { errMsg?: string } | null) => reject(new Error(err?.errMsg || 'tt.requestPayment failed'))
      });
      return;
    }

    reject(new Error('unknown channel: ' + channel));
  });
}
