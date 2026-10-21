/**
 * 抖音小程序 code → openid（server-side code2session）
 *
 * 前端流程：
 *   1. 抖音小程序 tt.login() 拿到 code
 *   2. 调 callFunction('auth-douyin', { code })
 * 本云函数流程：
 *   3. POST https://open.douyin.com/api/apps/v1/microapp/code2session/ 换 openid + session_key
 *
 * 接口契约（https://partner.open-douyin.com/docs/.../code2session）：
 *   POST /api/apps/v1/microapp/code2session/
 *   { appid, secret, code }
 *   → { openid, session_key, unionid? }
 *
 * 注意：code 只能用一次，服务端换完立即返回；session_key 由后端保存，不下发前端。
 *
 * 云环境变量：
 *   PAY_DY_APP_ID    — 抖音小程序 AppID
 *   PAY_DY_APP_SECRET — 抖音小程序 AppSecret（不是支付的商户 API 密钥）
 */

const cloud = require('wx-server-sdk');
const https = require('https');
const cloudInit = cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const appId = process.env.PAY_DY_APP_ID || '';
const appSecret = process.env.PAY_DY_APP_SECRET || '';

function httpPost(host, path, bodyObj, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const url = new URL(`https://${host}${path}`);
    const req = https.request({
      host: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

exports.main = async (event) => {
  const code = (event.code || '').trim();
  if (!code) return { ok: false, error: 'missing code' };
  if (!appId || !appSecret) {
    return { ok: false, error: 'server misconfig: PAY_DY_APP_ID/APP_SECRET missing' };
  }

  try {
    // 抖音开放平台 code2session 不需要额外签名（appid + secret + code 明文传）
    const res = await httpPost('open.douyin.com', '/api/apps/v1/microapp/code2session/', {
      appid: appId,
      secret: appSecret,
      code
    });

    // 抖音响应包裹在 { data, message } 里；code=0 表示成功
    const data = res.data || res;
    if (res.code !== 0 && res.code !== undefined) {
      console.warn('[auth-douyin] code2session 失败:', res.message || JSON.stringify(res));
      return { ok: false, error: res.message || 'code2session failed', raw: res };
    }
    const openid = data.openid;
    if (!openid) {
      console.warn('[auth-douyin] 无 openid:', JSON.stringify(res));
      return { ok: false, error: 'no openid in response', raw: res };
    }
    console.log('[auth-douyin] ✅ openid=' + openid);
    return {
      ok: true,
      openid,
      unionid: data.unionid || null
      // session_key 刻意不下发前端：由服务端保存，暴露明文会削弱签名校验安全性
    };
  } catch (e) {
    console.warn('[auth-douyin] 调用异常:', e.message);
    return { ok: false, error: e.message };
  }
};
