/**
 * 突发/重大新闻识别（纯逻辑，无 Taro / React 依赖 —— 便于门禁直接跑运行时断言）
 *
 * 判据只有一条：**公开新闻源的标题里出现了「事件型」关键词**。
 * 所以它必然有误报，调用方必须常驻免责说明、且允许用户关掉（见 components/BurstBanner）。
 *
 * 关键词取舍：只放「一旦发生，用户真的想马上知道」的事件词，
 * 不放「震惊 / 重磅 / 揭秘」这类标题党词 —— 后者会让横幅天天亮，等于没有横幅。
 */

export interface BurstItem {
  text: string;
  source: string;
}

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
  '制裁'
];

/**
 * 从情报条目里挑第一条命中突发关键词的。
 *
 * 没有命中返回 **null** —— 刻意不退化成「挑第一条」：那会让横幅天天挂着一条普通新闻，
 * 很快就被当成装饰物忽略掉，真出事时反而不起作用。
 */
export function pickBurst(items?: BurstItem[] | null): BurstItem | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const text = String(item?.text || '');
    if (!text) continue;
    if (BURST_KEYWORDS.some((kw) => text.includes(kw))) {
      return { text, source: String(item.source || '') };
    }
  }
  return null;
}
