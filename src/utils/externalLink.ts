import Taro from '@tarojs/taro';

const isH5 = process.env.TARO_ENV === 'h5';

export type OpenExternalResult = 'opened' | 'copied' | 'failed';

/** 允许外链跳转的协议白名单。
 *
 *  为什么必须白名单（2026-10-12 安全审计）：`url` 来自 **RSS 抓回来的外部内容**，不是自家数据。
 *  一条被投毒的源只要给出 `javascript:...`，H5 分支的 `window.location.href = url`（弹窗被拦时的
 *  降级路径）就会在**当前页上下文**执行它 —— 这是实打实的存储型 XSS，而不只是「打开了个奇怪页面」。
 *  小程序分支虽然只是复制到剪贴板，但复制出去的同样是有害载荷，用户粘到地址栏就中招。
 *
 *  只放行 http/https：外链场景没有任何需要 javascript:/data:/file: 的合法用途。 */
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/** 校验外链地址是否可安全跳转。非 http(s)、非站内绝对路径、解析失败、空串一律判否。
 *
 *  ⚠️ 2026-10-12 修：最初版本只认绝对 http(s)，把**站内绝对路径**一起拒了。
 *  但本应用自己就有一个合法的站内路径调用点 —— H5 端省心买入口正是
 *  `SXM_H5_PATH = '/sxm/index.html'`（同源子页，见 src/config/partners.ts）。
 *  结果是 H5 用户点省心买只会得到「复制失败」，入口被打死。
 *  原注释自称「外链场景不该出现站内相对地址」，可代码里就有 —— 注释与调用面自相矛盾。
 *
 *  现在放行**站内绝对路径**（以单个 `/` 开头），理由是它不含协议、由浏览器按当前 origin 解析，
 *  不存在 `javascript:` 这类执行风险。同时必须挡住两种伪装：
 *   · `//evil.com` —— 同样以 `/` 开头，但会被解析成**协议相对 URL**，实际指向外站；
 *   · `/\evil.com`、`\evil.com` —— 浏览器会把 `\` 规范成 `/`，绕过前缀判断。 */
export function isSafeExternalUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  // 站内绝对路径：单斜杠开头、非协议相对（`//`）、不含反斜杠
  if (u.startsWith('/') && !u.startsWith('//') && !u.includes('\\')) return true;
  try {
    return ALLOWED_PROTOCOLS.includes(new URL(u).protocol);
  } catch {
    // 其余无协议的相对路径（`sxm/index.html` 这种）仍拒绝：语义含糊，外链场景不该出现
    return false;
  }
}

/**
 * 打开一个关联产品的网页。
 *
 * - **协议校验**：任何非 http(s) 地址一律拒绝并返回 `'failed'`，绝不交给浏览器/剪贴板。
 * - **H5**：`window.open` 新标签打开；若被浏览器拦截（返回 null）则降级为当前页跳转，
 *   避免出现「点了没反应」这种最糟的失败模式。
 * - **小程序**：本仓没有任何 `web-view` 页面，微信的 `web-view` 又只对企业主体开放，
 *   所以**无法内嵌网页** —— 唯一能做的是把地址交给用户：复制到剪贴板，由调用方给出明确提示。
 *   复制失败返回 `'failed'`，调用方**必须**让用户看见，不能静默。
 */
export async function openExternalPage(url: string): Promise<OpenExternalResult> {
  if (!isSafeExternalUrl(url)) {
    console.warn('[externalLink] 拒绝非 http(s) 外链：', String(url).slice(0, 120));
    return 'failed';
  }
  if (isH5) {
    if (typeof window === 'undefined') return 'failed';
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      window.location.href = url;
    }
    return 'opened';
  }
  try {
    // 小程序端 Taro/微信自带的「内容已复制」提示会先出现，调用方只补一句"去哪儿打开"
    await Taro.setClipboardData({ data: url });
    return 'copied';
  } catch (err) {
    console.warn('[externalLink] 复制链接失败：', err);
    return 'failed';
  }
}
