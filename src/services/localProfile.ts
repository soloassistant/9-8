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

/**
 * 时间格式校验：既看形状也看范围。
 * 只写 `/^\d{2}:\d{2}$/` 是不够的 —— `'25:99'` 也能通过，于是"脏值不渗进档案"这句就不成立。
 * 这个值虽然正常由时间选择器产生，但 `user-settings` 在 cloudSync 的 SYNC_KEYS 内，
 * **可能来自云端同步**，而 sanitize 存在的意义正是「存储内容不可信」。
 */
function isHHMM(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return false;
  const [h, m] = v.split(':').map(Number);
  return h <= 23 && m <= 59;
}

/** localStorage 内容不可信：类型/范围不符就丢弃该项并回落默认，不让脏值渗进 UserProfile。 */
function sanitize(raw: unknown): ProfileSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    nickname: typeof src.nickname === 'string' ? src.nickname : DEFAULT_SETTINGS.nickname,
    briefingTime: isHHMM(src.briefingTime) ? src.briefingTime : DEFAULT_SETTINGS.briefingTime,
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

/** 登录标识脱敏后作默认昵称：邮箱留首字符+域名，手机号留前3后4，中间一律掩掉。
 *
 * ⚠️ **H5 上这段的 email/phone 分支实际不可达（2026-10-08 查 SDK 坐实，勿据注释误判）**：
 *   SDK（`@tencent-ai/workbuddy-cloud-sdk` lib/index.global.js）里
 *     · `getSession()` → `sessions.ensure()` → `store.read()`，
 *       读取的是 `parseSession` 写入的会话，其 user 来自 `userFromSessionPayload(r)`：
 *         `{ id: typeof r.sub === "string" ? r.sub : "", name, avatarUrl, isAnonymous, raw: r }`
 *       —— **没有 email、也没有 phone**；
 *     · 带 email/phone 的 `parseUser(r)`（读 `r.email ?? r.user_metadata.email`）
 *       只被 `auth.getUser()`（`/v1/user/me`）使用，**不参与会话**。
 *   因此 H5 的 `session.user.email` 恒为 undefined，本函数会直接返回空串，
 *   昵称回落到 `buildProfileFromSession` 里的 `id.slice(0,8)`。
 *   这不是编造身份（id 是真实的），但也不是"脱敏邮箱"——两者别混为一谈。
 *   想让脱敏邮箱真正生效，得改成调 `auth.getUser()` 取 email（多一次网络往返），
 *   或从 `user.raw` 里取（**未证实** `/v1/token` 响应是否带 email），
 *   两者都属行为变更，需产品确认，故此处只标注不改。
 *   小程序端不受影响：那边 `login` 云函数返回的档案本来就带 email。 */
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
 * ⚠️ **只在"确实没有会话"时抛错，不因 `user.id` 为空而抛错**（2026-10-08 实测修正）。
 *   依据：SDK 的 `userFromSessionPayload` 是
 *     `{ id: typeof r.sub === 'string' ? r.sub : '', ... }`（见 index.global.js）
 *   —— 也就是说 **会话存在但 id 为空是合法状态**（登录响应里没有 `sub` 时）。
 *   若据此抛错，H5 会每次 init 都失败：比被修的 mock 更糟（用户连档案都没有）。
 *   正确姿势：`openid` 留空字符串 —— 空是"不知道"的如实表达，不是编造身份；
 *   而编造一个假 openid 才是要修的那个行为。
 *
 * 附：检索核对结论 —— 该字段目前**没有任何读取方**（只有类型定义与赋值），
 * 所以留空不会影响任何功能；保留真值是为了将来若有消费方时口径正确。
 */
export function buildProfileFromSession(session: CloudSession | null): UserProfile {
  if (!session) throw new Error('no-cloud-session');
  const user = session.user;
  const id = user?.id?.trim() || '';
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