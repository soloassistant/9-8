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
 * - **归因口径**：一次「精选请求」记一次 impression，并记下**该次请求时学到的类目集合**；
 *   之后的点击若命中该集合，则为本臂记一次 hit。命中率 = hits / impressions。
 * - **限制（必须知道，不要过度解读）**：
 *   1) 只归因展示后 30 分钟内的点击，且只归因「最后一次精选请求」，无法精确到条目级曝光；
 *   2) 单用户、样本量小，只能看趋势，**不构成统计显著结论**；
 *   3) 用户可能在未点「AI 精选」的默认列表上点击，这部分点击会被误算进最近一次臂。
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

interface ArmCounters {
  treatment: number;
  control: number;
}
interface ExperimentStore {
  impressions: ArmCounters;
  hits: ArmCounters;
  current: { arm: AffinityArm; cats: string[]; at: number } | null;
}

export interface AffinityArmStat {
  impressions: number;
  hits: number;
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
}

const EMPTY: ExperimentStore = {
  impressions: { treatment: 0, control: 0 },
  hits: { treatment: 0, control: 0 },
  current: null
};

function readStore(): ExperimentStore {
  try {
    const raw = Taro.getStorageSync(AFFINITY_AB_STORAGE_KEY);
    return normalizeStore(raw);
  } catch {
    return { ...EMPTY, impressions: { ...EMPTY.impressions }, hits: { ...EMPTY.hits } };
  }
}

/** 防御性收窄：脏数据/被手改的 storage 不得让统计或页面崩掉 */
function normalizeStore(raw: unknown): ExperimentStore {
  const out: ExperimentStore = { impressions: { ...EMPTY.impressions }, hits: { ...EMPTY.hits }, current: null };
  if (!raw || typeof raw !== 'object') return out;
  const rec = raw as Record<string, unknown>;
  for (const field of ['impressions', 'hits'] as const) {
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
    if ((c.arm === 'treatment' || c.arm === 'control') && Array.isArray(c.cats) && typeof c.at === 'number') {
      out.current = {
        arm: c.arm,
        cats: c.cats.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 10),
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

/** 记一次精选请求：记下所属臂与该次请求时的学习类目集合 */
export function recordAffinityImpression(arm: AffinityArm, learnedCats: string[]): void {
  try {
    const s = readStore();
    s.impressions[arm] += 1;
    s.current = {
      arm,
      cats: Array.isArray(learnedCats)
        ? learnedCats.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 10)
        : [],
      at: Date.now()
    };
    writeStore(s);
  } catch {
    /* 静默 */
  }
}

/** 记一次点击结果：仅当归因窗口内且类目命中该次请求的学习集合时，才为本臂记 hit */
export function recordAffinityOutcome(category: string): void {
  try {
    if (typeof category !== 'string' || !category) return;
    const s = readStore();
    const cur = s.current;
    if (!cur) return;
    if (Date.now() - cur.at > ATTRIBUTION_WINDOW_MS) return;
    if (!cur.cats.includes(category)) return;
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
  const t = { impressions: s.impressions.treatment, hits: s.hits.treatment, rate: 0 };
  const c = { impressions: s.impressions.control, hits: s.hits.control, rate: 0 };
  t.rate = rateOf(t.hits, t.impressions);
  c.rate = rateOf(c.hits, c.impressions);
  const samples = t.impressions + c.impressions;
  const lift = t.impressions > 0 && c.impressions > 0 ? t.rate - c.rate : null;
  return { treatment: t, control: c, lift, samples, enough: samples >= MIN_SAMPLES_FOR_VERDICT };
}

export function resetAffinityExperiment(): void {
  try {
    Taro.removeStorageSync(AFFINITY_AB_STORAGE_KEY);
  } catch {
    /* 静默 */
  }
}
