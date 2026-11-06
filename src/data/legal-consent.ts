/**
 * 法务**同意记录**入口（与 `legal.ts` 的三份正文分离）。
 *
 * 为什么拆出来（2026-11-05）：`src/app.tsx` 启动时只需要 `hasAgreedConsent()` 这一个布尔值，
 * 但旧写法是从 `data/legal` 导入 —— 于是三份法务正文（约 11 KB gzip）被一起拉进首屏包。
 * 正文只有两种时机真正需要：① 首启同意层；② 「我的」半屏查看层。两者都是懒加载页面/组件。
 * 把「版本号 + 同意读写」放进本文件后，`app.tsx` 只依赖这 ~1 KB 的小模块，
 * 三份正文留在异步 chunk 里。**版本号仍是单一来源**：`legal.ts` 从这里导入后用于文本插值。
 */

import Taro from '@tarojs/taro';

/**
 * ★ 版本历史见 `legal.ts` 顶部（改文案必须同步递增本常量，否则旧同意记录不会失效 ——
 * 等于对老用户静默改条款）。
 */
export const LEGAL_VERSION = 'v1.10-20261104';

/** H5 首启同意记录的 storage key（记录同意时的文本版本，便于版本升级后重新征求同意） */
export const CONSENT_KEY = 'privacy-consent';

export interface ConsentRecord {
  agreed: boolean;
  version: string;
  time: number;
  /** 同意发生在哪个端（h5 / weapp）。用于事后核对「这条同意是谁、在哪个载体上作出的」。 */
  device?: string;
}

export function hasAgreedConsent(): boolean {
  try {
    const rec = Taro.getStorageSync(CONSENT_KEY) as ConsentRecord | '';
    return !!(rec && rec.agreed && rec.version === LEGAL_VERSION);
  } catch {
    return false;
  }
}

export function saveConsent(): void {
  try {
    Taro.setStorageSync(CONSENT_KEY, {
      agreed: true,
      version: LEGAL_VERSION,
      time: Date.now(),
      device: process.env.TARO_ENV || 'unknown'
    } as ConsentRecord);
  } catch (err) {
    // 存储失败不阻塞使用，仅放弃记录
  }
}
