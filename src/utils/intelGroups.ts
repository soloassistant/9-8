/**
 * 晨报「情报」主题分组 + 导语 + 内联引用 —— 纯逻辑层（可单测）。
 *
 * 借鉴 Readless 的「两遍合成」：第一遍在云端由一个 LLM 调用直接产出分组
 * （group → 导语 + 组内条目，条目带 `[n]` 引用序号）；前端只做「渲染 + 容错降级」，
 * 不做二次语义分组（离线关键词聚类质量远不如 LLM，故仅作兜底）。
 *
 * 设计约束（铁律）：
 * 1. **类型就近原则**：`IntelGroup` 等类型定义在本文件，**不修改冻结的 `src/types/index.ts`**。
 *    云端 `groups` 是「宽化读取」——`BriefingIntel` 上没有该字段，故用 `unknown` 入参归一化。
 * 2. **纯函数、无副作用、不 import React**：便于单测；唯一外部依赖是类型零依赖。
 * 3. **绝不抛错**：任何脏数据（null / 非数组 / 缺字段 / 越界引用）都降级，让 UI 不崩。
 *
 * 双端渲染说明：导语内联引用用 `[n]` 标记，前端 `splitLeadSegments()` 分段后以**嵌套 `<Text>`**
 * 渲染（weapp 与 H5 均支持）；**不使用 HTML / dangerouslySetInnerHTML**（小程序端不支持）。
 */

/* ---------------- 常量（禁止魔法数字） ---------------- */

/** 组数上限：过多分组会稀释「导语」价值，参考 Readless 取 2-4 组 */
export const INTEL_GROUP_MAX = 4;

/** 组标题长度上限（字符数，超长截断，避免溢出卡片） */
export const INTEL_GROUP_TITLE_MAX = 12;

/** 导语长度上限（字符数）：1-2 句、便于双端单屏读数 */
export const INTEL_LEAD_MAX = 60;

/** 每组条目数上限（避免单组条目过多撑爆卡片） */
export const INTEL_GROUP_ITEMS_MAX = 6;

/** 本地兜底分组时的默认组标题（无法归类的杂项统一进此组） */
export const INTEL_FALLBACK_TITLE = '综合资讯';

/** 单条情报文本长度上限（与云端 fallbackIntel 的 80 字口径对齐） */
export const INTEL_ITEM_TEXT_MAX = 80;

/** 越界引用的降级占位文案前缀（保持与 `[n]` 视觉一致的纯文本，不产生引用段） */
export const INTEL_CITE_OPEN = '[';
/** 越界引用的降级占位文案后缀 */
export const INTEL_CITE_CLOSE = ']';

/**
 * 关键词 → 主题名 映射表（本地兜底分组用）。
 * 顺序敏感：命中越多关键词的主题优先；都未命中则进 `INTEL_FALLBACK_TITLE`。
 * 用中文主题名（产品默认中文语境；英文界面下前端可用 i18n 覆盖标题，条目文本不翻译）。
 */
const LOCAL_TOPIC_RULES: Array<{ title: string; keywords: string[] }> = [
  { title: '科技前沿', keywords: ['AI', '人工智能', '芯片', '算法', '算力', '大模型', '半导体', '科技', '开源'] },
  { title: '商业财经', keywords: ['商业', '融资', '营收', '市场', 'IPO', '上市', '经济', '股', '投资', '利润', '财报'] },
  { title: '时事政策', keywords: ['时事', '政策', '监管', '政府', '法案', '会议', '发布', '国际', '外交'] },
  { title: '产品生活', keywords: ['产品', '体验', '应用', '工具', '生活', '健康', '出行', '消费', '攻略'] }
];

/* ---------------- 类型（就近定义） ---------------- */

/** 情报条目引用（与云端 `intelItems` 元素同形） */
export interface IntelSourceRef {
  /** 条目正文（一句话概要） */
  text: string;
  /** 来源媒体名（合规要求：来源必须可见） */
  source: string;
}

/**
 * 情报主题分组：一段 AI 导语 + 组内条目。
 * `citations` 为导语内 `[n]` 槽位（1-based）引用的条目**索引集合**（0-based），
 * 由 `normalizeGroups` 计算，供 UI 校验引用是否越界。
 */
export interface IntelGroup {
  /** 组标题（主题名，≤ INTEL_GROUP_TITLE_MAX） */
  title: string;
  /** AI 导语（1-2 句，可能含 `[n]` 内联引用标记），属 AI 生成内容需标识 */
  lead: string;
  /** 组内条目 */
  items: IntelSourceRef[];
}

/** 导语分段结果：普通文本段 或 内联引用段 */
export interface IntelLeadSegment {
  /** 段类型：文本 / 引用 */
  type: 'text' | 'cite';
  /** 展示文本：text 段为原文；cite 段为 `[n]` 原文（含方括号） */
  text: string;
  /** cite 段的 0-based 条目索引（仅 type==='cite' 时存在），供点击定位来源 */
  index?: number;
}

/** `normalizeGroups` 的统一载荷：分组 + 降级标记（承载 `intel.degraded` 语义） */
export interface IntelGroupsPayload {
  /** 归一化后的分组（可能为空数组，调用方需自行决定是否走本地兜底） */
  groups: IntelGroup[];
  /** 是否降级（true = **本该有 AI 却没拿到**，UI 应挂 `intelRawNote`）
   *
   *  ⚠️ 不要用它表达「这条内容来自 RSS」。免费档按设计就没有 AI，不算降级；
   *     早期版本把免费档硬编码成 degraded:true，导致前端对免费用户**永久**显示
   *     「AI 提炼暂不可用」——明明没坏却一直显示坏了。区分见 `aiEnabled`。 */
  degraded: boolean;
  /** 本档位是否**按设计**提供 AI 提炼（free=false / pro=true）。
   *  `aiEnabled=false` 时 UI 应显示**档位说明**（如「免费版·来自公开 RSS」），
   *  `aiEnabled=true && degraded=true` 时才显示**错误提示**。 */
  aiEnabled: boolean;
  /** 是否由本地关键词兜底分组产生（前端可据此决定是否提示「已本地归并」） */
  localFallback: boolean;
}

/* ---------------- 工具函数（内部） ---------------- */

/** 判断是否非空字符串 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 安全截断字符串（保留前后空白清理；超长按字符数截断并加省略号） */
function clampText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 归一化单条引用：缺 text/source 的条目丢弃（返回 null，由调用方 filter） */
function normalizeRef(raw: unknown): IntelSourceRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const text = clampText(obj.text, INTEL_ITEM_TEXT_MAX);
  if (!text) return null;
  const source = isNonEmptyString(obj.source) ? String(obj.source).trim() : '综合';
  return { text, source };
}

/* ---------------- 公共 API ---------------- */

/**
 * 把导语文本按 `[n]` 标记拆成「文本段 + 引用段」序列，供双端以嵌套 `<Text>` 渲染。
 *
 * 边界处理（全部不抛错）：
 * - 非字符串 / 空串 → 返回 `[]`；
 * - 无 `[n]` 的纯文本 → 返回单个 `text` 段；
 * - 连续标记 `"A[1][2]B"` → 正确切出两个独立引用段；
 * - 行首/行尾标记 → 正确切出（不产生多余空文本段）；
 * - **越界引用**（序号 > itemCount）：`itemCount` 提供且该序号越界时，**降级为纯文本段**（保留 `[n]` 原样），
 *   不产生 `cite` 段，避免 UI 点击到不存在的条目而崩溃；
 * - `itemCount` 未提供（undefined）→ 视为不校验，所有 `[n]` 都切为 `cite` 段。
 *
 * @param lead 导语原文
 * @param itemCount 该组条目数（用于越界校验，选填）
 * @returns 分段数组（可能为空）
 */
export function splitLeadSegments(lead: string, itemCount?: number): IntelLeadSegment[] {
  if (!isNonEmptyString(lead)) return [];
  // 允许校验但条目数为 0 时，任何 [n] 都必然越界 → 直接返回整段纯文本
  const validate = typeof itemCount === 'number' && Number.isFinite(itemCount);
  const total = validate ? Math.max(0, Math.floor(itemCount as number)) : 0;

  const segments: IntelLeadSegment[] = [];
  const re = /\[(\d{1,3})\]/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(lead);
  while (m) {
    const n = Number(m[1]);
    const start = m.index;
    // 标记前的普通文本（非空才 push，避免行首/连续标记产生空文本段）
    if (start > lastIndex) {
      segments.push({ type: 'text', text: lead.slice(lastIndex, start) });
    }
    const outOfRange = validate && (n < 1 || n > total);
    if (outOfRange) {
      // 越界：降级为纯文本（保留 `[n]` 原样），不与前一段合并以免引入额外逻辑分支
      segments.push({ type: 'text', text: `${INTEL_CITE_OPEN}${m[1]}${INTEL_CITE_CLOSE}` });
    } else {
      segments.push({ type: 'cite', text: `${INTEL_CITE_OPEN}${m[1]}${INTEL_CITE_CLOSE}`, index: n - 1 });
    }
    lastIndex = start + m[0].length;
    m = re.exec(lead);
  }
  // 末尾剩余文本
  if (lastIndex < lead.length) {
    segments.push({ type: 'text', text: lead.slice(lastIndex) });
  }
  // 全为标记且恰好切完时，segments 可能仅含 cite 段；若一个都没切出则回退为整段
  if (segments.length === 0) {
    segments.push({ type: 'text', text: lead });
  }
  return segments;
}

/**
 * 收敛云端返回的分组脏数据，输出可安全渲染的 `IntelGroupsPayload`。
 *
 * 兼容策略：
 * - `raw` 非数组 / 长度为 0 → 返回 `{ groups: [], degraded: true, localFallback: false }`，
 *   **由调用方决定是否走 `groupIntelLocally` 兜底**（不在此处隐式兜底）；
 * - 每个分组的 `title` / `lead` / `items` 缺字段都做降级（丢弃非法组 / 条目）；
 * - 组数 / 标题长度 / 条目数均按常量截断。
 *
 * @param raw 云端 `intel.groups`（未知形状）
 * @param degradedHint 云端 `intel.degraded`（可选，缺省按 true 处理，宁降级不误标）
 * @param aiEnabledHint 云端 `intel.aiEnabled`（可选，**缺省按 true** —— 旧服务端没有这个字段时，
 *   保守假设「本该有 AI」，从而保持旧行为：降级提示照常显示，不会把真故障误标成档位说明）
 */
export function normalizeGroups(
  raw: unknown,
  degradedHint?: boolean,
  aiEnabledHint?: boolean
): IntelGroupsPayload {
  const degraded = typeof degradedHint === 'boolean' ? degradedHint : true;
  const aiEnabled = typeof aiEnabledHint === 'boolean' ? aiEnabledHint : true;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { groups: [], degraded, aiEnabled, localFallback: false };
  }
  const groups: IntelGroup[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const rawItems = Array.isArray(obj.items) ? obj.items : [];
    const items = rawItems
      .map(normalizeRef)
      .filter((r): r is IntelSourceRef => r !== null)
      .slice(0, INTEL_GROUP_ITEMS_MAX);
    // 无有效条目 → 该组无意义（导语引用将全部越界），丢弃
    if (items.length === 0) continue;
    const lead = clampText(obj.lead, INTEL_LEAD_MAX);
    if (!lead) continue; // 无导语的分组退化为平铺，语义不符，丢弃
    const title = clampText(obj.title, INTEL_GROUP_TITLE_MAX) || INTEL_FALLBACK_TITLE;
    groups.push({ title, lead, items });
    if (groups.length >= INTEL_GROUP_MAX) break;
  }
  return { groups, degraded, aiEnabled, localFallback: false };
}

/**
 * 前端本地关键词兜底分组（**无 LLM / 旧数据时的降级路径**）。
 *
 * 语义聚类质量有限，仅保证「不空手」：按 `LOCAL_TOPIC_RULES` 命中数最多的主题归类，
 * 未命中的条目统一进 `INTEL_FALLBACK_TITLE` 组；导语为**纯文本拼接**（不含 `[n]`，
 * 故不会产生引用段，渲染安全），并明确由调用方挂 `intelRawNote` 降级标识。
 *
 * @param items 原始情报条目（可能含脏数据）
 * @returns 分组数组（无有效条目时返回 `[]`）；不抛错
 */
export function groupIntelLocally(items: unknown): IntelGroup[] {
  if (!Array.isArray(items)) return [];
  const refs = items
    .map(normalizeRef)
    .filter((r): r is IntelSourceRef => r !== null)
    .slice(0, INTEL_GROUP_MAX * INTEL_GROUP_ITEMS_MAX);
  if (refs.length === 0) return [];

  // 主题桶：命中规则即入桶（一条只进命中数最高的桶）
  const buckets = new Map<string, IntelSourceRef[]>();
  for (const ref of refs) {
    const haystack = `${ref.text} ${ref.source}`;
    let bestTitle = INTEL_FALLBACK_TITLE;
    let bestHits = 0;
    for (const rule of LOCAL_TOPIC_RULES) {
      const hits = rule.keywords.filter((k) => haystack.includes(k)).length;
      if (hits > bestHits) {
        bestHits = hits;
        bestTitle = rule.title;
      }
    }
    const list = buckets.get(bestTitle) || [];
    list.push(ref);
    buckets.set(bestTitle, list);
  }

  // 有序输出：先按规则表顺序输出有内容的主题，最后放杂项组
  const orderedTitles: string[] = [];
  for (const rule of LOCAL_TOPIC_RULES) {
    if (buckets.has(rule.title) && (buckets.get(rule.title) || []).length > 0) orderedTitles.push(rule.title);
  }
  if (buckets.has(INTEL_FALLBACK_TITLE)) orderedTitles.push(INTEL_FALLBACK_TITLE);

  const groups: IntelGroup[] = [];
  for (const title of orderedTitles) {
    const list = (buckets.get(title) || []).slice(0, INTEL_GROUP_ITEMS_MAX);
    if (list.length === 0) continue;
    // 本地导语：纯文本摘要拼接（不含 [n]，渲染安全），说明本组含几条资讯
    const lead = clampText(`${title}：共 ${list.length} 条相关资讯`, INTEL_LEAD_MAX);
    groups.push({ title, lead, items: list });
    if (groups.length >= INTEL_GROUP_MAX) break;
  }
  return groups;
}

/**
 * 端到端归一化入口：优先用云端分组，无分组则本地兜底，均无则返回空。
 *
 * 决策树（与架构设计 3.6 流程图一致）：
 * 1. `intel.groups` 合法 → `normalizeGroups`，`localFallback=false`；
 * 2. 无 `groups` 但 `intelItems` 存在 → `groupIntelLocally`，`localFallback=true`；
 * 3. 都无 → 空分组（调用方不渲染情报区块）。
 *
 * ⚠️ 路径② 的 `degraded` **不是恒 true**（2026-10-08 修正）。
 *   免费档按设计没有 AI，`aiEnabled=false`：走本地分组是**既定行为**而非降级，
 *   此时若再返回 degraded:true，前端就会对免费用户永久显示「AI 提炼暂不可用」。
 *   反过来，订阅档（`aiEnabled=true`）落到本地兜底**确实**说明 LLM 没给出分组，
 *   必须标 degraded 让用户看到提示。
 *
 * @param intel 云端 `BriefingIntel`（宽化读取，允许未知字段）
 */
export function resolveIntelGroups(intel: unknown): IntelGroupsPayload {
  if (!intel || typeof intel !== 'object') {
    return { groups: [], degraded: true, aiEnabled: true, localFallback: false };
  }
  const obj = intel as Record<string, unknown>;
  const degradedHint = typeof obj.degraded === 'boolean' ? obj.degraded : undefined;
  // 缺省 true：旧服务端没有该字段时保守按「本该有 AI」处理，保持旧行为不回归
  const aiEnabled = typeof obj.aiEnabled === 'boolean' ? obj.aiEnabled : true;

  // ① 云端分组优先（LLM 语义聚类，质量最高）
  if (Array.isArray(obj.groups) && obj.groups.length > 0) {
    const payload = normalizeGroups(obj.groups, degradedHint, aiEnabled);
    if (payload.groups.length > 0) return payload;
  }

  // ② 无分组 → 本地关键词兜底。仅当本档位**本该有 AI** 时才算降级
  const local = groupIntelLocally(obj.intelItems);
  if (local.length > 0) {
    return { groups: local, degraded: aiEnabled, aiEnabled, localFallback: true };
  }

  // ③ 都无 → 空载荷（不渲染情报区块）
  return { groups: [], degraded: degradedHint ?? true, aiEnabled, localFallback: false };
}
