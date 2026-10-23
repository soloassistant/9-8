/**
 * H5 客户端偏好选位 —— 让「科学 / 文化 / 健康」这些偏好标签在 H5 上真的起作用。
 *
 * 为什么需要它（2026-10-23）：
 *   偏好选位原本只存在于 `cloudfunctions/webSearch` 的 `selectForUser`，而**云函数未部署**
 *   （缺 WX_APPID / WX_PRIVATE_KEY_PATH / WX_CLOUD_ENV）。于是 H5 上：
 *     · 用户点「科学」「文化」→ 只写进 `user-settings.preferences`；
 *     · 简报页读的是 `hotspot.items.slice(0, 3)` —— 硬切前 3 条，**完全没看偏好**；
 *     · 结果是「选项出现了、能点、但点了没有任何变化」。
 *
 * 本模块把云函数的同一套算法搬到客户端，使 H5 静态链路（gh-pages / 同源 hotspot.json）
 * 也能按偏好取数。**算法刻意与 cloudfunctions/webSearch 的 selectForUser 逐条对齐** ——
 * 否则云函数一旦部署，两端会出现"同一条资讯在小程序靠前、在 H5 靠后"的分裂。
 *
 * 纯函数、零依赖，便于 `.tools/verify-pref-select.js` 直接编译执行并做变异验证。
 */

/** 参与选位的最小条目形状（与 HotspotNews 结构兼容，不引入依赖） */
export interface PrefSelectItem {
  source?: string;
  tags?: string[];
  createTime?: string;
}

export interface PrefSelectOptions {
  /** 每个偏好 tag 至少给几席（对齐云端 PREF_TAG_MIN_ITEMS = 3） */
  minPerPref?: number;
  /** 同一来源最多取几条（对齐云端 MAX_ITEMS_PER_SOURCE = 3） */
  maxPerSource?: number;
}

export const PREF_TAG_MIN_ITEMS = 3;
export const MAX_ITEMS_PER_SOURCE = 3;

/** 条目主标签：取 tags[0]，缺失归「其他」（与云端 itemTag 一致） */
export function itemTag(it: PrefSelectItem | null | undefined): string {
  if (!it || !Array.isArray(it.tags)) return '其他';
  const tag = it.tags[0];
  return typeof tag === 'string' && tag ? tag : '其他';
}

/** 条目时间戳：createTime 为 ISO 串，解析失败按最旧处理（与云端 itemTs 一致） */
export function itemTs(it: PrefSelectItem | null | undefined): number {
  const ts = Date.parse((it && it.createTime) || '');
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 按偏好选位。
 *
 * 规则（与云端 selectForUser 同序）：
 *   ① 全池按时间倒序；
 *   ② 无偏好 / 池里没有偏好标签的货 → 直接取前 limit 条（**不降级成"偏好命中数"之类的假逻辑**）；
 *   ③ 偏好保底：总预算 `min(minPerPref × 命中标签数, max(1, limit-1))` 均分给各命中标签，
 *      按标签在 prefs 里的顺序依次取；
 *   ④ 广度保底：其余标签按「池内数量降序、标签名升序」各取最新 1 条；
 *   ⑤ 全过程遵守「同一来源最多 maxPerSource 条」。
 */
export function selectByPreference<T extends PrefSelectItem>(
  items: T[],
  prefs: string[] | undefined | null,
  limit: number,
  opts: PrefSelectOptions = {}
): T[] {
  const minPerPref = opts.minPerPref ?? PREF_TAG_MIN_ITEMS;
  const maxPerSource = opts.maxPerSource ?? MAX_ITEMS_PER_SOURCE;
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

  const pool = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!pool.length || max <= 0) return [];
  const sorted = pool.slice().sort((a, b) => itemTs(b) - itemTs(a));

  const prefTags: string[] = [];
  if (Array.isArray(prefs)) {
    for (const p of prefs) {
      if (typeof p !== 'string') continue;
      const tag = p.trim();
      if (tag && !prefTags.includes(tag)) prefTags.push(tag);
    }
  }
  if (!prefTags.length) return sorted.slice(0, max);

  const buckets = new Map<string, T[]>();
  for (const it of sorted) {
    const tag = itemTag(it);
    if (!buckets.has(tag)) buckets.set(tag, []);
    (buckets.get(tag) as T[]).push(it);
  }

  // 池里真有货的偏好 tag，保持 prefs 顺序
  const hitTags = prefTags.filter((t) => buckets.has(t));
  if (!hitTags.length) return sorted.slice(0, max);

  const picked: T[] = [];
  const pickedSet = new Set<T>();
  const perSource = new Map<string, number>();
  const take = (it: T): boolean => {
    const src = it.source || '';
    const used = perSource.get(src) || 0;
    if (used >= maxPerSource) return false;
    picked.push(it);
    pickedSet.add(it);
    perSource.set(src, used + 1);
    return true;
  };

  // ① 偏好保底：总预算 max-1 席，均分给各偏好 tag
  const budget = Math.min(minPerPref * hitTags.length, Math.max(1, max - 1));
  const base = Math.floor(budget / hitTags.length);
  let rest = budget % hitTags.length;
  hitTags.forEach((tag) => {
    let quota = Math.min(minPerPref, base + (rest > 0 ? 1 : 0));
    if (rest > 0) rest -= 1;
    for (const it of buckets.get(tag) as T[]) {
      if (quota <= 0 || picked.length >= max) break;
      if (take(it)) quota -= 1;
    }
  });

  // ② 广度保底：其余 tag 各取最新 1 条（数量多的优先，保证覆盖面）
  const otherTags = [...buckets.keys()]
    .filter((t) => !hitTags.includes(t))
    .sort((a, b) => {
      const bySize = (buckets.get(b) as T[]).length - (buckets.get(a) as T[]).length;
      if (bySize !== 0) return bySize;
      return a.localeCompare(b);
    });
  for (const tag of otherTags) {
    if (picked.length >= max) break;
    for (const it of buckets.get(tag) as T[]) {
      if (picked.length >= max) break;
      if (!pickedSet.has(it) && take(it)) break;
    }
  }

  // ③ 还没填满（来源配额卡住了）：按时间倒序补足
  if (picked.length < max) {
    for (const it of sorted) {
      if (picked.length >= max) break;
      if (!pickedSet.has(it)) take(it);
    }
  }

  // ④ 最终排序：偏好命中的置前，其余按时间倒序（与云端 selectForUser 收尾一致）。
  //    少了这一步，用户选了「科学」但科学条目未必出现在最前面 —— 那等于没生效。
  const prefSet = new Set(hitTags);
  return picked
    .slice(0, max)
    .sort((a, b) => {
      const pa = prefSet.has(itemTag(a)) ? 0 : 1;
      const pb = prefSet.has(itemTag(b)) ? 0 : 1;
      return pa - pb || itemTs(b) - itemTs(a);
    });
}
