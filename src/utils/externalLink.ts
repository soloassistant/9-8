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

/** 哨兵 host：用来判断「一个以 `/` 开头的串解析后是否仍留在本站」。
 *  不用它做任何真实请求，只当解析基准。 */
const SENTINEL_HOST = 'internal-path.invalid';

/** 校验外链地址是否可安全跳转。非 http(s)、非站内绝对路径、解析失败、空串一律判否。
 *
 *  ⚠️ 2026-10-12 修 ①：最初版本只认绝对 http(s)，把**站内绝对路径**一起拒了。
 *  但本应用自己就有一个合法的站内路径调用点 —— H5 端省心买入口正是
 *  `SXM_H5_PATH = '/sxm/index.html'`（同源子页，见 src/config/partners.ts）。
 *  结果是 H5 用户点省心买只会得到「复制失败」，入口被打死。
 *  原注释自称「外链场景不该出现站内相对地址」，可代码里就有 —— 注释与调用面自相矛盾。
 *
 *  ⚠️ 2026-10-12 修 ②（补 ① 捅出来的洞）：① 用「`/` 开头且不以 `//` 开头」的**字符串前缀**
 *  来代表「站内路径」，这是错的 —— WHATWG URL 解析器会**静默删除** URL 里的 `\t` `\n` `\r`，
 *  于是 `"/\t/evil.com"` 前缀检查全部通过，解析出来却是协议相对的 `//evil.com` → `https://evil.com/`。
 *  ① 之前不存在这个洞：那时 `/\t/evil.com` 没有协议，会被 `new URL()` 抛错挡掉；
 *  是 ① 放宽了前缀判断才把它放进来的（真实复现见 .tmp-verify/verify-tab-bypass.js）。
 *
 *  所以这里改成**判解析结果、而不是判字符串前缀**：把候选串以哨兵 origin 为基准解析，
 *  再要求解析出来的 host 恰好是哨兵。解析器先完成规范化，任何「靠删字符变换形态」的绕过
 *  在 `host` 这一步就暴露了。另外对裸控制字符直接判否作为纵深防御：
 *  合法 URL 从不含 `\t` `\n` `\r`，拒掉它们不会误伤任何真实调用点。 */
export function isSafeExternalUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  // 纵深防御：含 ASCII 控制字符（U+0000–U+001F、U+007F）一律判否
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(u)) return false;

  if (u.startsWith('/')) {
    // 反斜杠会被浏览器规范成 `/`，语义含糊，直接拒
    if (u.includes('\\')) return false;
    try {
      const r = new URL(u, `https://${SENTINEL_HOST}/`);
      return r.host === SENTINEL_HOST && ALLOWED_PROTOCOLS.includes(r.protocol);
    } catch {
      return false;
    }
  }

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
