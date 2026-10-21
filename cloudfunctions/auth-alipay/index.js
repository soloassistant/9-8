/**
 * 支付宝小程序 authCode → buyerId（2088 开头 user_id）
 *
 * 前端流程：
 *   1. 支付宝小程序 my.getAuthCode({ scopes: ['auth_user'] }) 拿到 authCode
 *   2. 调 callFunction('auth-alipay', { authCode })
 * 本云函数流程：
 *   3. 调 alipay.system.oauth.token 把 authCode 换成 user_id（= buyerId，2088 开头）
 *
 * 接口契约（https://opendocs.alipay.com/open/02xtla）：
 *   grant_type=authorization_code & code={authCode} & app_id={PAY_ALIPAY_APP_ID}
 *   响应：{ user_id: '2088xxxxxx', access_token: '...', ... }
 *
 * 云环境变量：
 *   PAY_ALIPAY_APP_ID     — 小程序 AppID
 *   PAY_ALIPAY_PRIVATE_KEY — 应用私钥（PKCS#8）
 *   PAY_ALIPAY_PUBLIC_KEY  — 支付宝开放平台公钥（验签）
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const appId = process.env.PAY_ALIPAY_APP_ID || '';
const privateKey = process.env.PAY_ALIPAY_PRIVATE_KEY || '';
const publicKey = process.env.PAY_ALIPAY_PUBLIC_KEY || '';

exports.main = async (event) => {
  const authCode = (event.authCode || '').trim();
  if (!authCode) {
    return { ok: false, error: 'missing authCode' };
  }
  if (!appId || !privateKey) {
    return { ok: false, error: 'server misconfig: PAY_ALIPAY_APP_ID/PRIVATE_KEY missing' };
  }

  let AlipaySdk;
  try {
    AlipaySdk = require('alipay-sdk').default;
  } catch (e) {
    return { ok: false, error: 'alipay-sdk not installed' };
  }

  const sdk = new AlipaySdk({
    appId,
    privateKey,
    alipayPublicKey: publicKey || undefined
  });

  try {
    // exec 用于通用接口调用；auth 类型接口必须用 system.oauth.token（不用 sdkExecute/pageExec）
    const res = await sdk.exec('alipay.system.oauth.token', {
      grant_type: 'authorization_code',
      code: authCode
    });

    // SDK 响应形如 { user_id, access_token, token_type, expires_in, ... }
    // 或者被包裹在 { data: { ... } }（看 SDK 版本）
    const data = res && res.user_id ? res : (res && res.data ? res.data : res);
    const buyerId = data && data.user_id;
    if (!buyerId) {
      console.warn('[auth-alipay] 响应无 user_id:', JSON.stringify(res));
      return { ok: false, error: 'no user_id in response', raw: res };
    }
    console.log('[auth-alipay] ✅ buyerId=' + buyerId);
    return { ok: true, buyerId, openid: buyerId };
  } catch (e) {
    console.warn('[auth-alipay] 调用异常:', e.message);
    return { ok: false, error: e.message };
  }
};
