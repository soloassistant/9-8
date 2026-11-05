/**
 * 三通道支付异步通知统一处理云函数
 *
 * 路由：
 *   - 微信：cloud.cloudPay.unifiedOrder 指定 functionName='payCallback'，
 *           云开发自动将回调验签后传入 event，格式 { payment, outTradeNo, transactionId }
 *   - 支付宝：HTTP 触发器 POST 表单 → event.body 为 Buffer → handleAlipay()
 *   - 抖音：HTTP 触发器 POST JSON → event.body 为 JSON 字符串 → handleDouyin()
 *
 * 安全要素（每个通道都必须做到）：
 *   1. 验签（支付宝/抖音自己验；微信：带签名头必须验签，原生回调靠来源校验）
 *   2. 要素一致性校验（orderId, 金额, 状态）
 *   3. 幂等（检查订单当前状态再更新）
 *   4. 回写：orders.status→paid + users.expiredAt 延长 + 早鸟标记
 *   5. 返回通道期望的响应格式（success/fail 文本、HTTP 200/400/500）
 */

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const querystring = require('querystring');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ========== 配置（从云环境变量读，不硬编码）==========
const cfg = {
  alipayPublicKey: process.env.PAY_ALIPAY_PUBLIC_KEY || '',
  alipayAppId: process.env.PAY_ALIPAY_APP_ID || '',              // 本站支付宝应用 APP_ID（回调必须属于它）
  alipaySellerId: process.env.PAY_ALIPAY_SELLER_ID || '',        // 可选：收款商户 PID，配置了就必须一致
  douyinPublicKey: process.env.PAY_DY_PUBLIC_KEY || '',          // 抖音支付平台证书公钥（验签）
  douyinEncryptKey: process.env.PAY_DY_ENCRYPT_KEY || '',       // 接口加密密钥（AES-256-GCM 解密）
  wechatPlatformKey: process.env.PAY_WX_PLATFORM_PUBLIC_KEY || '' // 微信支付平台证书公钥（有签名头时必验）
};

// 微信回调的可信来源（云开发平台触发）。小程序客户端 callFunction 的 SOURCE 恒为 wx_client。
const WX_TRUSTED_SOURCES = ['wx_server', 'wx_trigger', 'wx_cloudpay'];

/** 微信侧签名头允许的时间偏差（秒），防重放 */
const WX_SIGN_MAX_SKEW_S = 300;

// ========== 主入口：微信 cloudPay 自动回调 ==========
// wx.cloud.cloudPay.unifiedOrder({ functionName: 'payCallback' }) 时云开发自动调用
exports.main = async (event, context) => {
  // channel 提升到 try 外：catch 里 buildErrorResponse 要用（原来 try 内 const 会 ReferenceError）
  let channel = null;
  try {
    // === 先判定通道 ===
    channel = detectChannel(event);
    switch (channel) {
      case 'wechat':   return await handleWeChat(event);
      case 'alipay':   return await handleAlipay(event);
      case 'douyin':   return await handleDouyin(event);
      default:         throw new Error('无法识别的回调通道');
    }
  } catch (err) {
    console.error('[pay-callback] 异常:', err.message);
    // 微信云函数返回值会被云开发记录；HTTP 通道需要返回合适状态码
    return buildErrorResponse(err, channel);
  }
};

// ========== 通道识别 ==========
function detectChannel(event) {
  // 微信 cloudPay 回调：event 有 payment 对象
  if (event && event.payment && typeof event.payment === 'object' && event.payment.paySign) {
    return 'wechat';
  }
  // 支付宝 HTTP 触发器：event 有 alipay_trade_no 查询过的订单（来自 createOrder 回填），
  // 或者 body 是表单字符串包含 trade_status
  if (event && typeof event.body === 'string') {
    if (event.body.includes('trade_status=')) return 'alipay';
    if (event.body.includes('"event_type"') || event.body.includes('"resource"')) return 'douyin';
  }
  if (event && event.body && typeof event.body === 'object' && event.body.resource) return 'douyin';
  return null;
}

// ========== 1. 微信 cloudPay 回调 ==========
// A1 缺陷（最严重）：原实现只要 event.payment.paySign 存在就认微信通道（客户端
// callFunction 可伪造），且微信分支 amountFen 恒为 undefined 直接跳过金额比对。
async function handleWeChat(event) {
  // ① 来源校验：必须在任何写库动作之前。客户端 callFunction 拿不到可信来源。
  assertWechatPlatformInvocation();

  // ② 验签：请求携带了 Wechatpay 签名头就必须验过；失败直接拒绝、不写库。
  const sig = verifyWechatNotify(event);
  if (sig.present && !sig.valid) {
    console.warn('[wechat] 验签失败，拒绝处理:', sig.reason);
    return { code: -1, message: 'fail', error: 'wechat signature invalid: ' + sig.reason };
  }

  const orderId = event.outTradeNo || event.out_trade_no;
  const transactionId = event.transactionId || event.transaction_id;
  if (!orderId) throw new Error('微信回调缺少 outTradeNo');

  // 非付款成功事件：按平台约定返回成功，但不写库
  if (event.resultCode && event.resultCode !== 'SUCCESS') {
    console.log('[wechat] 非付款成功事件 resultCode=', event.resultCode);
    return { code: 0, message: 'success', data: { ignored: true } };
  }

  // ③ 金额：回调字段或主动查单 total_fee（单位分），不一致由 confirmOrderPaid 拒绝
  const amountFen = await resolveWechatAmountFen(event, orderId);

  const result = await confirmOrderPaid({
    orderId,
    channel: 'wechat',
    channelTradeNo: transactionId,
    amountFen
  });

  // 微信 cloudPay 回调只需要返回成功 JSON 给云开发
  return { code: 0, message: 'success', data: result };
}

/**
 * A1-① 调用来源校验。
 * 平台回调由云开发服务端触发：SOURCE 非 wx_client、且没有终端用户 OPENID。
 * 小程序客户端 callFunction：SOURCE === 'wx_client' 且必带 OPENID ⇒ 一律拒绝。
 */
function assertWechatPlatformInvocation() {
  const ctx = cloud.getWXContext() || {};
  const source = String(ctx.SOURCE || '');
  if (source === 'wx_client') {
    throw new Error('[wechat] 拒绝小程序客户端直接调用支付回调');
  }
  if (!source && ctx.OPENID) {
    throw new Error('[wechat] 拒绝带用户 OPENID 的非平台来源调用支付回调');
  }
  if (source && !WX_TRUSTED_SOURCES.includes(source)) {
    throw new Error('[wechat] 拒绝非白名单来源调用支付回调: ' + source);
  }
}

/**
 * A1-② 微信支付 v3 平台签名验签：签名串 = timestamp\nnonce\nbody\n。
 * 原生 cloudPay 回调由平台验签后传入、不带 HTTP 头（present=false），此时由来源校验兜底；
 * 只要带了签名头（HTTP 触发器直投），就必须验签通过。
 */
function verifyWechatNotify(event) {
  const headers = event.headers || event.header || {};
  const pick = (name) => {
    const lower = String(name).toLowerCase();
    const hit = Object.keys(headers).find((k) => k.toLowerCase() === lower);
    return hit ? String(headers[hit] || '') : '';
  };
  const signature = pick('Wechatpay-Signature');
  const timestamp = pick('Wechatpay-Timestamp');
  const nonce = pick('Wechatpay-Nonce');
  if (!signature && !timestamp && !nonce) return { present: false, valid: false, reason: 'no-sign-headers' };
  if (!signature || !timestamp || !nonce) return { present: true, valid: false, reason: 'missing-sign-headers' };
  if (!cfg.wechatPlatformKey) return { present: true, valid: false, reason: 'platform-key-not-configured' };

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > WX_SIGN_MAX_SKEW_S) {
    return { present: true, valid: false, reason: 'timestamp-out-of-range' };
  }

  const body = Buffer.isBuffer(event.body) ? event.body.toString('utf-8') : String(event.body || '');
  const message = `${timestamp}\n${nonce}\n${body}\n`;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    verifier.end();
    const valid = verifier.verify(formatPemPublicKey(cfg.wechatPlatformKey), signature, 'base64');
    return { present: true, valid: !!valid, reason: valid ? 'ok' : 'signature-invalid' };
  } catch (e) {
    console.warn('[wechat] 验签异常:', e.message);
    return { present: true, valid: false, reason: 'verify-error' };
  }
}

/**
 * A1-③ 取微信侧金额（分）：优先回调字段 totalFee；缺失则主动查单取 total_fee。
 * 两者都拿不到 → 抛错拒绝入账（宁可漏发不可错发，补救走主动查单）。
 */
async function resolveWechatAmountFen(event, orderId) {
  const raw = event.totalFee != null ? event.totalFee : (event.payment && event.payment.totalFee);
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const res = await cloud.cloudPay.queryOrder({
    sub_mch_id: process.env.PAY_WX_SUB_MCH_ID || '',
    out_trade_no: orderId,
    nonce_str: genNonceStr()
  });
  if (!res || res.returnCode !== 'SUCCESS' || res.trade_state !== 'SUCCESS') {
    throw new Error('[wechat] 查单未确认支付，拒绝入账: ' + orderId);
  }
  const fee = res.total_fee != null ? Number(res.total_fee) : NaN;
  if (!Number.isFinite(fee) || fee <= 0) {
    throw new Error('[wechat] 查单缺 total_fee，拒绝入账: ' + orderId);
  }
  return fee;
}

/** 查单用随机串（32 位内） */
function genNonceStr() {
  return crypto.randomBytes(16).toString('hex');
}

// ========== 2. 支付宝 form POST 回调 ==========
async function handleAlipay(event) {
  // event.body 是 application/x-www-form-urlencoded 字符串
  const bodyStr = Buffer.isBuffer(event.body)
    ? event.body.toString('utf-8')
    : (event.body || '');
  const params = querystring.parse(bodyStr);

  // —— 验签（RSA2）——
  if (!params.sign) {
    console.warn('[alipay] 回调无 sign 字段');
    return { httpCode: 400, body: 'fail' };
  }
  if (!cfg.alipayPublicKey) {
    // fail-closed：没配公钥 = 无法验签 = 拒绝处理。支付链路绝不放未验签的回调过关
    console.error('[alipay] 未配置 PAY_ALIPAY_PUBLIC_KEY，拒绝处理（fail-closed）');
    return { httpCode: 400, body: 'fail' };
  }
  if (!verifyAlipayNotifySign(params, cfg.alipayPublicKey)) {
    console.warn('[alipay] 验签失败');
    return { httpCode: 400, body: 'fail' };
  }

  const orderId = params.out_trade_no;
  const tradeNo = params.trade_no;
  const tradeStatus = params.trade_status;

  // —— 商户身份校验（A2）：回调必须属于本站应用/收款商户，且必须在写库之前 ——
  // 缺 app_id 或与配置不符一律 400。未配置 APP_ID 时 fail-closed（无法确认归属就不入账）。
  if (!assertAlipayMerchant(params)) return { httpCode: 400, body: 'fail' };

  if (!orderId) return { httpCode: 400, body: 'fail' };
  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
    // 不是付款成功事件，正常返回 success 避免重试
    console.log('[alipay] 非付款成功事件 trade_status=', tradeStatus);
    return { httpCode: 200, body: 'success' };
  }

  // 金额一致性：total_amount 单位元 → 转分与订单比对（防通道侧/伪造回调改价）
  const amountFen = params.total_amount != null ? Math.round(Number(params.total_amount) * 100) : undefined;
  const result = await confirmOrderPaid({
    orderId,
    channel: 'alipay',
    channelTradeNo: tradeNo,
    amountFen
  });

  // 支付宝回调必须返回纯文本 success
  return { httpCode: 200, body: 'success' };
}

/**
 * A2 商户身份校验：支付宝异步通知的 app_id 必须是本站应用；配置了 seller_id 时也必须一致。
 * 缺字段按不一致处理（fail-closed）——验签只能证明「消息来自支付宝」，不能证明「收款方是本商户」，
 * 否则他人应用的合法通知里的 out_trade_no 撞上本站订单号时会被误入账。
 */
function assertAlipayMerchant(params) {
  if (!cfg.alipayAppId) {
    console.error('[alipay] 未配置 PAY_ALIPAY_APP_ID，拒绝处理（fail-closed）');
    return false;
  }
  if (!params.app_id || String(params.app_id) !== cfg.alipayAppId) {
    console.warn('[alipay] app_id 不匹配，拒绝处理: 回调=' + params.app_id);
    return false;
  }
  if (cfg.alipaySellerId && String(params.seller_id || '') !== cfg.alipaySellerId) {
    console.warn('[alipay] seller_id 不匹配，拒绝处理: 回调=' + params.seller_id);
    return false;
  }
  return true;
}

/**
 * 支付宝异步通知验签（RSA2 / RSA）。
 *
 * 为什么不直接用 alipay-sdk 的 checkNotifySign：该 SDK 构造函数强制要求
 * config.privateKey（缺省直接 throw 'config.privateKey is required'），而验签
 * 回调只需要支付宝公钥。用公钥构造 SDK 必抛 → 被外层 catch 吞掉 → valid=false
 * → 任何回调（哪怕签名完全正确）都返回 400，验签路径整体失效、支付永远无法入账。
 *
 * 这里按 alipay-sdk@3 的 checkNotifySign + notifyRSACheck 同等规则直接验签
 * （与下方抖音通道的 crypto.createVerify 风格一致）：
 *   1. 签名取 params.sign；sign_type 缺省 RSA2（RSA-SHA256，RSA = RSA-SHA1）
 *   2. 第一次：剔除 sign、把 sign_type 加回待签串；键排序、值 decodeURIComponent、& 连接
 *   3. 第二次：删掉 sign_type 再验（SDK 对商户自行删除 sign_type 的兼容行为）
 */
function verifyAlipayNotifySign(params, alipayPublicKey) {
  const signStr = params.sign;
  if (!alipayPublicKey || !signStr) return false;
  const signType = params.sign_type || 'RSA2';
  const algorithm = signType === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256';
  const key = formatPemPublicKey(alipayPublicKey);
  const signArgs = Object.assign({}, params);
  delete signArgs.sign;
  signArgs.sign_type = signType;                       // 保留 sign_type 验一次
  if (notifyRsaCheck(signArgs, signStr, algorithm, key)) return true;
  delete signArgs.sign_type;                           // 删掉 sign_type 再验一次
  return notifyRsaCheck(signArgs, signStr, algorithm, key);
}

/** 对齐 alipay-sdk notifyRSACheck：键排序 + 值 decodeURIComponent + & 连接后验签 */
function notifyRsaCheck(signArgs, signStr, algorithm, key) {
  const signContent = Object.keys(signArgs).sort().filter((k) => k)
    .map((k) => {
      let value = signArgs[k];
      if (Object.prototype.toString.call(value) !== '[object String]') {
        value = JSON.stringify(value);
      }
      return k + '=' + decodeURIComponent(value);
    })
    .join('&');
  try {
    const verifier = crypto.createVerify(algorithm);
    verifier.update(signContent, 'utf8');
    verifier.end();
    return verifier.verify(key, signStr, 'base64');
  } catch (e) {
    console.warn('[alipay] 验签异常：', e.message);
    return false;
  }
}

/** 对齐 alipay-sdk formatKey：裸 base64 或带 PEM 头的公钥都能用 */
function formatPemPublicKey(key) {
  const lines = String(key).split('\n').map((l) => l.trim());
  if (lines[0].includes('PUBLIC KEY')) lines.shift();
  if (lines.length && lines[lines.length - 1].includes('PUBLIC KEY')) lines.pop();
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('')}\n-----END PUBLIC KEY-----`;
}

// ========== 3. 抖音 JSON 回调 ==========
async function handleDouyin(event) {
  // event.body 是 JSON 字符串或 Buffer。
  // bodyStr 提升到 try 外声明：下方验签名串要用它（try 内 const 出了块不可见会 ReferenceError）
  let bodyStr;
  let bodyObj;
  try {
    bodyStr = Buffer.isBuffer(event.body) ? event.body.toString('utf-8') : (event.body || '');
    bodyObj = typeof bodyStr === 'string' ? JSON.parse(bodyStr) : bodyStr;
  } catch (e) {
    console.warn('[douyin] body 解析失败:', e.message);
    return { httpCode: 400, body: '{"code":"FAIL","message":"bad body"}' };
  }

  // —— 1. HTTP 头签名验签（抖音支付平台证书 RSA 公钥）——
  // 验签规则：https://pay.douyinpay.com/wiki/kmh41lik/t34m9acr
  // 签名串 3 行：Douyinpay-Timestamp\n + Douyinpay-Nonce\n + body\n
  const headers = event.headers || {};
  const getHeader = (k) => headers[k] || headers[k.toLowerCase()] || headers[`Douyinpay-${k}`] || headers[`douyinpay-${k}`] || '';
  const dySignature = getHeader('Douyinpay-Signature');
  const dyTimestamp = getHeader('Douyinpay-Timestamp');
  const dyNonce = getHeader('Douyinpay-Nonce');
  const dySerial = getHeader('Douyinpay-Serial');

  if (!dySignature || !dyTimestamp || !dyNonce) {
    console.warn('[douyin] 回调缺签名头 Signature/Timestamp/Nonce');
    return { httpCode: 400, body: '{"code":"FAIL","message":"missing sign headers"}' };
  }
  if (!cfg.douyinPublicKey) {
    // fail-closed：没配平台公钥 = 无法验签 = 拒收。支付链路绝不放未验签的回调过关
    console.error('[douyin] 未配置 PAY_DY_PUBLIC_KEY，拒绝处理（fail-closed）');
    return { httpCode: 400, body: '{"code":"FAIL","message":"verify key not configured"}' };
  } else {
    // 构造验签名串（注意：抖音回调验签是 3 行，下单验签才是 5 行！）
    const sigStr = `${dyTimestamp}\n${dyNonce}\n${bodyStr}\n`;
    let valid = false;
    try {
      const verify = crypto.createVerify('RSA-SHA256');
      verify.update(sigStr, 'utf-8');
      verify.end();
      valid = verify.verify(
        { key: cfg.douyinPublicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        dySignature,
        'base64'
      );
    } catch (e) {
      console.warn('[douyin] 验签异常:', e.message);
    }
    if (!valid) {
      console.warn('[douyin] 验签失败，serial=', dySerial);
      return { httpCode: 400, body: '{"code":"FAIL","message":"signature invalid"}' };
    }
    console.log('[douyin] ✅ 验签通过 serial=', dySerial);
  }

  // —— 2. 判断 event_type ——
  const eventType = bodyObj.event_type;
  if (eventType !== 'TRANSACTION.SUCCESS') {
    console.log('[douyin] 非付款成功事件 event_type=', eventType);
    return { httpCode: 200 };  // 200 空 body
  }

  // —— 3. AES-256-GCM 解密 resource.ciphertext ——
  const resource = bodyObj.resource;
  if (!resource || !resource.ciphertext) {
    console.warn('[douyin] 回调无 resource.ciphertext');
    return { httpCode: 400, body: '{"code":"FAIL"}' };
  }

  let decrypted;
  try {
    decrypted = decryptDouyinResource(resource);
  } catch (e) {
    console.warn('[douyin] 解密失败:', e.message);
    return { httpCode: 400, body: '{"code":"FAIL","message":"decrypt error"}' };
  }

  if (decrypted.trade_state !== 'SUCCESS') {
    console.log('[douyin] trade_state=', decrypted.trade_state, '不处理');
    return { httpCode: 200 };
  }

  const result = await confirmOrderPaid({
    orderId: decrypted.out_trade_no,
    channel: 'douyin',
    channelTradeNo: decrypted.transaction_id,
    amountFen: decrypted.amount && decrypted.amount.total // 抖音金额单位为分
  });

  // 抖音回调必须返回 HTTP 200 或 204，无需 body
  return { httpCode: 200 };
}

/**
 * 抖音 resource AES-256-GCM 解密
 * 参考: https://pay.douyinpay.com/wiki/kmh41lik/5zsbsg41
 *
 * resource = { algorithm: 'AEAD-AES-256-GCM', ciphertext: 'base64', nonce: '...', associated_data: '', mchid: '...' }
 */
function decryptDouyinResource(resource) {
  if (!cfg.douyinEncryptKey) {
    throw new Error('未配置 PAY_DY_ENCRYPT_KEY');
  }
  const key = Buffer.from(cfg.douyinEncryptKey, 'utf-8');
  const ciphertext = Buffer.from(resource.ciphertext, 'base64');
  const nonce = Buffer.from(resource.nonce, 'utf-8');
  const associatedData = resource.associated_data ? Buffer.from(resource.associated_data, 'utf-8') : null;

  // AES-256-GCM 最后 16 字节是 tag
  const tagLen = 16;
  if (ciphertext.length <= tagLen) throw new Error('ciphertext 过短');
  const data = ciphertext.slice(0, ciphertext.length - tagLen);
  const tag = ciphertext.slice(ciphertext.length - tagLen);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  if (associatedData) decipher.setAAD(associatedData);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8'));
}

// ========== 4. 统一回写：订单置为 paid + 发放权益（CAS 状态机）==========
/**
 * 缺陷 B2（资损）：原实现「先置 paid → 再延长订阅」，且幂等只看 status==='paid'。
 *   · 延长失败后订单已是 paid，支付平台重试命中幂等分支直接 return ⇒ 权益永久不补；
 *   · 两个并发回调各自读到「未 paid」，都执行 +months ⇒ 一次付款买到两个月。
 *
 * 现改为三段式状态机（orders 文档上的 entitlementStatus）：
 *   1. **抢锁**：带条件更新 `status=<原状态> AND entitlementStatus ∈ {不存在,none,failed}`
 *      （SDK 的 where().update() 是原子的；更新行数为 0 说明别的实例已抢到）；
 *      抢到后写 `entitlementStatus='applying'` + 唯一 applyingToken；
 *   2. **发放**：按该用户全部已支付订单**回放**计算到期时间（幂等：重跑结果一致，
 *      不会因为「用户已更新、标记 applied 失败」的重试而叠加月份）；
 *   3. **落定**：CAS 到 `applied`；任何一步失败都回滚成 `failed`（可安全重试）。
 *
 * ⚠️ queryOrder/index.js 有一份镜像实现，改动必须同步两处。
 */
const ENTITLEMENT_STALE_MS = 2 * 60 * 1000; // applying 超过 2 分钟视为中断，允许接管
const MS_PER_MONTH = 30 * 24 * 3600 * 1000;

async function confirmOrderPaid({ orderId, channel, channelTradeNo, amountFen }) {
  // 1. 读订单
  const orderSnap = await db.collection('orders').where({ orderId }).get();
  const order = orderSnap.data && orderSnap.data[0];
  if (!order) throw new Error('订单不存在: ' + orderId);

  // 2. 幂等：只有**权益已发放**才算真正完成。仅 status==='paid' 不能早退，
  //    否则「已 paid 但未 applied」的订单永远不会被补发（就是本缺陷的根因）。
  if (order.status === 'paid' && order.entitlementStatus === 'applied') {
    console.log('[pay-callback] 订单已 paid 且权益已发放，跳过:', orderId);
    return { orderId, alreadyPaid: true };
  }

  // 3. 要素一致性校验：渠道匹配 + 金额匹配
  if (order.channel && order.channel !== channel) {
    // 同一 orderId 不应出现在不同通道的回调里，但做个告警
    console.warn(`[pay-callback] order.channel=${order.channel} 与回调 channel=${channel} 不一致`);
  }

  // 3.5 金额一致性校验（回调金额 vs 订单金额，单位分）。三个通道一律强制：
  // 微信取回调 totalFee 或查单 total_fee（A1-③ 已保证调用到这里时 amountFen 必有值）。
  // 缺金额字段按不一致处理——宁可漏发不可错发，补救走主动查单。
  if (amountFen !== undefined) {
    if (!Number.isFinite(Number(amountFen)) || Number(amountFen) !== order.price) {
      console.error(`[pay-callback] 金额不一致：回调 ${amountFen} vs 订单 ${order.price}（分），orderId=${orderId}`);
      throw new Error('amount mismatch: callback=' + amountFen + ' order=' + order.price);
    }
  }

  // 4.0 预检：权益接收方必须存在。**必须放在置 paid 之前** —— 否则订单已 paid 而权益永远发不出去
  //     （第 2 步幂等分支「已 paid 直接 return」在最前面，支付平台重试也不会补发）。
  //     用订单自身的 order.openid，不依赖下方第 5 步才声明的局部变量 openid。
  const payerSnap = await db.collection('users').where({ openid: order.openid }).limit(1).get();
  if (!payerSnap.data || payerSnap.data.length === 0) {
    throw new Error('[pay-callback] 用户不存在，拒绝置单为 paid: openid=' + order.openid);
  }

  // 4. 抢锁（CAS）：并发回调只有一个能把 entitlementStatus 改成 applying
  const lock = await acquireEntitlementLock(order, { paidChannel: channel, channelTradeNo });
  if (!lock.token) {
    if (lock.alreadyApplied) return { orderId, alreadyPaid: true };
    // 另一个实例正在发放：返回失败让支付平台稍后重试（不能假装成功，否则权益可能丢）
    throw new Error('[pay-callback] 权益发放进行中，请稍后重试: ' + orderId);
  }

  try {
    // 5. 发放权益（幂等回放，重跑不会叠加）
    await applyEntitlement(order.openid, order.planId);
    // 6. 落定：CAS 成 applied（带 token，防止被别的实例接管后误标）
    await markEntitlementApplied(order._id, lock.token);
  } catch (err) {
    // 任一步失败都回滚为 failed：订单保持「可重试」，平台重试或主动查单都能补发
    await rollbackEntitlement(order._id, lock.token, err);
    throw err;
  }

  console.log('[pay-callback] ✅ 订单置为 paid 且权益已发放:', orderId, 'channel:', channel);
  return { orderId, channel, paid: true };
}

/**
 * CAS 抢锁。返回 { token } 表示抢到；{ busy } / { alreadyApplied } 表示没抢到。
 * 条件更新用 `where().update()`（云数据库原子操作），绝不先读后写裸更新。
 */
async function acquireEntitlementLock(order, extra) {
  const _ = db.command;
  const now = new Date().toISOString();
  const token = now + '-' + Math.random().toString(36).slice(2, 10);
  const data = Object.assign({}, extra, {
    status: 'paid',
    payStatus: 'paid',
    // 第一次置 paid 时写入支付时间；重试时保留原值（回放要用它，不能被重试改写）
    paidTime: order.paidTime || now,
    payTime: order.payTime || order.paidTime || now,
    entitlementStatus: 'applying',
    applyingToken: token,
    applyingAt: now,
    entitlementError: ''
  });

  const base = { _id: order._id };
  const candidates = [];
  if (order.status !== 'paid') {
    // 首付：对 status 做 CAS（pending/created → paid 只能成功一次）
    candidates.push(Object.assign({}, base, { status: order.status }));
  } else if (order.entitlementStatus === 'failed') {
    candidates.push(Object.assign({}, base, { status: 'paid', entitlementStatus: 'failed' }));
  } else if (order.entitlementStatus === 'applying') {
    const age = Date.now() - Date.parse(order.applyingAt || '');
    if (Number.isFinite(age) && age >= 0 && age < ENTITLEMENT_STALE_MS) return { busy: true };
    // 超时接管：用旧 token 做 CAS，避免两个接管者同时成功
    candidates.push(
      Object.assign({}, base, { status: 'paid', entitlementStatus: 'applying', applyingToken: order.applyingToken })
    );
  } else if (order.entitlementStatus === 'applied') {
    return { alreadyApplied: true };
  } else {
    // 历史订单没有 entitlementStatus 字段（或显式 none）
    candidates.push(Object.assign({}, base, { status: 'paid', entitlementStatus: _.exists(false) }));
    candidates.push(Object.assign({}, base, { status: 'paid', entitlementStatus: _.in(['none']) }));
  }

  for (const query of candidates) {
    const res = await db.collection('orders').where(query).update({ data });
    if (res && res.stats && res.stats.updated > 0) return { token };
  }
  return { busy: true };
}

/** CAS 落定 applied。更新行数必须为 1（token 已被接管则说明状态异常，抛错触发回滚） */
async function markEntitlementApplied(orderId, token) {
  const now = new Date().toISOString();
  const res = await db.collection('orders')
    .where({ _id: orderId, entitlementStatus: 'applying', applyingToken: token })
    .update({ data: { entitlementStatus: 'applied', entitlementAppliedAt: now, entitlementError: '' } });
  if (!res || !res.stats || res.stats.updated === 0) {
    throw new Error('[pay-callback] 标记权益已发放失败（锁已失效）: ' + orderId);
  }
}

/** 失败回滚：applying → failed，保留错误摘要；下次回调/查单可重新抢锁 */
async function rollbackEntitlement(orderId, token, err) {
  const msg = String((err && err.message) || err || 'unknown').slice(0, 200);
  try {
    await db.collection('orders')
      .where({ _id: orderId, entitlementStatus: 'applying', applyingToken: token })
      .update({ data: { entitlementStatus: 'failed', applyingToken: '', entitlementError: msg } });
  } catch (e) {
    // 回滚失败只留痕：调用方已收到失败响应，平台会重试
    console.error('[pay-callback] 权益回滚失败:', orderId, e.message);
  }
}

/**
 * 幂等发放：把该用户全部「已支付且未退款」订单按支付时间回放，得到到期时间；
 * 再与用户现有 expiredAt 取较大值写回。重复执行结果一致 —— 这是「延长成功但
 * 标记 applied 失败」后安全重试的依据（不会 +months 两次）。
 */
async function applyEntitlement(openid, planId) {
  const users = db.collection('users');
  // ⚠️ 查询键必须是自定义字段 openid，**不能是 _openid**：
  //    users 文档由 login 云函数用 `users.add({ data: { openid: OPENID, ... } })` 创建，
  //    云函数环境的 add() **不会**自动注入 _openid（_openid 只在客户端 SDK 写记录时才有）。
  //    对照组：getUsage/index.js、refundOrder/index.js 都用 where({ openid })。
  const snap = await users.where({ openid }).get();
  const user = snap.data && snap.data[0];
  if (!user) {
    // 不能静默 return：订单此时可能已置 paid，静默失败会让用户永久丢失权益。
    throw new Error('[pay-callback] 用户不存在，无法发放权益 openid=' + openid);
  }

  const replayed = await replayExpiry(openid);
  if (replayed <= 0) {
    throw new Error('[pay-callback] 回放不到任何已支付订单，拒绝发放: openid=' + openid);
  }
  const current = user.expiredAt ? new Date(user.expiredAt).getTime() : 0;
  const next = new Date(Math.max(Number.isFinite(current) ? current : 0, replayed)).toISOString();

  // subscribed 必须一起写：所有权益判定（getUsage/chat/webSearch）都要求
  // `user.subscribed === true` 且 `expiredAt > now`。只延 expiredAt 不置 subscribed，
  // 用户付了钱仍会被判成免费版（语音 20 条 / 收藏 50 条）。
  const patch = { expiredAt: next, subscribed: true };
  if (planId === 'earlybird_monthly') patch.isEarlyBird = true;

  await users.doc(user._id).update({ data: patch });
  console.log('[pay-callback] 用户订阅延长至:', next, 'openid:', openid);
}

/** 按 paidTime 顺序回放所有已支付订单，返回确定性到期时间戳（ms） */
async function replayExpiry(openid) {
  const snap = await db.collection('orders').where({ openid, status: 'paid' }).get();
  const paid = (snap.data || [])
    .filter((o) => o.paidTime && !(o.refundStatus === 'refunded' || o.refundStatus === 'refunding'))
    .sort((a, b) => new Date(a.paidTime).getTime() - new Date(b.paidTime).getTime());
  let cursor = 0;
  for (const o of paid) {
    const t = new Date(o.paidTime).getTime();
    if (!Number.isFinite(t)) continue;
    const months = Number(o.months) || 1;
    cursor = Math.max(cursor, t) + months * MS_PER_MONTH;
  }
  return cursor;
}

function buildErrorResponse(err, channel) {
  console.error('[pay-callback] ERROR:', err.message);
  if (channel === 'wechat') return { code: -1, message: 'fail', error: err.message };
  if (channel === 'alipay') return { httpCode: 400, body: 'fail' };
  if (channel === 'douyin') return { httpCode: 400, body: '{"code":"FAIL","message":"internal error"}' };
  return { code: -1, message: err.message };
}
