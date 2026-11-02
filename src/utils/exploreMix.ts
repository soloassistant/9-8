/**
 * 防茧房探索位（2026-11-02，产品评估 §P0-5）
 *
 * 问题：偏好选位把「科学/文化/健康」用户的列表**越来越窄**地锁在偏好标签里，
 * 长期看用户只会看到自己已经喜欢的东西 —— 典型信息茧房。
 * 做法：在偏好排序结果里掺入 **5-8%** 非偏好条目（默认 6%），位置分散而不是堆在末尾。
 *
 * 三条克制：
 *  1. **没有偏好就没有探索**（prefs 为空 → 原样返回）。此时本来就没有"茧房"可言，
 *     掺入等于无意义地打乱时间序。
 *  2. **确定性**：同一份数据 + 同一组偏好 → 同一结果。用条目 id/createTime 做哈希取位，
 *     不用 Math.random —— 否则每次渲染列表都在跳，用户会以为出了 bug。
 *  3. **不越界**：只在调用方给的池子里选，且不重复已选条目；池子不够就少掺，不凑数。
 *
 * 与云端的分叉说明（必须知道）：`cloudfunctions/webSearch` 里的 `selectForUser` 是
 * `src/utils/prefSelect.ts` 的镜像实现，**但那个云函数至今未部署**（缺 WX_APPID / 私钥），
 * 所以 weapp 端目前连偏好选位都没有，更谈不上探索位。等它部署时，本模块要一并搬过去 ——
 * 否则会出现"同一条资讯在两端排序不同"，那是本仓反复踩过的口径分叉。
 */

/** 默认掺入比例（评估文档给的区间是 5-8%，取中位） */
export const EXPLORE_RATE = 0.06;
/** 区间下限/上限：外部传参时夹到区间内，防止有人写 0.5 把列表变成随机流 */
export const EXPLORE_RATE_MIN = 0.05;
export const EXPLORE_RATE_MAX = 0.08;

export interface ExploreItem {
  id?: string;
  tags?: string[];
}

function tagOf(it: ExploreItem | null | undefined): string {
  if (!it || !Array.isArray(it.tags)) return '';
  const t = it.tags[0];
  return typeof t === 'string' ? t : '';
}

/** 稳定哈希（FNV-1a 变体）—— 用于确定性取位，不追求密码学强度 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function keyOf(it: ExploreItem): string {
  if (it && typeof it.id === 'string' && it.id) return it.id;
  return JSON.stringify(it || {});
}

/**
 * 在已排序结果里掺入探索位。
 *
 * @param ranked  偏好排序后的结果（长度即最终展示条数）
 * @param pool    候选池（应当已经过来源过滤 —— 用户关掉的源不许作为探索位出现）
 * @param prefs   用户偏好标签
 */
export function mixExploration<T extends ExploreItem>(
  ranked: T[],
  pool: T[],
  prefs: string[] | undefined | null,
  rate: number = EXPLORE_RATE
): T[] {
  const out = Array.isArray(ranked) ? ranked.slice() : [];
  if (out.length < 2) return out;
  const prefTags = (Array.isArray(prefs) ? prefs : []).filter((p): p is string => typeof p === 'string' && !!p.trim());
  // 没有偏好 = 没有茧房，不掺
  if (!prefTags.length) return out;

  const r = Number.isFinite(rate) ? Math.min(EXPLORE_RATE_MAX, Math.max(EXPLORE_RATE_MIN, rate)) : EXPLORE_RATE;
  // 向下取整，不足 1 条就不掺：
  //  · 四舍五入会让 20 条 × 8% = 1.6 变成 2 条（实际 10%，越过上限）；
  //  · 小列表（如晨报情报的 limit=3）掺 1 条就是 33% —— 那不是点缀，是换了个列表。
  const want = Math.floor(out.length * r);
  if (want < 1) return out;

  const chosen = new Set(out.map(keyOf));
  const candidates = (Array.isArray(pool) ? pool : []).filter((it) => {
    if (!it) return false;
    const tag = tagOf(it);
    // 非偏好 = 标签不在偏好里；无标签条目也算（那是最典型的"视野外"内容）
    return !prefTags.includes(tag) && !chosen.has(keyOf(it));
  });
  if (!candidates.length) return out;

  // 确定性排序后再取：按 id 哈希升序，稳定且看着"打散"
  const picked = candidates
    .slice()
    .sort((a, b) => hash(keyOf(a)) - hash(keyOf(b)))
    .slice(0, Math.min(want, out.length - 1)); // 至少保留 1 条原结果，不喧宾夺主

  if (!picked.length) return out;

  // **替换席位**而不是追加：结果长度保持不变。
  // 追加会让 limit=3 的情报区变 4 条，直接撑破版式（routes 门禁会报溢出）；
  // 而且产品语义本来就是"把 6% 的席位让给探索"，不是"多塞内容"。
  const result = out.slice();
  const step = Math.max(1, Math.floor(result.length / picked.length));
  let pi = 0;
  // 从第 2 席开始替换，避免第一条就被探索位顶掉（首条通常是用户最关心的）
  for (let i = 1; i < result.length && pi < picked.length; i += step) {
    result[i] = picked[pi];
    pi += 1;
  }
  // 步长太大导致没放完时，从尾部继续填（仍在本数组内，绝不加长）
  for (let i = result.length - 1; i >= 0 && pi < picked.length; i -= 1) {
    if (result[i] !== picked[pi]) {
      result[i] = picked[pi];
      pi += 1;
    }
  }
  return result;
}
