/**
 * 图片 URL 改写 + 不可用图片剔除 —— 纯函数，无副作用，双端通用（可单测）。
 *
 * 背景（2026-11-05）：卡片里的封面框最大只有 218×123 px（420rpx × 236rpx），但数据源
 * 常常给 1920~2560 px 的原图 —— 浏览器只是把它**缩小绘制**，代价落在两处：
 * ① 下载字节（~300 KB/张）；② 解码内存（2560×1440 RGBA ≈ 14 MiB/张）。
 *
 * 修复点是「数据层给错尺寸」，而非 CSS。B 站 CDN（i0/i1/i2.hdslb.com）支持
 * `@<w>w_<h>h_1c.<fmt>` 缩放后缀，实测同一张封面从 297,114 B 降到 12,622 B。
 *
 * **只改确定支持的宿主**：hdslb 之外的 URL 一律原样返回 —— 不做「猜个参数试试」。
 * 实测反例：tmtpost 的 `?imageView2/2/w/640` 返回的字节比原图**更大**（239,081 → 270,686），
 * imagetools 同。瞎猜参数只会把图画糊或者变大。
 */

/** 缩略图桶宽（px）：卡片框 218px，按 2x DPR 取 480 */
export const THUMB_W = 480;
/** 缩略图桶高（px）：16:9 */
export const THUMB_H = 270;

/** hdslb 图片后缀（B 站 CDN 在真实文件后接 `@`，可用它做服务端缩放/转码） */
const HDSLB_HOST_RE = /^[a-z0-9-]+\.hdslb\.com$/i;
/** 只对「确实像图片文件」的路径改写；没有扩展名的接口地址不碰 */
const IMAGE_EXT_RE = /\.(?:jpg|jpeg|png|webp|gif|avif)$/i;

/** 已知永久不可用的图源（源站侧拒，换 Referer 也救不回来）。
 *
 *  npr.brightspotcdn.com 实测（2026-11-05）：不带 Referer / 带本应用 Referer /
 *  带 npr.org Referer 三种情况**全部 403 + 986 B HTML** —— 属 WAF/已删/反爬之一，
 *  不是防盗链。入库即剔除，避免每一屏都重试一次必败请求。 */
const DEAD_IMAGE_HOSTS = ['npr.brightspotcdn.com'];

/** 1×1 追踪像素：形如 `/pixel.gif`、`/1x1.png`、`/spacer.gif`、`/beacon.png`；
 *  只认**文件名本身**是这些词，避免把 `/pixel-art.jpg` 这类真实配图误杀 */
const TRACKING_PIXEL_RE =
  /(?:^|[/_.-])(?:1x1|pixel|spacer|blank|transparent|beacon|impression)\.(?:gif|png|jpg|jpeg|webp|avif)(?:[?#]|$)/i;

/** 显式声明 1px 的查询参数（`?w=1` / `?width=1` / `&h=1`）；`width=100` 不会命中 */
const ONE_PX_QUERY_RE = /[?&](?:w|width|h|height)=1(?:&|$)/i;

/** 取 URL 的 host（小写、去端口）；非法/相对地址返回空串 */
function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  if (!m) return '';
  return m[1].toLowerCase().replace(/\s/g, '').replace(/:\d+$/, '');
}

/**
 * 把图片 URL 改写成显示尺寸合适的缩略图。
 *
 * - hdslb（i0/i1/i2.hdslb.com）→ 加/替换 `@480w_270h_1c.webp`；
 * - 其它宿主（含相对路径、非法值）→ **原样返回**，不做任何猜测；
 * - 已有 `@xxx` 后缀（如 `@100w_100h_1c.png`）→ 覆盖成新的桶宽；
 * - query / hash 原样保留（部分源站靠 query 才能取图）。
 *
 * @param src 原图 URL（可为空/非串）
 * @param w 目标宽（px）
 * @param h 目标高（px）
 */
export function thumbUrl(src: string | undefined | null, w = THUMB_W, h = THUMB_H): string | undefined {
  if (typeof src !== 'string' || !src) return undefined;
  const url = src.trim();
  if (!url || !HDSLB_HOST_RE.test(hostOf(url))) return src;

  // 拆 hash / query：只对路径部分做后缀替换
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
  const qIdx = noHash.indexOf('?');
  const pathPart = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  const query = qIdx >= 0 ? noHash.slice(qIdx) : '';

  // `@` 只从路径起点找，避免把 userinfo 里的 `@` 当后缀分隔符
  const schemeEnd = pathPart.indexOf('://');
  const pathStart = schemeEnd >= 0 ? pathPart.indexOf('/', schemeEnd + 3) : 0;
  const atIdx = pathPart.indexOf('@', pathStart >= 0 ? pathStart : 0);
  const base = atIdx >= 0 ? pathPart.slice(0, atIdx) : pathPart;

  // 不是图片文件（无扩展名 / 接口地址）→ 不改写，宁可原样慢慢加载，也不猜坏
  if (!IMAGE_EXT_RE.test(base)) return src;

  return `${base}@${w}w_${h}h_1c.webp${query}`;
}

/**
 * 是否应当**入库即丢弃**这张图（true = 丢弃）。
 *
 * 判据只有三条，全部是「确定不可用」，不含任何「看起来可疑」：
 * 1. 非 http(s) / 空值；
 * 2. 1×1 追踪像素（文件名或 1px 查询参数）；
 * 3. 已知永久失效源站（`DEAD_IMAGE_HOSTS`）。
 *
 * 丢弃发生在**数据入库侧**（云函数 / 构建抓取 / 前端归一化），这样 UI 不会
 * 每一屏都为一个必败 URL 发一次请求再走 onError 兜底。
 */
export function isDroppableImage(src: unknown): boolean {
  if (typeof src !== 'string') return true;
  const s = src.trim();
  if (!s || !/^https?:\/\//i.test(s)) return true;
  const host = hostOf(s);
  if (DEAD_IMAGE_HOSTS.some((bad) => host === bad || host.endsWith(`.${bad}`))) return true;
  return TRACKING_PIXEL_RE.test(s) || ONE_PX_QUERY_RE.test(s);
}
