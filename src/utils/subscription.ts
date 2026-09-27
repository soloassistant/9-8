/**
 * 订阅锁价与调价通知（D1 批次 · B-01 / B-02）
 *
 * 职责：
 * 1. B-01 早鸟终身锁价：首次成功订阅记录 `lockedPrice`，后续调价不影响续费与展示；
 *    主动取消后重订即失效（记录保留，只置 `active=false`，便于「曾享锁价」留痕与客服核查）。
 * 2. B-02 涨价前 30 天通知：构造站内信（标题 / 正文走 i18n key，避免 utils 内硬编码中文），
 *    落库后由「我的」页订阅区渲染；对已锁价用户使用「价格不受影响」文案分支。
 *
 * 约定：
 * - storage key 统一 `mb_` 前缀：`mb_locked_price`、`mb_price_notices`（见设计文档第六章 A）；
 * - 所有读写统一 Taro.getStorageSync / setStorageSync + try/catch，失败只 console.warn，绝不 throw；
 * - 本模块只提供「通知能力 + 文案」，**不发起任何实际调价**（本轮不发生调价动作）。
 */
import Taro from '@tarojs/taro';
import type { LangKey } from '../store/language';

/** 订阅方案（与 `types/index.ts` 的 `PayOrder['planId']` 保持一致，此处就近定义避免改动公共类型） */
export type PlanId = 'earlybird_monthly' | 'monthly' | 'yearly';

/** 早鸟锁价记录的 storage key */
export const LOCKED_PRICE_KEY = 'mb_locked_price';

/** 涨价通知站内信列表的 storage key */
export const PRICE_NOTICES_KEY = 'mb_price_notices';

/**
 * 早鸟锁价参考价（PRD 5.3：月付 ¥9.9 / 年付 ¥88）。
 * 早鸟月付沿用其在售价格；实际锁价以首次成功订阅时的成交价 `lockPrice(planId, price)` 为准。
 */
export const EARLYBIRD_PRICE: Record<PlanId, number> = {
  earlybird_monthly: 6.9,
  monthly: 9.9,
  yearly: 88
};

/** 日期格式：'YYYY-MM-DD'（设计文档第六章 C） */
type DateStr = string;

/** 早鸟锁价记录 */
export interface LockedPriceInfo {
  planId: PlanId;
  /** 锁定价格（月付 ¥9.9 / 年付 ¥88，早鸟月付取成交价） */
  price: number;
  /** 锁定时间 'YYYY-MM-DD' */
  lockedAt: DateStr;
  /** true = 锁价生效中；主动取消后转 false（PRD B-01） */
  active: boolean;
}

/**
 * 涨价通知站内信。
 * ⚠️ 与设计文档 3.2 的差异：`title` / `body` 两个中文字段改为
 * `titleKey` / `bodyKey` + `params`，由页面 `useT()` 渲染。
 * 原因：utils 层禁止硬编码中文，且站内信需跟随语言切换。
 */
export interface PriceChangeNotice {
  id: string;
  /** 调价生效日 'YYYY-MM-DD' */
  effectiveAt: DateStr;
  /** 调整前价格 */
  oldPrice: number;
  /** 调整后价格 */
  newPrice: number;
  /** 收件人是否已被锁价（true → 走「你的价格不受影响」分支） */
  locked: boolean;
  /** 标题 i18n key：`mine.priceChangeTitle` */
  titleKey: LangKey;
  /** 正文 i18n key：`mine.priceChangeLocked` / `mine.priceChangeNew` */
  bodyKey: LangKey;
  /** 正文插值参数：`{ date, price }` 或 `{ date, old, new }` */
  params: Record<string, string | number>;
  read: boolean;
  /** 入站时间 'YYYY-MM-DD' */
  createdAt: DateStr;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

/** 取今天 'YYYY-MM-DD'（本地时区，云函数侧同样用原生 Date 口径） */
function today(): DateStr {
  const d = new Date();
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 金额展示：¥9.9（去掉多余小数位，避免出现 ¥88.0） */
export function formatPrice(price: number): string {
  if (typeof price !== 'number' || !isFinite(price)) return '¥--';
  const rounded = Math.round(price * 100) / 100;
  return `¥${Number(rounded.toFixed(2))}`;
}

/* ------------------------------------------------------------------ */
/* 锁价读写（B-01）                                                     */
/* ------------------------------------------------------------------ */

/**
 * 首次成功订阅 → 打标锁价。
 * 已存在生效中的锁价记录时不覆盖（保留首次锁定价，符合「早鸟终身锁价」语义）。
 */
export function lockPrice(planId: PlanId, price: number): LockedPriceInfo {
  const prev = readLockedPrice();
  if (prev && prev.active) return prev;
  const info: LockedPriceInfo = {
    planId,
    price: typeof price === 'number' && isFinite(price) ? price : EARLYBIRD_PRICE[planId],
    lockedAt: today(),
    active: true
  };
  try {
    Taro.setStorageSync(LOCKED_PRICE_KEY, info);
  } catch (err) {
    console.warn('[subscription] write locked price failed:', err);
  }
  return info;
}

/** 读取锁价记录（无记录 / 读失败 / 结构非法均返回 null） */
export function readLockedPrice(): LockedPriceInfo | null {
  try {
    const raw = Taro.getStorageSync(LOCKED_PRICE_KEY) as LockedPriceInfo | '';
    if (raw && typeof raw === 'object' && typeof raw.price === 'number') {
      return {
        planId: (raw.planId === 'monthly' || raw.planId === 'yearly' || raw.planId === 'earlybird_monthly')
          ? raw.planId
          : 'earlybird_monthly',
        price: raw.price,
        lockedAt: typeof raw.lockedAt === 'string' ? raw.lockedAt : today(),
        active: raw.active === true
      };
    }
  } catch (err) {
    console.warn('[subscription] read locked price failed:', err);
  }
  return null;
}

/**
 * 展示与续费取价：
 * - 存在生效中且方案匹配的锁价 → 取锁定价（后续调价不影响）；
 * - 其余（无锁价 / 已取消失效 / 切换了方案）→ 取传入的基础价。
 */
export function getEffectivePrice(planId: PlanId, basePrice: number): number {
  const info = readLockedPrice();
  if (info && info.active && info.planId === planId) return info.price;
  return basePrice;
}

/* ------------------------------------------------------------------ */
/* 涨价通知站内信（B-02）                                               */
/* ------------------------------------------------------------------ */

/** 站内信列表（最新在前；读失败返回空数组） */
export function listInboxNotices(): PriceChangeNotice[] {
  try {
    const raw = Taro.getStorageSync(PRICE_NOTICES_KEY);
    if (Array.isArray(raw)) {
      return raw.filter((n): n is PriceChangeNotice => !!n && typeof n.id === 'string');
    }
  } catch (err) {
    console.warn('[subscription] read notices failed:', err);
  }
  return [];
}

/** 标记单条已读 */
export function markNoticeRead(id: string): void {
  const next = listInboxNotices().map((n) => (n.id === id ? { ...n, read: true } : n));
  try {
    Taro.setStorageSync(PRICE_NOTICES_KEY, next);
  } catch (err) {
    console.warn('[subscription] mark notice read failed:', err);
  }
}

