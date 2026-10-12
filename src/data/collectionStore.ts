/** 收藏真实存储：收件箱「确认入库」的唯一落库点（此前 collection 被丢弃、收藏页全是 mock，已修复）。
 *  H5 本地 Taro storage（key 已加入云同步 SYNC_KEYS）；weapp 真机由云函数 confirmItem 落云数据库。 */
import Taro from '@tarojs/taro';
import type { CollectionItem } from '../types';

const STORE_KEY = 'collectionStore';

function load(): CollectionItem[] {
  try {
    const raw = Taro.getStorageSync(STORE_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.warn('[collectionStore] load failed:', err);
    return [];
  }
}

/** 收藏列表（真实数据，无 mock 兜底；空列表由页面渲染空态） */
export function listCollections(): CollectionItem[] {
  return load();
}

/** 新增收藏（时间倒序，最新在前）
 *
 * ⚠️ `opts.quota` 是**付费墙的唯一硬边界**（2026-10-12 增长审计）：
 *   「我的」页一直显示「收藏空间 0/50」，但旧实现**完全不校验** ——
 *   用户存到第 51 条照样成功，于是「50 条」只是个展示数字，订阅缺少触发理由。
 *   不传 `quota` 时保持旧行为（不拦），避免影响内部/测试调用方。
 *   超限时**抛错而不静默丢弃** —— 调用方据此给出可操作的提示。 */
export function addCollection(
  item: Omit<CollectionItem, 'id' | 'createTime'>,
  opts?: { quota?: number }
): CollectionItem {
  const quota = opts && typeof opts.quota === 'number' ? opts.quota : 0;
  const existing = load();
  if (quota > 0 && existing.length >= quota) {
    const err = new Error('collection-quota-exceeded');
    (err as Error & { quota?: number; current?: number }).quota = quota;
    (err as Error & { quota?: number; current?: number }).current = existing.length;
    throw err;
  }
  const full: CollectionItem = {
    ...item,
    id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createTime: new Date().toISOString()
  };
  try {
    Taro.setStorageSync(STORE_KEY, [full, ...existing]);
  } catch (err) {
    console.warn('[collectionStore] save failed:', err);
  }
  return full;
}

