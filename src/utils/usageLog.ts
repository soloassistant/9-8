/**
 * 功能记账的存储层（薄壳：只做「读 → 纯函数处理 → 写回」，判定逻辑全在 utils/featureUsage.ts）
 *
 * 为什么单独一层：`featureUsage.ts` 要保持零依赖才能被 esbuild + vm 直接跑行为断言；
 * Taro 的 storage 只能在这一层出现。所有读写都 try/catch —— 记账失败绝不能连累主流程
 * （AI 回包已经拿到了，却因为记账抛错让用户看不到回答，是本末倒置）。
 */
import Taro from '@tarojs/taro';
import { bump, currentDay, parseBuckets, prune, summarize } from './featureUsage';
import type { DayBuckets, FeatureKey, UsageSummary } from './featureUsage';

/** 这个 key 进云同步（跨端一致）—— 改名前先查 cloudSync.SYNC_KEYS 与 sync.key.* 文案 */
export const FEATURE_USAGE_KEY = 'feature-usage';

export function readUsageBuckets(): DayBuckets {
  try {
    return parseBuckets(Taro.getStorageSync(FEATURE_USAGE_KEY));
  } catch (err) {
    console.warn('[usageLog] read failed:', err);
    return {};
  }
}

/** 记一次真实消耗。**调用点必须只在"真的拿到结果"之后**（见 services/cloud.ts 注释）。 */
export function recordUsage(feature: FeatureKey, now: number = Date.now(), n = 1): void {
  try {
    const today = currentDay(now);
    const next = prune(bump(readUsageBuckets(), today, feature, n), today);
    Taro.setStorageSync(FEATURE_USAGE_KEY, next);
  } catch (err) {
    console.warn('[usageLog] record failed:', err);
  }
}

/** 给「我的」页用的汇总（今天 + 近 7 天） */
export function readUsageSummary(now: number = Date.now()): UsageSummary {
  return summarize(readUsageBuckets(), currentDay(now));
}
