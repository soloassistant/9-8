/**
 * 资讯屏蔽清单（v1.2 · C1 批次）
 *
 * 职责：
 * 1. 屏蔽规则的本地持久化读写（storage key: `mb_news_blocklist`）；
 * 2. 命中判定 / 列表过滤（来源 + 话题标签两个维度，PRD Q7 明确不含关键词维度）；
 * 3. 「不再展示此类」半屏选择器所需的纯逻辑（选项构造、勾选切换、草稿收集）；
 * 4. 供「我的」页资讯偏好区（D1 批次）复用的清单管理能力：
 *    listBlockRules / readBlockRulesByDimension / restoreBlockRule / clearBlockRules。
 *
 * 约定：
 * - 全部 storage 读写走 Taro.getStorageSync / setStorageSync + try/catch，失败只 console.warn；
 * - 所有导出函数**绝不 throw**，异常一律降级为「未屏蔽」或空数组；
 * - 纯逻辑（含大小写/空白归一化、去重、选项构造）不依赖 Taro，便于脱离 React 单测；
 * - 阈值与 key 常量一律导出，禁止在调用方写魔法数字。
 */
import Taro from '@tarojs/taro';

/** PRD Q7：本轮屏蔽维度仅「来源」与「话题标签」，不含关键词 */
export type BlockDimension = 'source' | 'tag';

/** 一条已落库的屏蔽规则 */
export interface BlockRule {
  id: string;
  dimension: BlockDimension;
  value: string;
  /** ISO 8601 创建时间 */
  createdAt: string;
}

/** 规则草稿（id 与 createdAt 由本模块生成），供调用方描述「要屏蔽什么」 */
export type BlockRuleDraft = Omit<BlockRule, 'id' | 'createdAt'>;

/** 可被屏蔽的资讯条目最小契约（HotspotNews 天然满足，无需改 types/index.ts） */
export interface Blockable {
  source: string;
  tags: string[];
}

/** 半屏选择器中的单个可勾选项 */
export interface BlockOption {
  /** 稳定唯一键：`${dimension}:${value}` */
  key: string;
  dimension: BlockDimension;
  value: string;
  selected: boolean;
}

/** 半屏选择器按维度分组后的可选项 */
export interface BlockOptionGroups {
  source: BlockOption[];
  tag: BlockOption[];
}

/** storage key（v1.2 全局约定，见设计文档第六章 A） */
export const BLOCKLIST_KEY = 'mb_news_blocklist';

/** 「不再展示此类」默认勾选的主标签个数（PRD N-02：来源 + 主标签） */
export const BLOCK_MAIN_TAG_COUNT = 1;

/** 半屏选择器单个维度展示的可选项上限（超出截断，避免半屏滚动过长） */
export const BLOCK_OPTION_LIMIT = 12;

/* ------------------------------------------------------------------ */
/* 内部纯工具                                                          */
/* ------------------------------------------------------------------ */

/** 归一化：去首尾空白 + 转小写，用于命中判定去重（中文 toLowerCase 无副作用） */
function normalize(value: string): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 由维度 + 取值生成稳定 key（同时用作规则 id，天然幂等去重） */
export function toBlockKey(dimension: BlockDimension, value: string): string {
  return `${dimension}:${normalize(value)}`;
}

/** 维度取值合法性校验（读脏数据时防御） */
function isDimension(value: unknown): value is BlockDimension {
  return value === 'source' || value === 'tag';
}

/** 把未知结构的 storage 结果收敛为 BlockRule[]（脏数据丢弃而非抛错） */
function sanitize(raw: unknown): BlockRule[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockRule[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const rule = item as Partial<BlockRule>;
    if (!isDimension(rule.dimension)) return;
    if (typeof rule.value !== 'string' || !normalize(rule.value)) return;
    const key = toBlockKey(rule.dimension, rule.value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: typeof rule.id === 'string' && rule.id ? rule.id : key,
      dimension: rule.dimension,
      value: rule.value.trim(),
      createdAt:
        typeof rule.createdAt === 'string' && rule.createdAt
          ? rule.createdAt
          : new Date(0).toISOString()
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

/** 读取全部屏蔽规则（读失败 / 脏数据一律返回空数组，绝不 throw） */
export function readBlockRules(): BlockRule[] {
  try {
    return sanitize(Taro.getStorageSync(BLOCKLIST_KEY));
  } catch (err) {
    console.warn('[blocklist] read failed:', err);
    return [];
  }
}

/** 覆盖写入（内部唯一出口，统一 try/catch）；返回实际写入的规则 */
export function writeBlockRules(rules: BlockRule[]): BlockRule[] {
  const next = sanitize(rules);
  try {
    Taro.setStorageSync(BLOCKLIST_KEY, next);
  } catch (err) {
    console.warn('[blocklist] write failed:', err);
  }
  return next;
}

/** 语义别名：供「我的」页资讯偏好区（D1）列出全部已屏蔽项 */
export function listBlockRules(): BlockRule[] {
  return readBlockRules();
}

/** 按维度筛选规则（资讯偏好 UI 分组渲染用） */
export function readBlockRulesByDimension(dimension: BlockDimension): BlockRule[] {
  return readBlockRules().filter((rule) => rule.dimension === dimension);
}

/**
 * 批量新增屏蔽规则（已存在的同维度同取值自动去重覆盖，不产生重复项）。
 * @param drafts 规则草稿数组
 * @returns 写入后的完整规则列表
 */
export function addBlockRules(drafts: BlockRuleDraft[]): BlockRule[] {
  const existing = readBlockRules();
  const map = new Map<string, BlockRule>();
  existing.forEach((rule) => map.set(toBlockKey(rule.dimension, rule.value), rule));
  const now = new Date().toISOString();
  (drafts || []).forEach((draft) => {
    if (!draft || !isDimension(draft.dimension)) return;
    if (typeof draft.value !== 'string' || !normalize(draft.value)) return;
    const key = toBlockKey(draft.dimension, draft.value);
    map.set(key, {
      id: key,
      dimension: draft.dimension,
      value: draft.value.trim(),
      createdAt: now
    });
  });
  return writeBlockRules(Array.from(map.values()));
}

/**
 * 删除一条屏蔽规则。
 * @param target 规则 id（默认 `${dimension}:${value}`）或规则草稿（按维度 + 取值定位）
 */
export function removeBlockRule(target: BlockRuleDraft | string): BlockRule[] {
  const key =
    typeof target === 'string' ? normalize(target) : toBlockKey(target.dimension, target.value);
  if (!key) return readBlockRules();
  return writeBlockRules(readBlockRules().filter((rule) => toBlockKey(rule.dimension, rule.value) !== key));
}

/**
 * 恢复（撤销屏蔽）一条规则 —— 语义等价于删除。
 * @param target 规则 id 或规则草稿，两种形态都支持（D1 页面按 id，热点页按草稿）
 */
export function restoreBlockRule(target: BlockRuleDraft | string): BlockRule[] {
  return removeBlockRule(target);
}

/** 清空全部屏蔽规则（调用方负责二次确认） */
export function clearBlockRules(): void {
  try {
    Taro.setStorageSync(BLOCKLIST_KEY, []);
  } catch (err) {
    console.warn('[blocklist] clear failed:', err);
  }
}

/* ------------------------------------------------------------------ */
/* 命中判定与过滤                                                      */
/* ------------------------------------------------------------------ */

/**
 * 命中判定：任一条规则的取值匹配到来源或任一话题标签即命中。
 * @param item 待判定条目
 * @param rules 可选规则集；不传则实时读 storage（页面可传入 state 中的规则以获得响应式更新）
 */
export function isBlocked(item: Blockable, rules?: BlockRule[]): boolean {
  if (!item) return false;
  const active = rules || readBlockRules();
  if (!active.length) return false;
  const source = normalize(item.source);
  const tags = Array.isArray(item.tags) ? item.tags.map(normalize) : [];
  return active.some((rule) => {
    const value = normalize(rule.value);
    if (!value) return false;
    return rule.dimension === 'source' ? source === value : tags.includes(value);
  });
}

/** 批量过滤：返回未命中屏蔽清单的条目（保持原顺序） */
export function filterBlocked<T extends Blockable>(items: T[], rules?: BlockRule[]): T[] {
  const active = rules || readBlockRules();
  if (!Array.isArray(items)) return [];
  if (!active.length) return items;
  return items.filter((item) => !isBlocked(item, active));
}

/* ------------------------------------------------------------------ */
/* 半屏选择器纯逻辑（N-02）                                            */
/* ------------------------------------------------------------------ */

/**
 * 由条目构造默认勾选建议：来源 + 主标签。
 * 对应 PRD N-02「默认勾选当前条目的来源与其主标签」。
 */
export function suggestBlockRules(item: Blockable): BlockRuleDraft[] {
  if (!item) return [];
  const drafts: BlockRuleDraft[] = [];
  if (typeof item.source === 'string' && normalize(item.source)) {
    drafts.push({ dimension: 'source', value: item.source.trim() });
  }
  const tags = (Array.isArray(item.tags) ? item.tags : [])
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter(Boolean)
    .slice(0, BLOCK_MAIN_TAG_COUNT);
  tags.forEach((tag) => drafts.push({ dimension: 'tag', value: tag }));
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    const key = toBlockKey(draft.dimension, draft.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 按「当前条目优先、其余保持首次出现顺序」收集去重取值 */
function collectValues(current: string[], pool: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  [...current, ...pool].forEach((raw) => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const key = normalize(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  });
  return out.slice(0, BLOCK_OPTION_LIMIT);
}

/**
 * 构造半屏选择器的可选项（来源组 + 话题标签组），默认勾选当前条目的来源与主标签。
 * @param items 当前可见列表（提供可屏蔽的取值范围）
 * @param current 触发「不再展示此类」的那一条
 */
export function buildBlockOptions(items: Blockable[], current: Blockable): BlockOptionGroups {
  const list = Array.isArray(items) ? items : [];
  const target = current || ({ source: '', tags: [] } as Blockable);
  const defaults = new Set(suggestBlockRules(target).map((draft) => toBlockKey(draft.dimension, draft.value)));

  const toOptions = (dimension: BlockDimension, pool: string[]): BlockOption[] =>
    collectValues(dimension === 'source' ? [target.source] : target.tags || [], pool).map((value) => {
      const key = toBlockKey(dimension, value);
      return { key, dimension, value, selected: defaults.has(key) };
    });

  return {
    source: toOptions('source', list.map((item) => item.source)),
    tag: toOptions('tag', list.reduce<string[]>((acc, item) => acc.concat(item.tags || []), []))
  };
}

/** 切换某一项的勾选态（不可变更新，返回新分组对象） */
export function toggleBlockOption(groups: BlockOptionGroups, key: string): BlockOptionGroups {
  const toggle = (options: BlockOption[]): BlockOption[] =>
    options.map((option) => (option.key === key ? { ...option, selected: !option.selected } : option));
  return { source: toggle(groups.source), tag: toggle(groups.tag) };
}

/** 收集已勾选项对应的规则草稿（供 addBlockRules 一次性落库） */
export function collectBlockDrafts(groups: BlockOptionGroups): BlockRuleDraft[] {
  return [...groups.source, ...groups.tag]
    .filter((option) => option.selected)
    .map((option) => ({ dimension: option.dimension, value: option.value }));
}

/** 已勾选数量（用于确认按钮文案计数与置灰判定） */
export function countBlockSelected(groups: BlockOptionGroups): number {
  return collectBlockDrafts(groups).length;
}
