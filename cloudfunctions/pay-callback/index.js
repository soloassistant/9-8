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
 *   1. 验签（微信云开发自动做，支付宝/抖音自己验）
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
  douyinPublicKey: process.env.PAY_DY_PUBLIC_KEY || '',          // 抖音支付平台证书公钥（验签）
  douyinEncryptKey: process.env.PAY_DY_ENCRYPT_KEY || ''        // 接口加密密钥（AES-256-GCM 解密）
};

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
async function handleWeChat(event) {
  // 云开发已自动验签，event 结构：{ payment, outTradeNo, transactionId, ... }
  const orderId = event.outTradeNo;
  const transactionId = event.transactionId;

  if (!orderId) throw new Error('微信回调缺少 outTradeNo');

  const result = await confirmOrderPaid({
    orderId,
    channel: 'wechat',
    channelTradeNo: transactionId
  });

  // 微信 cloudPay 回调只需要返回成功 JSON 给云开发
  return { code: 0, message: 'success', data: result };
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

// ========== 4. 统一回写：订单置为 paid + 延长订阅 ==========
/**
 * 幂等更新订单状态为 paid，延长 users.expiredAt。
 * 多源触发（支付宝/抖音/微信回调 或 主动查单）都走这里。
 * 用 orders 集合本身作为互斥锁（状态检查 → 原子更新），避免并发重入。
 */
async function confirmOrderPaid({ orderId, channel, channelTradeNo, amountFen }) {
  // 1. 读订单
  const orderSnap = await db.collection('orders').where({ orderId }).get();
  const order = orderSnap.data && orderSnap.data[0];
  if (!order) throw new Error('订单不存在: ' + orderId);

  // 2. 幂等：已 paid 直接返回
  if (order.status === 'paid') {
    console.log('[pay-callback] 订单已 paid，跳过:', orderId);
    return { orderId, alreadyPaid: true };
  }

  // 3. 要素一致性校验：渠道匹配 + 金额匹配
  if (order.channel && order.channel !== channel) {
    // 同一 orderId 不应出现在不同通道的回调里，但做个告警
    console.warn(`[pay-callback] order.channel=${order.channel} 与回调 channel=${channel} 不一致`);
  }

  // 3.5 金额一致性校验（回调金额 vs 订单金额，单位分）。
  // 仅对回调携带金额的通道强制（alipay/douyin）；微信金额由我们自己的 unifiedOrder 设定、
  // cloudPay 已验签，故不参与。缺金额字段按不一致处理——宁可漏发不可错发，补救走主动查单。
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

  // 4. 原子更新订单状态（微信云开发 SDK 的 update 自带乐观并发控制）
  const now = new Date().toISOString();
  await db.collection('orders').doc(order._id).update({
    data: {
      status: 'paid',
      payStatus: 'paid',
      paidChannel: channel,
      channelTradeNo,
      paidTime: now,
      payTime: now
    }
  });

  // 5. 延长用户订阅时长（幂等：每次回调都是 +months，但 expiredAt 只增不减）
  const openid = order.openid;
  const months = order.months || 1;
  await extendUserExpiredAt(openid, months, order.planId);

  console.log('[pay-callback] ✅ 订单置为 paid:', orderId, 'channel:', channel);
  return { orderId, channel, paid: true };
}

/** 延长用户订阅过期时间（幂等 + 原子更新） */
async function extendUserExpiredAt(openid, months, planId) {
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

  const current = user.expiredAt ? new Date(user.expiredAt).getTime() : Date.now();
  const base = Math.max(current, Date.now());           // 已过期则从现在开始算
  const next = new Date(base + months * 30 * 24 * 3600 * 1000).toISOString();

  // subscribed 必须一起写：所有权益判定（getUsage/chat/webSearch）都要求
  // `user.subscribed === true` 且 `expiredAt > now`。只延 expiredAt 不置 subscribed，
  // 用户付了钱仍会被判成免费版（语音 20 条 / 收藏 50 条）。
  const patch = { expiredAt: next, subscribed: true };
  if (planId === 'earlybird_monthly') patch.isEarlyBird = true;

  await users.doc(user._id).update({ data: patch });
  console.log('[pay-callback] 用户订阅延长至:', next, 'openid:', openid);
}

function buildErrorResponse(err, channel) {
  console.error('[pay-callback] ERROR:', err.message);
  if (channel === 'wechat') return { code: -1, message: 'fail', error: err.message };
  if (channel === 'alipay') return { httpCode: 400, body: 'fail' };
  if (channel === 'douyin') return { httpCode: 400, body: '{"code":"FAIL","message":"internal error"}' };
  return { code: -1, message: err.message };
}
