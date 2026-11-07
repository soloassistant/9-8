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
 * ★ 版本历史见 `legal.ts` 顶部。
 * 文案版本（LEGAL_VERSION）与同意版本（LEGAL_CONSENT_VERSION）分开：
 * 前者一改就递增供审计；后者只在**签字定稿**时推进，才让旧同意失效。
 */
/**
 * 文案版本：条文一改就递增（审计可追、门禁 E2/D3 盯它）。
 * ⚠️ 它不是「用户需要重新同意的版本」：未签字定稿前带 PENDING-SIGNATURE，
 *    绝不能拿它驱动复同意 —— 否则用户会为一份草稿同意两次。
 */
export const LEGAL_VERSION = 'v1.12-20261105-PENDING-SIGNATURE';

/**
 * 同意版本：**只有签字定稿**后才推进；首启 / 复同意只比对这一个值。
 * 当前值 = 线上用户实际同意过的版本，本次不改（签字清单见 docs/legal/07）。
 */
export const LEGAL_CONSENT_VERSION = 'v1.10-20261104';

/** H5 首启同意记录的 storage key（记录同意时的**同意版本**，便于签字定稿后才重新征求同意） */
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
    return !!(rec && rec.agreed && rec.version === LEGAL_CONSENT_VERSION);
  } catch {
    return false;
  }
}

export function saveConsent(): void {
  try {
    Taro.setStorageSync(CONSENT_KEY, {
      agreed: true,
      version: LEGAL_CONSENT_VERSION,
      time: Date.now(),
      device: process.env.TARO_ENV || 'unknown'
    } as ConsentRecord);
  } catch (err) {
    // 存储失败不阻塞使用，仅放弃记录
  }
}
