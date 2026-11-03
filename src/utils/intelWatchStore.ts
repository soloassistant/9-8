// 追踪关键词的存储薄壳（2026-10-31）。解析/匹配逻辑全在 intelWatch.ts（纯函数、vm 可断言）；
// Taro storage 只能在这层出现。键名与自选股 watchlist 刻意区分（两个「清单」是两码事）。
import Taro from '@tarojs/taro';
import { parseIntelWatchKeywords } from './intelWatch';

export const INTEL_WATCH_KEY = 'intel-watchlist';

export function readWatchKeywords(): string[] {
  try {
    return parseIntelWatchKeywords(Taro.getStorageSync(INTEL_WATCH_KEY));
  } catch (err) {
    console.warn('[intelWatchStore] read failed:', err);
    return [];
  }
}

/** 保存原始输入（存**解析后**的规范化词表，读端无需再解析）；空数组 = 关闭追踪，合法状态 */
export function saveWatchKeywords(raw: string | string[]): string[] {
  const words = parseIntelWatchKeywords(raw);
  try {
    Taro.setStorageSync(INTEL_WATCH_KEY, words);
  } catch (err) {
    console.error('[intelWatchStore] save failed:', err);
  }
  return words;
}
