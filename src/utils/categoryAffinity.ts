/**
 * 类目偏好学习：把用户的点击 / 反馈沉淀成「类目偏好」，并**回灌**给 AI 精选请求。
 *
 * 【存了必须用】
 * 本项目踩过「AI 记忆只存不用」的坑 —— 数据写进了盘，却从不回灌给模型，等于没做。
 * 所以本模块存在的唯一理由就是被**消费**：唯一消费点在
 * src/pages/library/index.tsx 的 handleAiFilter()，它把 getTopCategories(3)
 * 合并进 apiAiNewsFilter 的第一个参数（interests），使用户的浏览行为真的影响
 * 下一次 AI 精选。任何把这里改成「只写不读」的改动，都应视为功能回归。
 *
 * 【为什么用独立存储键，而不是塞进 src/utils/prefs.ts 的 UserPrefs】
 * UserPrefs 会整包参与云端同步（cloudSync 有字段白名单）：
 * 1) 这里最多 200 条带时间戳的逐条行为记录，塞进去会无谓放大同步载荷，且它天然
 *    是本机行为数据，没有必要上云；
 * 2) 新增字段会牵连云端白名单 / 历史数据迁移，超出「类目偏好学习」这个功能的范围。
 * 因此单开 'mb-cat-affinity'，与 prefs 互不影响。
 *
 * 【健壮性】
 * 小程序 storage 在隐私授权、容量、并发等场景下都可能抛错。所有读写一律
 * try/catch，失败时**静默降级为「无偏好」**，绝不把异常抛给调用方 ——
 * 偏好学习是增强能力，不能因为它挂了就让资讯页崩掉或「AI 精选」点不动。
 */
import Taro from '@tarojs/taro';

/** 独立存储键（刻意不复用 prefs.UserPrefs，见文件头说明） */
export const AFFINITY_STORAGE_KEY = 'mb-cat-affinity';

/** 用户行为信号：点击 / 正反馈 / 负反馈 / 收藏 */
export type AffinitySignal = 'tap' | 'up' | 'down' | 'collect';

/**
 * 行为权重：收藏(4) > 点赞(3) > 点击(1) > 点踩(-2)。
 * 点踩为负分是用来「抵消误点/不感兴趣」的，而不是形成负偏好 ——
 * 读取侧只保留 score > 0，负分只会把该类目拉出偏好列表。
 */
const AFFINITY_WEIGHTS: Record<AffinitySignal, number> = {
  tap: 1,
  up: 3,
  down: -2,
  collect: 4
};

/** 原始记录上限（超出丢弃最旧），防止长期使用后 storage 无限增长 */
const MAX_RECORDS = 200;
/** 单条类目名长度上限（防御脏数据 / 异常调用撑爆存储） */
const MAX_CATEGORY_LENGTH = 16;
/** 时间衰减：超过该天数的记录不再计入（兴趣会变，老数据不该长期绑架推荐） */
const DECAY_DAYS = 30;
/** 单类目分数上限：避免「同一类目点很多次」压过其他所有类目，保住多元性 */
const MAX_CATEGORY_SCORE = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 存储里的单条记录（字段名压缩，节省小程序 storage 体积） */
interface AffinityRecord {
  /** 类目名 */
  c: string;
  /** 行为类型 */
  k: AffinitySignal;
  /** 记录时间（ms 时间戳） */
  at: number;
}

/** 收窄：未知值是否为合法行为类型 */
function isSignal(v: unknown): v is AffinitySignal {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AFFINITY_WEIGHTS, v);
}

/** 收窄：把存储里的任意值变成合法记录；脏条目一律丢弃（不抛错） */
function toRecord(v: unknown): AffinityRecord | null {
  if (!v || typeof v !== 'object') return null;
  const rec = v as { c?: unknown; k?: unknown; at?: unknown };
  if (typeof rec.c !== 'string' || !rec.c) return null;
  if (!isSignal(rec.k)) return null;
  if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return null;
  return { c: rec.c, k: rec.k, at: rec.at };
}

/** 读原始记录：异常 / 非数组 / 脏条目 → 空数组（静默降级为「无偏好」） */
function readRecords(): AffinityRecord[] {
  try {
    const raw: unknown = Taro.getStorageSync(AFFINITY_STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    const out: AffinityRecord[] = [];
    for (const item of raw) {
      const rec = toRecord(item);
      if (rec) out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

/** 写原始记录：storage 不可用时静默丢弃，不影响调用方 */
function writeRecords(list: AffinityRecord[]): void {
  try {
    Taro.setStorageSync(AFFINITY_STORAGE_KEY, list);
  } catch {
    /* 忽略：本次偏好不入库，页面其余功能照常 */
  }
}

/**
 * 记录一次类目行为信号。
 * 防御：非字符串 / 空串 / 未知 kind 直接 return；类目名截断 ≤16 字；
 * 记录总数上限 200，超出丢弃最旧；每条带 at 时间戳。
 */
export function recordCategorySignal(category: string, kind: AffinitySignal): void {
  if (typeof category !== 'string') return;
  const name = category.trim().slice(0, MAX_CATEGORY_LENGTH);
  if (!name) return;
  if (!isSignal(kind)) return;

  const list = readRecords();
  list.push({ c: name, k: kind, at: Date.now() });
  // 数组按写入顺序追加（最旧在前），超出上限时保留末尾 MAX_RECORDS 条
  writeRecords(list.length > MAX_RECORDS ? list.slice(list.length - MAX_RECORDS) : list);
}

/**
 * 聚合类目得分。
 * - **时间衰减**：30 天前的记录不计入；
 * - 同类目分数封顶 MAX_CATEGORY_SCORE；
 * - 只保留 score > 0；
 * - 按 score 降序（同分按类目名升序，保证结果稳定可测）。
 */
export function getAffinityScores(): Array<{ category: string; score: number }> {
  const freshAfter = Date.now() - DECAY_DAYS * DAY_MS;
  const scores = new Map<string, number>();

  for (const rec of readRecords()) {
    if (rec.at < freshAfter) continue; // 时间衰减
    const weight = AFFINITY_WEIGHTS[rec.k];
    if (!weight) continue;
    scores.set(rec.c, (scores.get(rec.c) || 0) + weight);
  }

  const out: Array<{ category: string; score: number }> = [];
  scores.forEach((score, category) => {
    const capped = Math.min(score, MAX_CATEGORY_SCORE);
    if (capped > 0) out.push({ category, score: capped });
  });
  out.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category));
  return out;
}

/** 得分最高的 n 个类目（回灌给 AI 精选用） */
export function getTopCategories(n = 3): string[] {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return [];
  return getAffinityScores()
    .slice(0, Math.floor(n))
    .map((it) => it.category);
}

/** 清空全部类目偏好 */
export function resetAffinity(): void {
  try {
    Taro.removeStorageSync(AFFINITY_STORAGE_KEY);
  } catch {
    /* 忽略：清不掉也不抛给调用方 */
  }
}

/** 原始记录条数（未做时间衰减，仅供观测 / 上限判断） */
export function getAffinitySize(): number {
  return readRecords().length;
}
