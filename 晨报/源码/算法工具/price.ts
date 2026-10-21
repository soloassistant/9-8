// 价格比对与降价提醒（P-01）。
// 设计原则：**零 API 成本** —— 本模块绝不主动抓价，只在两个时机被调用：
//   ① 用户在购物页手动更新价格后（src/pages/shopping/index.tsx）
//   ② 每日晨报生成时（cloudfunctions/getBriefing/index.js 与 H5 的 data/getBriefing.ts）
// 全部为纯函数/独立模块，可脱离 React 单测。
import Taro from '@tarojs/taro';

/** 已提醒价持久化 key（第六章 A：mb_ 前缀） */
export const PRICE_NOTIFIED_KEY = 'mb_shopping_notified';

/** 参与比价的商品最小字段集（只依赖需要的字段，避免与 services/api.ts 循环依赖） */
export interface PricedItem {
  id: string;
  name: string;
  targetPrice?: number;
  prices: Array<{ platform: string; price: number }>;
  /** 上次已提醒的价格（防重复，PRD P-01） */
  lastNotifiedPrice?: number;
}

/** 命中降价提醒的条目（结构化，文案由渲染层用 i18n 拼装） */
export interface PriceAlert {
  itemId: string;
  name: string;
  /** 命中的最新低价 */
  price: number;
  targetPrice: number;
  platform: string;
}

/** 文案翻译器：仅暴露本模块需要的 key，便于单测注入 stub */
export type AlertTranslator = (
  key: 'shopping.alertToast',
  params?: Record<string, string | number>
) => string;

/** 已提醒价存储结构：{ [itemId]: 上次提醒的价格 } */
type NotifiedMap = Record<string, number>;

function readMap(): NotifiedMap {
  try {
    const raw = Taro.getStorageSync(PRICE_NOTIFIED_KEY);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as NotifiedMap;
    return {};
  } catch (err) {
    console.warn('[price] read notified map failed:', err);
    return {};
  }
}

function writeMap(map: NotifiedMap): void {
  try {
    Taro.setStorageSync(PRICE_NOTIFIED_KEY, map);
  } catch (err) {
    console.warn('[price] write notified map failed:', err);
  }
}

/**
 * 读取某商品上次已提醒的价格。
 * @param itemId 商品 id
 * @returns 上次提醒价；从未提醒过返回 null
 */
export function readNotified(itemId: string): number | null {
  const value = readMap()[itemId];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 记录某商品本次已提醒的价格（去重依据）。
 * @param itemId 商品 id
 * @param price 本次提醒的价格
 */
export function markNotified(itemId: string, price: number): void {
  const map = readMap();
  map[itemId] = price;
  writeMap(map);
}

/**
 * 清除已提醒记录：传 itemId 清单条（心理价位被清除时同步清理），不传则清空全部。
 * @param itemId 商品 id，缺省清空
 */
export function clearNotified(itemId?: string): void {
  if (!itemId) {
    writeMap({});
    return;
  }
  const map = readMap();
  delete map[itemId];
  writeMap(map);
}

/** 取某商品当前最低的一条价格记录；无有效记录返回 null */
function pickLowest(prices: Array<{ platform: string; price: number }> | undefined): { platform: string; price: number } | null {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  let lowest: { platform: string; price: number } | null = null;
  for (const record of prices) {
    if (!record) continue;
    const price = Number(record.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!lowest || price < lowest.price) lowest = { platform: String(record.platform || ''), price };
  }
  return lowest;
}

/**
 * 批量比对「最新价 vs 心理价位」，返回本次需要提醒的条目。
 * 命中条件：最低记录价 ≤ 心理价位，且与上次提醒价不同（同价位不重复提醒）。
 * 去重数据源优先级：item.lastNotifiedPrice → 本地存储 readNotified()。
 */
export function evaluatePriceAlerts(items: PricedItem[]): PriceAlert[] {
  const alerts: PriceAlert[] = [];
  if (!Array.isArray(items) || items.length === 0) return alerts;

  for (const item of items) {
    if (!item) continue;
    const target = Number(item.targetPrice);
    if (!Number.isFinite(target) || target <= 0) continue;

    const lowest = pickLowest(item.prices);
    if (!lowest) continue;
    if (lowest.price > target) continue;

    const alert: PriceAlert = {
      itemId: String(item.id),
      name: String(item.name || ''),
      price: lowest.price,
      targetPrice: target,
      platform: lowest.platform
    };

    const stored = typeof item.lastNotifiedPrice === 'number' ? item.lastNotifiedPrice : readNotified(alert.itemId);
    if (!shouldNotify(alert, stored)) continue;
    alerts.push(alert);
  }
  return alerts;
}

/**
 * 去重判定：与上次已提醒价相同则不重复提醒。
 * @param alert 本次命中的提醒
 * @param lastNotifiedPrice 上次已提醒价（null/undefined 视为从未提醒）
 */
export function shouldNotify(alert: PriceAlert, lastNotifiedPrice?: number | null): boolean {
  if (typeof lastNotifiedPrice !== 'number' || !Number.isFinite(lastNotifiedPrice)) return true;
  return lastNotifiedPrice !== alert.price;
}

/**
 * 生成晨报条目文案（i18n key `shopping.alertToast`）。
 * @param alert 命中的提醒
 * @param t 翻译函数（页面用 useT() 注入；单测可注入 stub）
 */
export function formatAlert(alert: PriceAlert, t: AlertTranslator): string {
  return t('shopping.alertToast', {
    name: alert.name,
    price: alert.price,
    target: alert.targetPrice
  });
}
