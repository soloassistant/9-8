/**
 * 抖音小程序 JSAPI 支付云函数
 *
 * 功能：POST https://api.douyinpay.com/v1/pay/jsapi/order
 *      返回 prepay_id 给抖音小程序调起 ttcjpay.dypay
 *
 * 契约来源：
 *   - 签名认证：https://pay.douyinpay.com/wiki/66aa57118a7da602efb9bc2f/66aa574888f38d02f9de20da
 *   - JSAPI 下单：https://pay.douyinpay.com/wiki/427lmayi/v602fr05
 *   - 抖音支付**未设立独立沙箱环境**，直接在正式环境联调
 *
 * 关键实现：
 *   - 签名串 5 行：METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY\n
 *   - 签名算法：SHA256WithRSA（商户 API 私钥）→ Base64
 *   - Authorization 头：DouyinPay-RSA mchid="...",nonce_str="...",timestamp="...",serial_no="...",signature="..."
 *   - 金额单位：**分**（和支付宝元不同！）
 *   - 时间戳：秒级 Unix
 *   - 抖音小程序 JSAPI 还需要：tt.login 拿 code → 服务端 code2Session 拿 openid（调用方传进来）
 *
 * @param {object} event
 *   - planId           套餐 ID
 *   - orderId          本地订单号
 *   - totalAmount      金额，单位：分
 *   - subject          商品描述
 *   - openid           必填，抖音用户 openid（抖音小程序 code → code2Session）
 *   - notifyUrl        可选，通知地址
 *   - attach           可选
 */

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const PLANS = {
  earlybird_monthly: { price: 690, months: 1, label: '晨报·早鸟月付' },
  monthly: { price: 990, months: 1, label: '晨报·月付' },
  yearly: { price: 8800, months: 12, label: '晨报·年付' }
};

// ========== 配置 ==========
// 通过云环境变量配置，永不硬编码
//   PAY_DY_APP_ID         抖音开放平台应用 ID
//   PAY_DY_MCHID          抖音支付商户号
//   PAY_DY_PRIVATE_KEY    商户 API 私钥（PKCS#8，BEGIN PRIVATE KEY）
//   PAY_DY_SERIAL_NO      商户 API 公钥证书序列号
//   PAY_DY_NOTIFY_URL     异步通知 URL（https://）
const cfg = {
  appId: process.env.PAY_DY_APP_ID || '',
  mchid: process.env.PAY_DY_MCHID || '',
  privateKey: process.env.PAY_DY_PRIVATE_KEY || '',
  serialNo: process.env.PAY_DY_SERIAL_NO || '',
  notifyUrl: process.env.PAY_DY_NOTIFY_URL || '',
  host: 'api.douyinpay.com',
  path: '/v1/pay/jsapi/order',
  scheme: 'https:'
};

// ========== 工具函数 ==========

function genNonceStr(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function buildSignature(method, path, timestamp, nonce, bodyStr) {
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  return signer.sign(cfg.privateKey, 'base64');
}

function buildAuthorization(nonce, timestamp, signature) {
  return 'DouyinPay-RSA '
    + `mchid="${cfg.mchid}",`
    + `nonce_str="${nonce}",`
    + `timestamp="${timestamp}",`
    + `serial_no="${cfg.serialNo}",`
    + `signature="${signature}"`;
}

function httpPostJson(host, path, bodyObj, authorization) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const url = `${cfg.scheme}//${host}${path}`;

    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      timeout: 10000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          resolve({ status: res.statusCode, data });
        } catch (e) {
          reject(new Error(`抖音响应解析失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('抖音支付请求超时')); });
    req.write(bodyStr);
    req.end();
  });
}

// ========== 主入口 ==========

exports.main = async (event) => {
  const { planId, orderId, totalAmount, subject, openid, notifyUrl, attach } = event;

  // 校验配置
  if (!cfg.appId || !cfg.mchid || !cfg.privateKey || !cfg.serialNo) {
    throw new Error('抖音支付配置缺失，请设置 PAY_DY_* 云环境变量');
  }

  // 校验入参
  if (!orderId) throw new Error('orderId required');
  if (!openid) throw new Error('openid required（抖音小程序 code 换得）');

  const plan = PLANS[planId];
  if (!plan) throw new Error('invalid planId: ' + planId);

  // 金额：直接用分（抖音单位是分，和微信一致）
  const amountFen = Number(totalAmount);
  if (!amountFen || amountFen < 1) throw new Error('invalid totalAmount');

  // 构造请求体
  const body = {
    appid: cfg.appId,
    mchid: cfg.mchid,
    description: subject || plan.label,
    out_trade_no: orderId,
    notify_url: notifyUrl || cfg.notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
    payer: { openid },
    time_expire: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      .replace(/\.\d{3}Z$/, '+08:00'),  // RFC 3339
    attach: attach || '',
    settle_info: { profit_sharing: false }
  };

  // 签名
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = genNonceStr();
  const bodyStr = JSON.stringify(body);
  const signature = buildSignature('POST', cfg.path, timestamp, nonce, bodyStr);
  const authorization = buildAuthorization(nonce, timestamp, signature);

  // 发送请求
  const { status, data } = await httpPostJson(cfg.host, cfg.path, body, authorization);

  // 判定结果
  if (status === 200 && data && data.prepay_id) {
    return {
      ok: true,
      channel: 'douyin',
      prepayId: data.prepay_id,
      orderId,
      totalAmount: amountFen
    };
  }

  // 抖音错误响应：{ code: "PARAM_ERROR", message: "...", detail: {...} }
  const code = data && data.code;
  const msg = data && data.message;
  const detail = data && data.detail;
  throw new Error(`抖音下单失败[HTTP ${status}] code=${code} msg=${msg} detail=${JSON.stringify(detail || {})}`);
};
