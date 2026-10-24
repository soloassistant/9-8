/**
 * 功能记账（纯逻辑：不碰 Taro / storage，便于 esbuild + vm 做行为断言）
 *
 * 解决什么问题：`utils/usage.ts` 只记了**语音**一个功能的本月次数，其它会真花钱的
 * 能力（AI 对话 / AI 提取 / 全网搜索）一点痕迹都没有。后果有两头：
 *   ① 用户看到额度条掉下去，但不知道是哪一项吃掉的 —— 只能怀疑产品在偷偷扣；
 *   ② 我们自己也答不上「这个月 AI 花了多少次」，客服与成本核算都没依据。
 *
 * **诚实性边界（与 AGENTS 的降级铁律一致）**：
 *   · 降级到 `src/data/*` 的示例数据**一律不记** —— 那不是一次真实调用，记了就是虚报用量；
 *   · 只记「发起且拿到了结果」的调用，失败/中断不记（不把失败算成消耗）；
 *   · 只留**按天聚合的次数**，不留消息原文、关键词、prompt —— 记账不该变成行为日志。
 *
 * 为什么是天聚合而不是事件数组：这个 key 进云同步（跨端一致）。事件级数组 60 天会到
 * 15 KB 以上，天聚合只要 2–3 KB；同步冲突提示与流量都省。
 * 取舍的代价（据实写明）：实时性只到「天」，同一天内看不出先后顺序 —— 但本功能只用于
 * 「哪一项吃了多少」，不需要时序。
 */
import { dayKey, dayIndex, shiftDay } from './date';

/** 会消耗真实额度的能力。顺序即 UI 展示顺序（稳定，便于断言）。 */
export type FeatureKey = 'chat' | 'extract' | 'voice' | 'search';

export const FEATURES: readonly FeatureKey[] = ['chat', 'extract', 'voice', 'search'];

/** 保留最近多少天（含今天）。60 天足够看趋势，又不至于把同步包撑大。 */
export const KEEP_DAYS = 60;

/** 某一天的计数（缺省 = 0，不写 0 值以省字节） */
export type DayCounts = Partial<Record<FeatureKey, number>>;

/** { 'YYYY-MM-DD': { chat: 3, extract: 1 } } */
export type DayBuckets = Record<string, DayCounts>;

export type FeatureTotals = Record<FeatureKey, number>;

export interface UsageSummary {
  /** 今天各功能次数（四项齐全，未用为 0） */
  today: FeatureTotals;
  /** 近 7 天（含今天）各功能次数 */
  week: FeatureTotals;
  /** 今天总次数 */
  todayTotal: number;
  /** 近 7 天总次数 */
  weekTotal: number;
}

export function isFeature(x: unknown): x is FeatureKey {
  return typeof x === 'string' && (FEATURES as readonly string[]).includes(x);
}

function emptyTotals(): FeatureTotals {
  return { chat: 0, extract: 0, voice: 0, search: 0 };
}

/**
 * 把 storage 里读出来的任意值洗成合法结构。
 * 脏数据（字符串、数组、负数、未知功能、非法日期）一律丢弃 —— 这类 key 会被云同步写回，
 * 一次脏值如果被当真，会永久污染"近 7 天"的展示。
 */
export function parseBuckets(raw: unknown): DayBuckets {
  const out: DayBuckets = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const day of Object.keys(raw as DayBuckets)) {
    if (dayIndex(day) === null) continue;
    const src = (raw as DayBuckets)[day];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const clean: DayCounts = {};
    for (const f of FEATURES) {
      const n = Number((src as DayCounts)[f]);
      if (Number.isFinite(n) && n > 0) clean[f] = Math.floor(n);
    }
    if (Object.keys(clean).length) out[day] = clean;
  }
  return out;
}

/** 追加一次计数（纯函数，返回新对象，不改入参） */
export function bump(map: DayBuckets, day: string, feature: FeatureKey, n = 1): DayBuckets {
  if (dayIndex(day) === null) return map;
  const add = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (!add) return map;
  const prev = map[day] || {};
  return { ...map, [day]: { ...prev, [feature]: (prev[feature] || 0) + add } };
}

/**
 * 裁掉窗口外的天。
 * 同时丢掉**未来日期**：设备时钟被调到明天时记账会写进未来，不裁的话
 * "今天"永远查不到新记录，看起来像记账坏了。
 */
export function prune(map: DayBuckets, today: string, keepDays = KEEP_DAYS): DayBuckets {
  const todayIdx = dayIndex(today);
  if (todayIdx === null) return map;
  const minIdx = todayIdx - (Math.max(1, keepDays) - 1);
  const out: DayBuckets = {};
  for (const day of Object.keys(map)) {
    const idx = dayIndex(day);
    if (idx === null) continue;
    if (idx < minIdx || idx > todayIdx) continue;
    out[day] = map[day];
  }
  return out;
}

/** 指定日期区间（含两端）内的各功能合计 */
export function sumDays(map: DayBuckets, fromDay: string, toDay: string): FeatureTotals {
  const from = dayIndex(fromDay);
  const to = dayIndex(toDay);
  const total = emptyTotals();
  if (from === null || to === null || to < from) return total;
  for (const day of Object.keys(map)) {
    const idx = dayIndex(day);
    if (idx === null || idx < from || idx > to) continue;
    for (const f of FEATURES) total[f] += map[day][f] || 0;
  }
  return total;
}

/** 今日 + 近 7 天汇总（UI 直接消费） */
export function summarize(map: DayBuckets, today: string, weekDays = 7): UsageSummary {
  const todayTotals = sumDays(map, today, today);
  const week = sumDays(map, shiftDay(today, -(Math.max(1, weekDays) - 1)), today);
  const sum = (t: FeatureTotals) => FEATURES.reduce((acc, f) => acc + t[f], 0);
  return { today: todayTotals, week, todayTotal: sum(todayTotals), weekTotal: sum(week) };
}

/** 记账入口用的"现在"（供调用方注入，便于断言跨天） */
export function currentDay(now: number = Date.now()): string {
  return dayKey(now);
}
