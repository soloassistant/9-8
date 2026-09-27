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

/** 新增收藏（时间倒序，最新在前） */
export function addCollection(item: Omit<CollectionItem, 'id' | 'createTime'>): CollectionItem {
  const full: CollectionItem = {
    ...item,
    id: `col-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createTime: new Date().toISOString()
  };
  try {
    Taro.setStorageSync(STORE_KEY, [full, ...load()]);
  } catch (err) {
    console.warn('[collectionStore] save failed:', err);
  }
  return full;
}

