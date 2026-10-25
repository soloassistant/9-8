/**
 * 突发/重大新闻识别（纯逻辑，无 Taro / React 依赖 —— 便于门禁直接跑运行时断言）
 *
 * ## 评估机制（2026-10-25 从「单关键词命中」升级为「评分制」）
 *
 * 旧版判据只有「标题含关键词」一条，三个真实弱点：单源标题党就能触发、旧闻也顶横幅、
 * 无强度分级。升级后一条横幅要过三道闸：
 *
 * 1. **时效闸（硬）**：条目 createTime 距今 > 24h 直接不参与 —— 「预警」是昨天的就不算突发。
 *    createTime 缺失/不可解析时**保守放行**（晨报 intelItems 现无该字段，宁可多亮一次
 *    也不静默漏报；数据源将来补时间即自动生效）。
 * 2. **关键词闸（硬）**：标题含「事件型」关键词（表见下）。刻意不含「震惊/重磅」类标题党词 ——
 *    否则横幅天天亮，等于没有横幅。
 * 3. **强度分级（软）**：level 1 = 单条单词命中（现有形态）；level 2 = **多源交叉**（≥2 条
 *    **不同来源**的条目各自命中关键词）或 单条**双词命中**（如「地震」+「预警」同现）。
 *    level 2 横幅措辞更重（「多条来源均在报道」），但仍不写「已确认/紧急通知」——
 *    关键词识别永远不是官方通报。
 *
 * 误报仍不可避免：调用方必须常驻免责说明、且允许用户关掉（见 components/BurstBanner）。
 */

export interface BurstItem {
  text: string;
  source: string;
  /** 条目发布时间（ISO 串）。缺失按「不过滤」处理（保守放行，见时效闸说明） */
  createTime?: string;
}

/** 单条条目距今超过该小时数即视为旧闻，不参与突发评估（依据：突发事件的新闻半衰期
 *  通常 <12h，24h 已留一倍余量；再久就不是「突发」而是「回顾」） */
export const BURST_FRESH_HOURS = 24;

export const BURST_KEYWORDS = [
  '地震',
  '台风',
  '暴雨',
  '暴雪',
  '洪水',
  '泥石流',
  '塌方',
  '山体滑坡',
  '海啸',
  '预警',
  '突发',
  '爆炸',
  '起火',
  '火灾',
  '事故',
  '坠机',
  '空难',
  '停运',
  '停产',
  '熔断',
  '战争',
  '制裁',
  // 英文事件词（2026-10-25 国际源接入后补）：国际源标题是英文，中文词表永远命不中。
  // 刻意只收**低歧义**长词 —— fire/crash/war 这类短词在英文标题里歧义太大
  // （"Fire TV"、"market crash"），宁缺勿滥；与中文表一样不含 clickbait 词。
  'earthquake',
  'typhoon',
  'tsunami',
  'landslide',
  'explosion',
  'airstrike',
  'sanctions'
];

export interface BurstHit {
  text: string;
  source: string;
  /** 强度：1 = 单条单词命中；2 = 多源交叉或单条双词（横幅措辞分级用） */
  level: 1 | 2;
  /** level 2 时的佐证：同样命中的其他来源媒体名（level 1 为空数组） */
  alsoSources: string[];
}

function keywordHits(text: string): number {
  let n = 0;
  // 英文词表全小写：标题句首大写（Earthquake Hits…）必须 toLowerCase 再比，
  // 否则国际源大半漏报（2026-10-25 审计 #1，实测 6 个典型标题 3 个命不中）
  const lower = text.toLowerCase();
  for (const kw of BURST_KEYWORDS) if (lower.includes(kw)) n++;
  return n;
}

/** 时效闸：>24h 的旧闻 false；缺失/解析失败 true（保守放行） */
function isFresh(createTime?: string): boolean {
  if (!createTime) return true;
  const ts = Date.parse(createTime);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts <= BURST_FRESH_HOURS * 3600 * 1000;
}

/**
 * 从情报条目里挑突发信号最强的。
 *
 * 没有命中返回 **null** —— 刻意不退化成「挑第一条」：那会让横幅天天挂着一条普通新闻，
 * 很快就被当成装饰物忽略掉，真出事时反而不起作用。
 * 多条命中时优先 level 2（多源交叉），同级按出现顺序取第一条。
 */
export function pickBurst(items?: BurstItem[] | null): BurstHit | null {
  if (!Array.isArray(items)) return null;
  const hits: BurstHit[] = [];
  for (const item of items) {
    const text = String(item?.text || '');
    const source = String(item?.source || '');
    if (!text) continue;
    if (!isFresh(item?.createTime)) continue;
    const kwHits = keywordHits(text);
    if (kwHits === 0) continue;
    hits.push({
      text,
      source,
      level: kwHits >= 2 ? 2 : 1,
      alsoSources: []
    });
  }
  if (hits.length === 0) return null;

  // 多源交叉：不同 source 各自命中（同来源多条不算交叉 —— 镜像稿常见）
  const sources = new Set(hits.map((h) => h.source || '(未知来源)'));
  if (sources.size >= 2) {
    // 取首条作为主体，其余来源名进 alsoSources（上限 3，横幅一行放得下）。
    // '(未知来源)' 是内部占位符不是媒体名 —— 空来源条目参与了交叉可以（数据事实），
    // 但不能把占位符印给用户看（2026-10-25 审计 #3）
    const first = hits[0];
    const others = [...sources]
      .filter((s) => s !== first.source && s !== '(未知来源)')
      .slice(0, 3);
    return { ...first, level: 2, alsoSources: others };
  }
  // 无交叉：优先单条双词命中（level 2），否则第一条
  return hits.find((h) => h.level === 2) ?? hits[0];
}
