/**
 * 视频新闻（B站热榜入口）—— 纯逻辑层（可单测）。
 *
 * 与 `intelGroups.ts` 同范式的「就近定义」：类型放本文件，**不修改冻结的
 * `src/types/index.ts`**；云端 `webSearch` action=videoNews 返回的是宽化未知数据，
 * 由本文件 `normalizeVideoItems` 收敛成可安全渲染的形状。
 *
 * 合规口径（与云端注释一致）：
 *  · 本产品**不转载视频内容**，只做带来源标注（source 恒为「哔哩哔哩」）的跳转入口；
 *  · UP主投稿标题属 UGC，不经过 news-trust 信任过滤 —— 该过滤防的是「进 LLM prompt
 *    的内容带注入」，而视频条目直出前端渲染纯文本，不进任何模型。
 */

/** 视频新闻条目（云端 videoNews 契约） */
export interface VideoNewsItem {
  /** `bili-<bvid>` */
  id: string;
  /** 视频标题（≤80 字） */
  title: string;
  /** 视频简介（可空） */
  summary: string;
  /** 来源媒体名（恒为「哔哩哔哩」，合规要求可见） */
  source: string;
  /** 视频页链接（https://www.bilibili.com/video/BV...） */
  url: string;
  /** 封面图（https） */
  image?: string;
  /** 时长 mm:ss 或 h:mm:ss */
  duration?: string;
  /** UP主名 */
  author?: string;
  /** 播放量 */
  play?: number;
}

/** 来源标注（恒值，单独导出供 UI/测试引用，避免散落魔法字符串） */
export const VIDEO_NEWS_SOURCE = '哔哩哔哩';

/** 视频条数上限：产品口径「一项视频新闻」，多给的前端也不要 */
export const VIDEO_NEWS_MAX = 1;

/** B站视频页 URL 准入（唯一合法形态；其余一律丢弃，防开放跳转被滥用） */
const BILI_URL_RE = /^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]{10,}$/;

/** 媒体 URL 准入：仅 http/https、≤512 字符（与云端 safeMediaUrl / intelGroups 同口径） */
function safeMediaUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 512) return undefined;
  return /^https?:\/\//i.test(s) ? s : undefined;
}

/** 时长形态准入：mm:ss / h:mm:ss */
function safeDuration(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(s) ? s : undefined;
}

/** 播放量格式化：4289090 → 「428.9万」；0/缺失/非法 → 空串（调用方据此不渲染该段）。
 *  0 归入「无意义数据」而非显示「播放 0」：热榜视频播放量恒 >0，出现 0 只可能是
 *  字段缺失/异常，显示出来像渲染 bug；宁可不显示，不显示一个吓人的数字。 */
export function formatPlayCount(play?: number): string {
  if (typeof play !== 'number' || !Number.isFinite(play) || play <= 0) return '';
  if (play >= 1e8) return `${(play / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (play >= 1e4) return `${(play / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return String(Math.floor(play));
}

/**
 * 收敛云端 videoNews 脏数据 → 可安全渲染的条目数组。
 *
 * 规则（任一不满足即丢弃该条，绝不抛错）：
 *  · title 非空（≤80 字）；url 必须匹配 B站视频页形态；
 *  · image 仅放行 http/https；duration 仅放行 mm:ss 形态；play 仅放行非负整数；
 *  · source 缺失时兜底为 `VIDEO_NEWS_SOURCE`（不允许来源不可见）；
 *  · 总数封顶 VIDEO_NEWS_MAX。
 */
export function normalizeVideoItems(raw: unknown): VideoNewsItem[] {
  if (!Array.isArray(raw)) return [];
  const out: VideoNewsItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, 80) : '';
    if (!title) continue;
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!BILI_URL_RE.test(url)) continue;
    const image = safeMediaUrl(obj.image);
    const duration = safeDuration(obj.duration);
    const author = typeof obj.author === 'string' && obj.author.trim() ? obj.author.trim().slice(0, 30) : undefined;
    const play = Number.isInteger(obj.play) && (obj.play as number) >= 0 ? (obj.play as number) : undefined;
    const entry: VideoNewsItem = {
      id: typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim().slice(0, 64) : `bili-${title.slice(0, 24)}`,
      title,
      summary: typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 120) : '',
      source: VIDEO_NEWS_SOURCE,
      url,
      ...(image ? { image } : {}),
      ...(duration ? { duration } : {}),
      ...(author ? { author } : {}),
      ...(play !== undefined ? { play } : {})
    };
    out.push(entry);
    if (out.length >= VIDEO_NEWS_MAX) break;
  }
  return out;
}
