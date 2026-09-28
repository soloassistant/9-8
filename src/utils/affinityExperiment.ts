/**
 * 类目偏好学习的小样本 A/B（switchback 设计）。
 *
 * 为什么需要它：上一轮做完「偏好学习闭环」后，只验证了**链路通**，没有验证**有没有用**。
 * 一个只按行为记录、然后把记录回灌给模型的机制，如果不度量效果，就等于凭信念上线。
 *
 * 设计（在单机、小样本、无实验平台的约束下能做到的最小可信方案）：
 * - **按天切换臂（switchback）**：用「本地日期」做种子，同一天内用户稳定落在同一臂。
 *   避免同一天内反复换臂导致归因混乱，也让两臂在时间上交替、部分抵消「今天资讯本来就好」这类漂移。
 * - **双臂**：`treatment` = 把学到的类目回灌给 AI；`control` = 不回灌（其余完全一致）。
 * - **归因口径（细化到条目级曝光）**：一次「精选请求」记一次 impression（记下该次请求时的**学习类目
 *   集合** `learnedCats`）；请求返回、界面渲染时再记一次 exposure（记下**这次实际展示了哪些条目的
 *   id** `shownIds`，不存标题）。两个集合**语义不同、各自独立**：`learnedCats` 回答「AI 被告知了
 *   哪些偏好」，`shownIds` 回答「用户真正看到了哪些条目」。
 *   之后的点击：传了 `itemId` 且落在 `shownIds` 内 → 确证「展示过且被点了」，记 hit 并额外计入
 *   `hitsById`；传了 `itemId` 但**不在** `shownIds` 内（点的是别处内容，如默认列表）→ **一律不记**
 *   （不回退）；未传 `itemId`（旧调用点）→ 按 `learnedCats` 走类目级判定，与改动前语义一致。
 *   命中率 = hits / impressions。
 * - **限制（必须知道，不要过度解读）**：
 *   1) 仍只归因展示后 30 分钟内的点击，且只归因「最后一次精选请求」，无法把多次请求的曝光叠加；
 *   2) 单用户、样本量小，只能看趋势，**不构成统计显著结论**；
 *   3) 「在默认列表上点击被误算」这一条，在**调用点已传 itemId** 的前提下已被彻底消除（不再回退到
 *      类目级）；只在**未传 itemId 的旧调用点**上仍残留类目级判定 —— 用 `attributedById` 可看出
 *      还有多少 hit 未经条目级确证。
 *   为此 UI 只展示「样本数」与两臂命中率，并在样本不足时明说不足，不给结论。
 *
 * 存储：独立键 `mb-cat-affinity-ab`（纯统计计数器，不上云、不含内容）。
 */

import Taro from '@tarojs/taro';

export type AffinityArm = 'treatment' | 'control';

export const AFFINITY_AB_STORAGE_KEY = 'mb-cat-affinity-ab';
/** 对照组比例：20% 的天数不启用学习，用于拿到对照基线 */
export const CONTROL_RATIO = 0.2;
/** 点击归因窗口：展示后多久内的点击算作本次请求的效果 */
export const ATTRIBUTION_WINDOW_MS = 30 * 60 * 1000;
/** 低于该样本数不下结论（只提示样本不足），避免用 3 个样本算出「提升 200%」 */
export const MIN_SAMPLES_FOR_VERDICT = 20;

/** 归因上下文存储上限：展示条目 id 最多 40 个、学习类目最多 10 个 */
const MAX_SHOWN_IDS = 40;
const MAX_LEARNED_CATS = 10;
/** 单个字符串截断长度：id ≤64、类目 ≤16（隐私最小化 + 防脏数据撑爆 storage） */
const MAX_ID_LEN = 64;
const MAX_CAT_LEN = 16;

interface ArmCounters {
  treatment: number;
  control: number;
}
interface ExperimentStore {
  impressions: ArmCounters;
  hits: ArmCounters;
  /** 其中**条目级确证**的 hit 数（hits 的子集）：点击条目 id 落在 shownIds 内才计入 */
  hitsById: ArmCounters;
  /**
   * 最近一次精选请求的归因上下文。两个集合语义独立、互不覆盖：
   * - `learnedCats`：由 `recordAffinityImpression` 写入，= 该次请求时学到的类目集合（类目级回退判据）；
   * - `shownIds`：由 `recordAffinityExposure` 写入，= 该次请求实际展示的条目 id（条目级确证判据）。
   */
  current: { arm: AffinityArm; learnedCats: string[]; shownIds: string[]; at: number } | null;
}

export interface AffinityArmStat {
  impressions: number;
  hits: number;
  /** 其中条目级确证的 hit 数（hits 的子集） */
  hitsById: number;
  /** 命中率，0~1；无样本时为 0 */
  rate: number;
}
export interface AffinityExperimentSummary {
  treatment: AffinityArmStat;
  control: AffinityArmStat;
  /** 学习组 − 对照组（百分点差值，0~1）；任一侧无样本时为 null */
  lift: number | null;
  /** 两臂 impression 合计 */
  samples: number;
  /** 样本是否足以给出结论 */
  enough: boolean;
  /** 全部 hit 中**条目级确证**所占比例（0~1）；无 hit 时为 0 */
  attributedById: number;
}

const EMPTY: ExperimentStore = {
  impressions: { treatment: 0, control: 0 },
  hits: { treatment: 0, control: 0 },
  hitsById: { treatment: 0, control: 0 },
  current: null
};

/** 全新空存储（深拷贝计数器，避免调用方与 EMPTY 共享对象引用） */
function freshStore(): ExperimentStore {
  return {
    impressions: { ...EMPTY.impressions },
    hits: { ...EMPTY.hits },
    hitsById: { ...EMPTY.hitsById },
    current: null
  };
}

function readStore(): ExperimentStore {
  try {
    const raw = Taro.getStorageSync(AFFINITY_AB_STORAGE_KEY);
    return normalizeStore(raw);
  } catch {
    return freshStore();
  }
}

/** 类目集合收窄：丢弃非字符串/空串 → 上限 10 → 单个截断 16 */
function normalizeCats(list: unknown[]): string[] {
  return list
    .filter((x): x is string => typeof x === 'string' && !!x)
    .slice(0, MAX_LEARNED_CATS)
    .map((x) => x.slice(0, MAX_CAT_LEN));
}

/** 条目 id 集合收窄：丢弃非字符串/空串 → 上限 40 → 单个截断 64 */
function normalizeIds(list: unknown[]): string[] {
  return list
    .filter((x): x is string => typeof x === 'string' && !!x)
    .slice(0, MAX_SHOWN_IDS)
    .map((x) => x.slice(0, MAX_ID_LEN));
}

/** 防御性收窄：脏数据/被手改的 storage 不得让统计或页面崩掉 */
function normalizeStore(raw: unknown): ExperimentStore {
  const out = freshStore();
  if (!raw || typeof raw !== 'object') return out;
  const rec = raw as Record<string, unknown>;
  // 旧格式存储没有 hitsById 字段：遍历只覆盖「存在且合法」的字段，缺失时保持 0
  for (const field of ['impressions', 'hits', 'hitsById'] as const) {
    const node = rec[field];
    if (node && typeof node === 'object') {
      const n = node as Record<string, unknown>;
      for (const arm of ['treatment', 'control'] as const) {
        const v = n[arm];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[field][arm] = Math.floor(v);
      }
    }
  }
  const cur = rec.current;
  if (cur && typeof cur === 'object') {
    const c = cur as Record<string, unknown>;
    // 旧格式（无 learnedCats）把「该次请求的学习类目集合」直接存在 current.cats 里 → 迁移为 learnedCats；
    // 旧格式没有展示条目信息 → shownIds 一律为空数组（条目级路径在旧数据上自然不命中）
    const learnedRaw = Array.isArray(c.learnedCats)
      ? (c.learnedCats as unknown[])
      : Array.isArray(c.cats)
        ? (c.cats as unknown[])
        : null;
    if (
      learnedRaw &&
      typeof c.at === 'number' &&
      Number.isFinite(c.at) &&
      (c.arm === 'treatment' || c.arm === 'control')
    ) {
      out.current = {
        arm: c.arm,
        learnedCats: normalizeCats(learnedRaw),
        shownIds: normalizeIds(Array.isArray(c.shownIds) ? (c.shownIds as unknown[]) : []),
        at: c.at
      };
    }
  }
  return out;
}

function writeStore(s: ExperimentStore): void {
  try {
    Taro.setStorageSync(AFFINITY_AB_STORAGE_KEY, s);
  } catch {
    /* storage 不可用时静默降级：统计丢失不影响主流程 */
  }
}

function localDateSeed(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 分臂：同一 seed 结果稳定（默认按天），便于复现与归因 */
export function pickAffinityArm(seed?: string): AffinityArm {
  const s = typeof seed === 'string' && seed ? seed : localDateSeed();
  return hashStr(s) % 100 < Math.round(CONTROL_RATIO * 100) ? 'control' : 'treatment';
}

/** 记一次精选请求：写入所属臂与该次请求时的学习类目集合（shownIds 归零：本次请求尚未展示任何东西） */
export function recordAffinityImpression(arm: AffinityArm, learnedCats: string[]): void {
  try {
    const s = readStore();
    s.impressions[arm] += 1;
    s.current = {
      arm,
      learnedCats: Array.isArray(learnedCats) ? normalizeCats(learnedCats) : [],
      shownIds: [],
      at: Date.now()
    };
    writeStore(s);
  } catch {
    /* 静默 */
  }
}

/**
 * 记一次精选请求「实际展示了哪些条目」（与 impression 成对使用：先 impression、拿到结果后 exposure）。
 * - 只写入 `shownIds`（以及 arm/at），**不触碰 `learnedCats`** —— 两个集合语义独立，互不覆盖；
 * - 只存条目 id，**不存标题**（隐私最小化）；id 去重、≤40 个、单个 ≤64 字符；
 * - 覆盖式：始终代表**最近一次曝光**。
 * 脏条目（id 缺失/非字符串）直接跳过，不进存储。
 */
export function recordAffinityExposure(
  arm: AffinityArm,
  items: Array<{ id: string; category: string }>
): void {
  try {
    if (arm !== 'treatment' && arm !== 'control') return;
    const list = Array.isArray(items) ? items : [];
    const ids: string[] = [];
    for (const it of list) {
      if (!it || typeof it !== 'object') continue;
      const id = (it as { id?: unknown }).id;
      if (typeof id === 'string' && id) {
        const v = id.slice(0, MAX_ID_LEN);
        if (!ids.includes(v)) ids.push(v);
      }
    }
    const s = readStore();
    const learnedCats = s.current ? s.current.learnedCats : [];
    s.current = {
      arm,
      learnedCats,
      shownIds: ids.slice(0, MAX_SHOWN_IDS),
      at: Date.now()
    };
    writeStore(s);
  } catch {
    /* 静默 */
  }
}

/**
 * 记一次点击结果。三条路径，都受 `ATTRIBUTION_WINDOW_MS` 约束：
 * - `itemId` 是**非空字符串且在 `shownIds` 内** → 记 hit 并额外计入 `hitsById`（确证「展示过且被点了」）；
 * - `itemId` 是**非空字符串但不在 `shownIds` 内** → **一律不记**（点的是本次未展示的内容，如默认列表；
 *   既然调用点拿得到 id，就说明它知道自己在点哪一条，不该再退化成类目级模糊匹配）；
 * - `itemId` **未传 / 非字符串 / 空串**（旧调用点）→ 按 `learnedCats` 走类目级判定，与改动前语义一致。
 */
export function recordAffinityOutcome(category: string, itemId?: string): void {
  try {
    if (typeof category !== 'string' || !category) return;
    const s = readStore();
    const cur = s.current;
    if (!cur) return;
    if (Date.now() - cur.at > ATTRIBUTION_WINDOW_MS) return;
    if (typeof itemId === 'string' && itemId) {
      if (!cur.shownIds.includes(itemId)) return;
      s.hits[cur.arm] += 1;
      s.hitsById[cur.arm] += 1;
      writeStore(s);
      return;
    }
    if (!cur.learnedCats.includes(category)) return;
    s.hits[cur.arm] += 1;
    writeStore(s);
  } catch {
    /* 静默 */
  }
}

function rateOf(hits: number, impressions: number): number {
  return impressions > 0 ? hits / impressions : 0;
}

export function getAffinityExperimentSummary(): AffinityExperimentSummary {
  const s = readStore();
  const t = {
    impressions: s.impressions.treatment,
    hits: s.hits.treatment,
    hitsById: s.hitsById.treatment,
    rate: 0
  };
  const c = {
    impressions: s.impressions.control,
    hits: s.hits.control,
    hitsById: s.hitsById.control,
    rate: 0
  };
  t.rate = rateOf(t.hits, t.impressions);
  c.rate = rateOf(c.hits, c.impressions);
  const samples = t.impressions + c.impressions;
  const lift = t.impressions > 0 && c.impressions > 0 ? t.rate - c.rate : null;
  // 全部 hit 里有多少是条目级确证的：占比越低，说明越依赖「类目级回退」，结论越不可靠
  const totalHits = t.hits + c.hits;
  const attributedById = totalHits > 0 ? (t.hitsById + c.hitsById) / totalHits : 0;
  return {
    treatment: t,
    control: c,
    lift,
    samples,
    enough: samples >= MIN_SAMPLES_FOR_VERDICT,
    attributedById
  };
}

export function resetAffinityExperiment(): void {
  try {
    Taro.removeStorageSync(AFFINITY_AB_STORAGE_KEY);
  } catch {
    /* 静默 */
  }
}
