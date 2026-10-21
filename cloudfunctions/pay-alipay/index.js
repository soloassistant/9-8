/**
 * 支付宝小程序 JSAPI 支付云函数
 *
 * 功能：调用 alipay.trade.create（统一收单交易创建接口）
 *      返回 trade_no 给前端 my.tradePay({ tradeNO }) 调起收银台
 *
 * 契约来源：
 *   - https://opendocs.alipay.com/open/291/105602
 *   - https://zhifubao.apifox.cn/doc-3289177
 *
 * 关键实现：
 *   - product_code 必须传 JSAPI_PAY（不是默认 FACE_TO_FACE_PAYMENT）
 *   - 必须有 buyer_id（2088 开头的支付宝 userId）和 op_app_id（小程序 appId）
 *   - 签名算法 RSA2（sha256WithRSA），由 alipay-sdk 自动处理
 *   - 金额单位：元（Decimal），精确到小数点后两位
 *   - 时间戳格式：yyyy-MM-dd HH:mm:ss
 *
 * @param {object} event
 *   - planId           套餐 ID（earlybird_monthly / monthly / yearly）
 *   - orderId          本地订单号（createOrder 返回的 ord_xxx）
 *   - totalAmount      金额，单位：分（createOrder 返回的 price * 100）
 *   - subject          订单标题，默认「晨报订阅」
 *   - buyerId          必填，支付宝 userId，2088 开头（my.getAuthCode → 服务端换）
 *   - timeoutExpress   可选，超时表达式，默认 30m（格式 1m～15d）
 *   - attach           可选，附加数据，通知中原样返回
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const PLANS = {
  earlybird_monthly: { price: 690, months: 1, label: '晨报·早鸟月付' },
  monthly: { price: 990, months: 1, label: '晨报·月付' },
  yearly: { price: 8800, months: 12, label: '晨报·年付' }
};

/**
 * 懒加载 alipay-sdk。
 * 云函数首次冷启动时才 require，避免热启动重复装载。
 *
 * alipay-sdk-nodejs v3.x 引入方式（ESM/CJS 混合导出）：
 *   const AlipaySdk = require('alipay-sdk').default
 */
let _sdk = null;
function getSdk() {
  if (_sdk) return _sdk;

  // 配置来源：云环境变量（生产）或云开发数据库 settings 集合（开发）
  // 敏感字段永不硬编码，从 cloud.getTempFileURL 或 db.collection('payConfig') 读取
  const cfg = getAlipayConfig();

  const AlipaySdk = require('alipay-sdk').default;
  // 缓存的必须是**实例**而不是类：云函数实例被热复用，若把类存进 _sdk，
  // 第二次调用 getSdk() 会直接返回类本身，sdk.exec 不是静态方法 → TypeError，
  // 表现为「第一单下单成功、之后全部失败」。
  _sdk = new AlipaySdk({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    alipayPublicKey: cfg.alipayPublicKey,
    gateway: cfg.gateway,                  // https://openapi.alipay.com/gateway.do
    signType: 'RSA2',
    charset: 'utf-8',
    format: 'JSON'
  });
  return _sdk;
}

function getAlipayConfig() {
  // 生产/沙箱切换由 cloud 环境变量 PAY_ALIPAY_ENV 控制
  const env = process.env.PAY_ALIPAY_ENV || 'prod';

  // ⚠️ 以下字段**绝不能**硬编码在代码里。
  // 首次部署时请通过云开发控制台 → 环境变量配置：
  //   PAY_ALIPAY_APP_ID         小程序 appId
  //   PAY_ALIPAY_PRIVATE_KEY    应用私钥（PKCS#8，BEGIN PRIVATE KEY）
  //   PAY_ALIPAY_PUBLIC_KEY     支付宝公钥（非应用公钥）
  //   PAY_ALIPAY_OP_APP_ID      小程序 appId（必须在商家平台绑定 JSAPI 支付）
  //   PAY_ALIPAY_SELLER_ID      可选，卖家支付宝 userId（2088 开头）
  // 正式环境：https://openapi.alipay.com/gateway.do
  // 沙箱环境：https://openapi-sandbox.dl.alipaydev.com/gateway.do
  return {
    appId: process.env.PAY_ALIPAY_APP_ID || '',
    privateKey: process.env.PAY_ALIPAY_PRIVATE_KEY || '',
    alipayPublicKey: process.env.PAY_ALIPAY_PUBLIC_KEY || '',
    opAppId: process.env.PAY_ALIPAY_OP_APP_ID || '',
    sellerId: process.env.PAY_ALIPAY_SELLER_ID || '',
    gateway: env === 'sandbox'
      ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
      : 'https://openapi.alipay.com/gateway.do'
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { planId, orderId, totalAmount, subject, buyerId, timeoutExpress = '30m', attach } = event;

  // ========== 1. 基础校验 ==========
  if (!orderId) throw new Error('orderId required');
  if (!buyerId || !/^2088\d{12,14}$/.test(buyerId)) {
    throw new Error('buyerId 必须是 2088 开头的支付宝 userId');
  }

  const plan = PLANS[planId];
  if (!plan) throw new Error('invalid planId: ' + planId);

  // 金额：分 → 元（Decimal，保留两位）
  const yuan = (Number(totalAmount) / 100).toFixed(2);

  // ========== 2. 构造 biz_content ==========
  const cfg = getAlipayConfig();
  if (!cfg.appId || !cfg.privateKey || !cfg.alipayPublicKey) {
    throw new Error('alipay 支付配置缺失，请在云环境变量中设置 PAY_ALIPAY_*');
  }

  const bizContent = {
    out_trade_no: orderId,
    total_amount: yuan,
    subject: subject || plan.label,
    product_code: 'JSAPI_PAY',          // 小程序专用产品码（关键！默认 FACE_TO_FACE_PAYMENT 不适用）
    buyer_id: buyerId,                   // 2088 开头
    timeout_express: timeoutExpress,
    op_app_id: cfg.opAppId || cfg.appId, // 必须在商家平台绑定 JSAPI 支付
    notify_url: await resolveNotifyUrl('alipay')
  };
  if (attach) bizContent.body = attach;
  if (cfg.sellerId) bizContent.seller_id = cfg.sellerId;

  // ========== 3. 调用 alipay.trade.create ==========
  // exec(method, bizContent) 内部自动：参数排序 → RSA2 签名 → HTTP POST → JSON 解包
  const sdk = getSdk();
  const rawResp = await sdk.exec('alipay.trade.create', { bizContent });

  // alipay-sdk 返回结构：{ alipay_trade_create_response: { code, msg, trade_no, out_trade_no }, sign }
  const resp = rawResp && rawResp.alipay_trade_create_response;
  if (!resp) {
    throw new Error('alipay 响应格式异常：' + JSON.stringify(rawResp));
  }

  if (resp.code !== '10000') {
    throw new Error(`alipay 下单失败: code=${resp.code} msg=${resp.msg} sub_code=${resp.sub_code || ''} sub_msg=${resp.sub_msg || ''}`);
  }

  return {
    ok: true,
    channel: 'alipay',
    tradeNo: resp.trade_no,          // 给前端 my.tradePay 用
    orderId: resp.out_trade_no,
    totalAmount: yuan
  };
};

/**
 * 获取异步通知地址。
 * 本地开发（preview）时不传——通知处理代码仍保留，但支付结果靠手动查询兜底。
 * 生产环境通过云开发 HTTP 触发器暴露 pay-callback 云函数，URL 以 https:// 开头。
 */
async function resolveNotifyUrl(channel) {
  const url = process.env[`PAY_${channel.toUpperCase()}_NOTIFY_URL`];
  if (!url) return undefined;
  return url;
}
