/**
 * 主动查单云函数（queryOrder）
 *
 * 解决三个上线阻断问题：
 *   - P0-4 前端支付成功只靠回调：用户付完钱但回调还没回来时，前端可主动调本函数确认
 *   - P0-3 用户付了钱但回调丢失（HTTP 触发器挂了/通知丢失）：本函数查通道确认已付后
 *     直接对账（订单置 paid + 延长订阅），不等回调
 *   - P2-12 无主动查单能力：支付结果不确定时（返回系统错误/未知交易状态）的唯一真相源
 *
 * 通道查单 API（均取自官方文档，勿凭记忆改）：
 *   - 微信：cloud.cloudPay.queryOrder({ sub_mch_id, out_trade_no, nonce_str })
 *     → returnCode=SUCCESS 且 trade_state=SUCCESS 才是支付成功
 *     （trade_state 枚举：SUCCESS/REFUND/NOTPAY/CLOSED/REVOKED/USERPAYING/PAYERROR）
 *   - 支付宝：sdk.exec('alipay.trade.query', { bizContent: { out_trade_no } })
 *     → code=10000 且 trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED}
 *   - 抖音：GET https://api.douyinpay.com/v1/trade/transactions/out-trade-no/{out_trade_no}?mchid={mchid}
 *     签名串 5 行：METHOD\nPATH(含 query)\nTIMESTAMP\nNONCE\nBODY(空)\n
 *     （官方签名示例：canonicalUrl = encodedPath + "?" + encodedQuery；GET 的 body 传空串）
 *     → trade_state=SUCCESS 才是支付成功。注意：查单响应不含金额字段，跳过金额校验
 *
 * 安全设计：
 *   - 幂等：本地已 paid 直接返回，不重复延长订阅
 *   - 金额一致性：回调/查单金额与订单金额不符（分）→ 拒绝对账并告警（防改价）
 *   - 归属校验：有 OPENID（前端直连）时必须 order.openid === OPENID；
 *     云函数间调用（closeOrder 扫描器）拿不到 WXContext，OPENID 为空时跳过校验
 *
 * 与 pay-callback 的关系：对账逻辑镜像自 pay-callback/index.js 的
 * confirmOrderPaid + extendUserExpiredAt（云函数各自独立打包，无法共享模块）。
 * **改动必须同步两处**，否则回调和查单两条对账路径会漂移。
 *
 * 调用方：前端 mine 页（支付结果不确定时）；closeOrder 云函数（定时扫描对账）。
 */

const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ========== 配置（与 pay-alipay / pay-douyin 同名的云环境变量） ==========
function getAlipayConfig() {
  const env = process.env.PAY_ALIPAY_ENV || 'prod';
  return {
    appId: process.env.PAY_ALIPAY_APP_ID || '',
    privateKey: process.env.PAY_ALIPAY_PRIVATE_KEY || '',
    alipayPublicKey: process.env.PAY_ALIPAY_PUBLIC_KEY || '',
    gateway: env === 'sandbox'
      ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
      : 'https://openapi.alipay.com/gateway.do'
  };
}

const dyCfg = {
  appId: process.env.PAY_DY_APP_ID || '',
  mchid: process.env.PAY_DY_MCHID || '',
  privateKey: process.env.PAY_DY_PRIVATE_KEY || '',
  serialNo: process.env.PAY_DY_SERIAL_NO || ''
};

// ========== 工具 ==========
function genNonceStr(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** 缓存 SDK **实例**（不是类）：云函数实例热复用，缓存类会让第二次调用拿到类本身 */
let _alipaySdk = null;
function getAlipaySdk(cfg) {
  if (_alipaySdk) return _alipaySdk;
  const AlipaySdk = require('alipay-sdk').default;
  _alipaySdk = new AlipaySdk({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    alipayPublicKey: cfg.alipayPublicKey,
    gateway: cfg.gateway,
    signType: 'RSA2',
    charset: 'utf-8',
    format: 'JSON'
  });
  return _alipaySdk;
}

// ========== 主入口 ==========
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const orderId = event && event.orderId;
  if (!orderId) return { ok: false, error: 'orderId required' };

  // 1. 读本地订单
  const snap = await db.collection('orders').where({ orderId }).get();
  const order = snap.data && snap.data[0];
  if (!order) return { ok: false, error: '订单不存在: ' + orderId };

  // 2. 归属校验（前端直连必带 OPENID；云函数间调用无 OPENID，跳过）
  if (OPENID && order.openid !== OPENID) {
    console.warn('[queryOrder] 订单归属不匹配，拒绝查询:', orderId);
    return { ok: false, error: 'order owner mismatch' };
  }

  const base = {
    ok: true,
    orderId,
    channel: order.channel,
    localStatus: order.status,
    paid: false,
    reconciled: false,
    channelTradeNo: undefined,
    amountFen: undefined
  };

  // 3. 本地已 paid：幂等返回，不打通道、不重复延长订阅
  if (order.status === 'paid') {
    return Object.assign(base, {
      paid: true,
      channelStatus: 'local',
      channelTradeNo: order.channelTradeNo
    });
  }

  // 4. 查通道
  let q;
  try {
    if (order.channel === 'wechat') q = await queryWechatOrder(orderId);
    else if (order.channel === 'alipay') q = await queryAlipayOrder(orderId);
    else if (order.channel === 'douyin') q = await queryDouyinOrder(orderId);
    else return Object.assign(base, { channelStatus: 'unsupported', error: '未知通道: ' + order.channel });
  } catch (e) {
    // 查不动（网络/配置）→ 不猜、不改状态，交给下一轮或人工
    console.error('[queryOrder] 通道查询异常:', orderId, e.message);
    return Object.assign(base, { channelStatus: 'query_failed', error: e.message });
  }

  const result = Object.assign(base, {
    channelStatus: q.channelStatus,
    channelTradeNo: q.channelTradeNo,
    amountFen: q.amountFen,
    error: q.error
  });

  // 5. 通道未确认支付 → 原样返回（不动本地状态）
  if (!q.paid) return result;

  // 6. 通道确认已付但金额不符 → 拒绝对账并告警（防改价攻击/通道侧错价）
  if (q.amountFen !== undefined && Number(q.amountFen) !== order.price) {
    console.error(`[queryOrder] 金额不一致：通道 ${q.amountFen} vs 订单 ${order.price}（分），orderId=${orderId}`);
    return Object.assign(result, { channelStatus: 'amount_mismatch', error: 'amount mismatch: channel=' + q.amountFen + ' order=' + order.price });
  }

  // 7. 对账：订单置 paid + 延长订阅（镜像 pay-callback 的 confirmOrderPaid）
  try {
    const rec = await reconcileOrder(order, q);
    return Object.assign(result, { paid: true, reconciled: !rec.alreadyPaid });
  } catch (e) {
    console.error('[queryOrder] 对账失败:', orderId, e.message);
    return Object.assign(result, { channelStatus: 'reconcile_failed', error: e.message });
  }
};

// ========== 通道查单 ==========

/** 微信：cloudPay.queryOrder（官方 SDK 文档：returnCode 是通信标识，trade_state 才是交易标识） */
async function queryWechatOrder(orderId) {
  const res = await cloud.cloudPay.queryOrder({
    sub_mch_id: process.env.PAY_WX_SUB_MCH_ID || '',
    out_trade_no: orderId,
    nonce_str: genNonceStr()
  });
  const tradeState = res && res.trade_state;
  return {
    channelStatus: tradeState || 'unknown',
    paid: !!res && res.returnCode === 'SUCCESS' && tradeState === 'SUCCESS',
    channelTradeNo: res && res.transaction_id,
    amountFen: res && res.total_fee != null ? Number(res.total_fee) : undefined
  };
}

/** 支付宝：alipay.trade.query */
async function queryAlipayOrder(orderId) {
  const cfg = getAlipayConfig();
  if (!cfg.appId || !cfg.privateKey || !cfg.alipayPublicKey) {
    return { channelStatus: 'unconfigured', paid: false, error: 'PAY_ALIPAY_* 未配置' };
  }
  const sdk = getAlipaySdk(cfg);
  const resp = await sdk.exec('alipay.trade.query', { bizContent: { out_trade_no: orderId } });
  const r = resp && resp.alipay_trade_query_response;
  if (!r) return { channelStatus: 'unknown', paid: false, error: 'alipay 响应格式异常' };
  const paid = r.code === '10000' && (r.trade_status === 'TRADE_SUCCESS' || r.trade_status === 'TRADE_FINISHED');
  return {
    channelStatus: r.trade_status || 'unknown',
    paid,
    channelTradeNo: r.trade_no,
    amountFen: r.total_amount != null ? Math.round(Number(r.total_amount) * 100) : undefined
  };
}

/** 抖音：GET /v1/trade/transactions/out-trade-no/{out_trade_no}?mchid={mchid} */
async function queryDouyinOrder(orderId) {
  if (!dyCfg.appId || !dyCfg.mchid || !dyCfg.privateKey || !dyCfg.serialNo) {
    return { channelStatus: 'unconfigured', paid: false, error: 'PAY_DY_* 未配置' };
  }
  const path = '/v1/trade/transactions/out-trade-no/' + encodeURIComponent(orderId) + '?mchid=' + encodeURIComponent(dyCfg.mchid);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = genNonceStr();

  // 签名串 5 行：METHOD\nPATH(含 query)\nTIMESTAMP\nNONCE\nBODY\n —— GET 的 body 是空串
  const sigStr = 'GET\n' + path + '\n' + timestamp + '\n' + nonce + '\n\n';
  const signature = crypto.createSign('RSA-SHA256').update(sigStr, 'utf8').sign(dyCfg.privateKey, 'base64');
  const authorization = 'DouyinPay-RSA '
    + 'mchid="' + dyCfg.mchid + '",'
    + 'nonce_str="' + nonce + '",'
    + 'timestamp="' + timestamp + '",'
    + 'serial_no="' + dyCfg.serialNo + '",'
    + 'signature="' + signature + '"';

  const data = await httpGetJson('api.douyinpay.com', path, authorization);
  return {
    channelStatus: (data && data.trade_state) || 'unknown',
    paid: !!data && data.trade_state === 'SUCCESS',
    channelTradeNo: data && data.transaction_id,
    // 抖音查单响应不含金额字段（官方文档字段列表无 amount），跳过金额校验
    amountFen: undefined
  };
}

function httpGetJson(host, path, authorization) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      path,
      method: 'GET',
      headers: {
        'Authorization': authorization,
        'Accept': 'application/json'
      },
      timeout: 10000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(new Error('抖音响应解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('抖音查单请求超时')); });
    req.end();
  });
}

// ========== 对账（镜像 pay-callback confirmOrderPaid + extendUserExpiredAt） ==========
async function reconcileOrder(order, q) {
  // 幂等：已 paid 直接返回（并发双跑时这里兜底）
  if (order.status === 'paid') {
    console.log('[queryOrder] 订单已 paid，跳过对账:', order.orderId);
    return { orderId: order.orderId, alreadyPaid: true };
  }

  // 预检：权益接收方必须存在。**必须放在置 paid 之前** —— 否则订单已 paid 而权益永远发不出去
  // （上方幂等分支「已 paid 直接 return」，以及 main() 的本地已 paid 早退，都不会再补发）。
  const payerSnap = await db.collection('users').where({ openid: order.openid }).limit(1).get();
  if (!payerSnap.data || payerSnap.data.length === 0) {
    throw new Error('[queryOrder] 用户不存在，拒绝对账置 paid: openid=' + order.openid);
  }

  const now = new Date().toISOString();
  await db.collection('orders').doc(order._id).update({
    data: {
      status: 'paid',
      payStatus: 'paid',
      paidChannel: order.channel,
      channelTradeNo: q.channelTradeNo,
      paidTime: now,
      payTime: now,
      paidVia: 'queryOrder-reconcile'      // 标记对账来源，便于排查
    }
  });

  await extendUserExpiredAt(order.openid, order.months || 1, order.planId);
  console.log('[queryOrder] ✅ 对账完成，订单置 paid:', order.orderId, 'channel:', order.channel);
  return { orderId: order.orderId, paid: true };
}

/** 延长用户订阅过期时间（幂等 + 原子更新），与 pay-callback 保持同一算法 */
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
    throw new Error('[queryOrder] 用户不存在，无法发放权益 openid=' + openid);
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
  console.log('[queryOrder] 用户订阅延长至:', next, 'openid=', openid);
}
