import Taro from '@tarojs/taro';

const isH5 = process.env.TARO_ENV === 'h5';

export type OpenExternalResult = 'opened' | 'copied' | 'failed';

/**
 * 打开一个关联产品的网页。
 *
 * - **H5**：`window.open` 新标签打开；若被浏览器拦截（返回 null）则降级为当前页跳转，
 *   避免出现「点了没反应」这种最糟的失败模式。
 * - **小程序**：本仓没有任何 `web-view` 页面，微信的 `web-view` 又只对企业主体开放，
 *   所以**无法内嵌网页** —— 唯一能做的是把地址交给用户：复制到剪贴板，由调用方给出明确提示。
 *   复制失败返回 `'failed'`，调用方**必须**让用户看见，不能静默。
 */
export async function openExternalPage(url: string): Promise<OpenExternalResult> {
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
