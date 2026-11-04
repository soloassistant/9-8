// ============================================
// 资讯关键词追踪（2026-10-31）：用户盯一组词，命中的资讯在晨报页「追踪」区浮出。
// 产品评估 §7.2 E —— 付费动机④「时效信息差」的最小可行版（PRD v2 P1 挂账项：
// 「自定义关键词追踪」）。与既有 quotes.ts 的 WATCHLIST（自选股）是**两码事**，键名刻意区分。
// 纯函数、零运行时依赖；存储薄壳在调用页（模式同 featureUsage/usageLog 分层）。
// ============================================

/** 追踪词上限 —— 与 WATCHLIST_MAX(8) 同量级，防止清单无限膨胀后每条资讯扫 100 次 */
export const INTEL_WATCH_MAX = 12;
/** 单词长度上限：20 码点足够「以旧换新」「秋招」这类词，也防整段文字当关键词粘进来 */
export const INTEL_WATCH_WORD_MAX = 20;
/** 晨报「追踪」区最多展示的命中条数（展示上限，不是匹配上限） */
export const INTEL_WATCH_MATCH_LIMIT = 10;

/**
 * 解析用户输入的追踪词：中英文逗号/顿号/换行/空白都算分隔；去掉 # 前缀；
 * 去重（英文按小写判重、保留首次出现的原样）；滤空、滤超长。**输入空返回 []**（清空合法）。
 */
export function parseIntelWatchKeywords(raw: string | string[] | undefined | null): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[,，、\n\r;；]+|\s+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const word = String(part || '').trim().replace(/^#+/, '').trim();
    if (!word || word.length > INTEL_WATCH_WORD_MAX) continue;
    const k = word.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(word);
    if (out.length >= INTEL_WATCH_MAX) break;
  }
  return out;
}

/** 一条待匹配资讯的最小形状（热点条目 / 收藏条目都能传进来） */
export interface WatchableItem {
  id?: string | number;
  title?: string;
  summary?: string;
  tags?: string[];
}

export interface WatchMatch<T extends WatchableItem> {
  item: T;
  /** 命中的词（已按用户输入的原样返回） */
  hit: string;
}

/**
 * 关键词匹配：子串包含（title + summary + tags 拼起来查），英文大小写不敏感。
 * 返回顺序与 items 一致（稳定），每条只记**第一个**命中的词；超 limit 的截断。
 * 无关键词返回 []（追踪区整段不渲染 —— 与「没有安排这个事实不许消失」同理，空=功能未启用，不是错）。
 */
export function matchWatchItems<T extends WatchableItem>(
  keywords: string[],
  items: readonly (T | undefined | null)[],
  limit: number = INTEL_WATCH_MATCH_LIMIT
): Array<WatchMatch<T>> {
  const words = (keywords || []).map((w) => String(w || '').trim()).filter(Boolean);
  if (!words.length || !items || !items.length) return [];
  const lower = words.map((w) => w.toLowerCase());
  const out: Array<WatchMatch<T>> = [];
  for (const item of items) {
    if (!item) continue;
    const haystack = [item.title, item.summary, ...(Array.isArray(item.tags) ? item.tags : [])]
      .map((s) => String(s || '').toLowerCase())
      .join('\n');
    if (!haystack) continue;
    for (let i = 0; i < lower.length; i += 1) {
      if (haystack.includes(lower[i])) {
        out.push({ item, hit: words[i] });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}
