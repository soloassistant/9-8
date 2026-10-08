import Taro from '@tarojs/taro';
import type { UserProfile } from '../types';
import type { CloudSession, CloudUser } from './cloudAuth';

/**
 * H5 侧的用户档案：**真会话 + 本地可同步设置**。
 *
 * 为什么需要它（2026-10-08 定位）：
 *   登录门禁（app.tsx 的 useDidShow）判的是 `cloudAuth.getSession()` —— 真会话，H5 可用；
 *   但全应用读的 `useUserStore.profile` 来自 `login` 云函数，而该函数**不在** dataSource 的
 *   RPC 白名单内（它裸读 `cloud.getWXContext().OPENID`，H5 取不到），于是 H5 每次都落到
 *   `src/data/login.ts` 的 mock：昵称恒为「晨友」、preferences 恒为默认值，
 *   且 `apiUpdateSettings` 同样被拦 → mock 只 `console.info` 不落盘，改了设置刷新即丢。
 *   结果是**用户用真身份过了门禁，却看到一个与登录身份无关的假档案**，且设置保存无效。
 *
 * 这里不改门禁、不改 store，只把档案的**来源**换掉：
 *   · `openid` ← 会话 `user.id`（本地档案里用它作身份标识）；
 *   · `nickname` / `briefingTime` / `preferences` ← `user-settings`。
 *
 * ⚠️ 关于 `openid` 这个字段名（2026-10-08 更正）：它只是 `UserProfile` 的历史字段名，
 *   **只在本机使用，不会作为身份参数发给任何云函数**。平台规则明确禁止把 user id 当参数传
 *   （code-generation.md：*"Never pass a token, user id, or owner id by hand"*），
 *   原先那种「客户端注入 openid 顶替微信身份」的做法已在同轮移除（`dataSource.withIdentity()` 已删）。
 *   另注：检索确认该字段**当前没有任何消费方**，只在两个 mock 模块里被定义。
 *
 * 为什么复用 `user-settings` 而不是新开一个键：它已在 `cloudSync.SYNC_KEYS` 内，
 * 写入即随 cloudSync 跨设备同步；新开键会造出一个**不参与同步的孤儿存储位**。
 * 现有形状是 `{ replyStyle, newsEnabled, morningReminderEnabled }`（见 pages/mine/index.tsx
 * 的 CustomSettings），本模块只**增补**键、读时用展开合并，mine 的 `loadCustom` /
 * `persistCustom` 同样用展开，额外键可无损透传，两边互不覆盖。
 */

/** 与 pages/mine/index.tsx 的 CUSTOM_SETTINGS_KEY 同键；已在 cloudSync.SYNC_KEYS 内。 */
const SETTINGS_KEY = 'user-settings';

/** 本模块负责的那几个键（其余键属于 mine 的 CustomSettings，读取时透传、写入时保留）。 */
interface ProfileSettings {
  nickname: string;
  briefingTime: string;
  preferences: string[];
}

const DEFAULT_SETTINGS: ProfileSettings = {
  nickname: '',
  briefingTime: '07:30',
  preferences: []
};

/** localStorage 内容不可信：类型不符就丢弃该项并回落默认，不让脏值渗进 UserProfile。 */
function sanitize(raw: unknown): ProfileSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    nickname: typeof src.nickname === 'string' ? src.nickname : DEFAULT_SETTINGS.nickname,
    briefingTime:
      typeof src.briefingTime === 'string' && /^\d{2}:\d{2}$/.test(src.briefingTime)
        ? src.briefingTime
        : DEFAULT_SETTINGS.briefingTime,
    preferences: Array.isArray(src.preferences)
      ? src.preferences.filter((p): p is string => typeof p === 'string')
      : DEFAULT_SETTINGS.preferences
  };
}

export function readProfileSettings(): ProfileSettings {
  try {
    return sanitize(Taro.getStorageSync(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 合并写入。**读-改-写整体替换**并保留其它键 —— 直接
 * `setStorageSync(key, patch)` 会把 mine 存的 replyStyle 等抹掉。
 */
export function writeProfileSettings(patch: Partial<ProfileSettings>): ProfileSettings {
  const current = readProfileSettings();
  const next: ProfileSettings = {
    nickname: patch.nickname ?? current.nickname,
    briefingTime: patch.briefingTime ?? current.briefingTime,
    preferences: patch.preferences ?? current.preferences
  };
  try {
    let others: Record<string, unknown> = {};
    const stored = Taro.getStorageSync(SETTINGS_KEY);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      others = { ...(stored as Record<string, unknown>) };
    }
    // 写入经过 cloudSync 的 Taro.setStorageSync 钩子 → 触发防抖推送，跨设备生效
    Taro.setStorageSync(SETTINGS_KEY, { ...others, ...next });
  } catch (err) {
    console.error('[LocalProfile] persist settings failed:', err);
  }
  return next;
}

/** 登录标识脱敏后作默认昵称：邮箱留首字符+域名，手机号留前3后4，中间一律掩掉。 */
export function maskIdentifier(user: CloudUser | undefined): string {
  const email = user?.email?.trim();
  if (email) {
    const at = email.indexOf('@');
    if (at > 0) return `${email.slice(0, 1)}***${email.slice(at)}`;
    return `${email.slice(0, 1)}***`;
  }
  const phone = user?.phone?.trim();
  if (phone) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  return '';
}

/**
 * 由真会话构造 UserProfile。
 *
 * `user.id` 缺失时**抛错而非编造**：UserProfile.openid 是必填，且全应用把它当身份口径，
 * 造一个假值等于退回这次要修的那个 mock 行为。调用方（api.ts）会把它当作失败处理。
 */
export function buildProfileFromSession(session: CloudSession | null): UserProfile {
  const user = session?.user;
  const id = user?.id?.trim();
  if (!id) throw new Error('no-cloud-session');
  const settings = readProfileSettings();
  return {
    openid: id,
    nickname: settings.nickname || maskIdentifier(user) || id.slice(0, 8),
    briefingTime: settings.briefingTime,
    preferences: settings.preferences,
    // 订阅态无服务端来源（H5 拿不到订阅云函数），不编造：按未订阅呈现，
    // 前端的订阅入口本身会引导到小程序那条线。
    subscribed: false,
    expiredAt: null,
    isEarlyBird: false
  };
}