/**
 * 引导标记的读写（2026-11-05 从 index.tsx 拆出）。
 *
 * 入口 app.tsx 启动时只需要「看过没有」这一个布尔，不需要整屏引导组件与其样式
 * （组件+样式约 5.2KB gzip）。把这些纯读写函数留在组件文件里，组件就无法按需加载 ——
 * 静态 import 会把样式和文案一起拉进入口 chunk。
 *
 * 行为与拆分前逐行一致；组件本身（index.tsx）改为按需加载。
 */
import Taro from '@tarojs/taro';

export const ONBOARD_STORAGE_KEY = 'onboarded-v2';

/** 是否已经看过引导。Taro 对缺键返回空串（不是 undefined），必须显式判真值。 */
export function hasOnboarded(): boolean {
  try {
    const v = Taro.getStorageSync(ONBOARD_STORAGE_KEY);
    return v === true || v === 'true' || v === 1;
  } catch {
    // 读不到就当没看过：宁可多引导一次，也不要让新用户跳过（跳过的人看不到后面的授权说明）
    return false;
  }
}

/**
 * 账号级引导标记（2026-10-30）。
 *
 * 上面那个 key 是**设备级**的：这台机器看过一次就再也不弹。后果是老用户
 * 换设备登录、或者同一台机器上换一个账号登录，都看不到任何指导 ——
 * 用户反馈的原话是「只有注册有，登录没有」。
 *
 * 所以再叠一层账号维度：`onboarded-v2:<userId>`。
 *   · 注册 → 登录 → 该账号第一次进应用：弹
 *   · 同一个账号再登录：不弹（设备级也在，双保险）
 *   · 换账号登录：这个账号没看过 → 弹
 *   · 拿不到 uid（会话未就绪/异常）：退回设备级判断 —— 宁可少弹一次，
 *     也不要因为取不到 id 就每次登录都糊一层引导。
 */
function accountKey(uid: string): string {
  return `${ONBOARD_STORAGE_KEY}:${uid}`;
}

export function hasOnboardedFor(uid: string | null | undefined): boolean {
  if (!uid) return hasOnboarded();
  try {
    const v = Taro.getStorageSync(accountKey(uid));
    return v === true || v === 'true' || v === 1;
  } catch {
    return hasOnboarded();
  }
}

export function markOnboardedFor(uid: string | null | undefined): void {
  try {
    if (uid) Taro.setStorageSync(accountKey(uid), true);
    // 设备级也写上：下次冷启动会话还没到时，不必先弹一层再收回
    Taro.setStorageSync(ONBOARD_STORAGE_KEY, true);
  } catch (err) {
    console.warn('[Onboarding] 写入引导标记失败:', err);
  }
}

export function markOnboarded(): void {
  try {
    Taro.setStorageSync(ONBOARD_STORAGE_KEY, true);
  } catch (err) {
    console.warn('[Onboarding] 写入引导标记失败:', err);
  }
}
