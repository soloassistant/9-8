/**
 * Taro 侧存储适配器：把 Taro 的本地存储适配成 learning-core 的 StorageLike。
 *
 * 只做「字符串 → 字符串」的读写，JSON 编解码由 learning-core 的 LocalLearningRepository 负责，
 * 从而与独立 Web 展示版共用同一套进度、成就与社区的读写逻辑。
 */
import Taro from '@tarojs/taro';
import type { StorageKeys, StorageLike } from '@learning/core';

/** 学习平台在宿主 Taro 应用中的存储命名空间；沿用既有 key，保证已有进度不丢。 */
export const LEARNING_STORAGE_KEYS: StorageKeys = {
  store: 'learnStore',
  achievements: 'learnAchievements',
  nickname: 'learnNickname',
  community: 'learnCommunityStore'
};

/**
 * 兼容 Taro H5 的历史信封格式：旧版写入的是对象，Taro 会包一层 { data: 值 }。
 * 旧数据读到的是对象，这里解出 data；新版写入的是裸 JSON 字符串，原样返回。
 */
function unwrapLegacy(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null;
  if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'data')) {
    const inner = (raw as { data: unknown }).data;
    return typeof inner === 'string' ? inner || null : null;
  }
  return null;
}

export function createTaroStorage(): StorageLike {
  return {
    getItem(key: string): string | null {
      try {
        return unwrapLegacy(Taro.getStorageSync(key));
      } catch (err) {
        console.warn('[learning] read storage failed:', key, err);
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        // 存裸 JSON 字符串，使宿主云同步（cloudSync）可以按同一信封语义解析与回写。
        Taro.setStorageSync(key, value);
      } catch (err) {
        console.warn('[learning] write storage failed:', key, err);
      }
    }
  };
}
