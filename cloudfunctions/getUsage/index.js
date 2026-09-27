const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const FREE_VOICE_QUOTA = 20;
const FREE_COLLECTION_QUOTA = 50;

/** 早鸟锁价参考价（与 src/utils/subscription.ts 的 EARLYBIRD_PRICE 保持一致） */
const EARLYBIRD_PRICE = {
  earlybird_monthly: 6.9,
  monthly: 9.9,
  yearly: 88
};

/** 默认方案（无方案记录时按早鸟月付推导锁价） */
const DEFAULT_PLAN_ID = 'earlybird_monthly';

function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 解析早鸟锁价（B-01）：
 * 1. 优先取 user.lockedPrice 字段（前端侧由 utils/subscription.ts 维护并同步上云）；
 * 2. 字段缺失但用户已是早鸟会员 → 按 PRD Q4「v1.2 上线日前已有有效订阅者全部视为早鸟」推导；
 * 3. 其余（未订阅 / 非早鸟 / 已失效）→ null。
 * ⚠️ 云函数环境无 dayjs，统一用原生 Date。
 */
function resolveLockedPrice(user) {
  if (!user) return null;

  const raw = user.lockedPrice;
  if (raw && typeof raw === 'object' && typeof raw.price === 'number') {
    const planId = EARLYBIRD_PRICE[raw.planId] === undefined ? DEFAULT_PLAN_ID : raw.planId;
    return {
      planId,
      price: raw.price,
      lockedAt: typeof raw.lockedAt === 'string' ? raw.lockedAt : todayStr(),
      active: raw.active !== false
    };
  }

  const expiredAt = user.expiredAt ? new Date(user.expiredAt) : null;
  const subscribed = !!user.subscribed && !!expiredAt && !isNaN(expiredAt.getTime()) && expiredAt > new Date();
  if (!subscribed || !user.isEarlyBird) return null;

  const planId = EARLYBIRD_PRICE[user.planId] === undefined ? DEFAULT_PLAN_ID : user.planId;
  return {
    planId,
    price: EARLYBIRD_PRICE[planId],
    lockedAt: todayStr(),
    active: true
  };
}

exports.main = async (event) => {
  const action = (event && event.action) || '';
  const { OPENID } = cloud.getWXContext();

  try {
    const [userRes, usageRes, itemsCount] = await Promise.all([
      db.collection('users').where({ openid: OPENID }).limit(1).get(),
      db.collection('usage').where({ openid: OPENID, month: monthStart() }).limit(1).get(),
      db.collection('items').where({ openid: OPENID }).count()
    ]);

    const user = userRes.data[0];
    const isSubscribed = !!(
      user &&
      user.subscribed &&
      user.expiredAt &&
      new Date(user.expiredAt) > new Date()
    );

    const lockedPrice = resolveLockedPrice(user);

    const usage = {
      voiceUsed: usageRes.data.length > 0 ? usageRes.data[0].voiceUsed : 0,
      voiceQuota: isSubscribed ? -1 : FREE_VOICE_QUOTA,
      collectionCount: itemsCount.total,
      collectionQuota: isSubscribed ? -1 : FREE_COLLECTION_QUOTA,
      // B-01：有锁价记录时返回，供前端展示与续费取价兜底
      lockedPrice
    };

    // 新增动作统一走 { code, message, data }
    if (action === 'getLockedPrice') {
      return { code: 0, message: 'ok', data: { lockedPrice } };
    }

    // 裸业务体沿用现状，不破坏前端既有解包逻辑（设计文档第六章 G）
    return usage;
  } catch (err) {
    console.warn('[getUsage] failed:', err);
    // 失败降级：返回免费额度与 null 锁价，绝不阻断页面渲染
    const fallback = {
      voiceUsed: 0,
      voiceQuota: FREE_VOICE_QUOTA,
      collectionCount: 0,
      collectionQuota: FREE_COLLECTION_QUOTA,
      lockedPrice: null
    };
    if (action === 'getLockedPrice') {
      return { code: -1, message: 'getUsage failed', data: { lockedPrice: null } };
    }
    return fallback;
  }
};
