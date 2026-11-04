/**
 * 用户数据云同步：localStorage ←→ WorkBuddy 云数据库（user_kv 表）。
 *
 * 数据流（2026-10-13 H5 迁移后）：本地 storage ←→ 云数据库 user_kv（一行一个同步键），
 * 身份由 cloud.auth 会话在请求层自动附带，服务端按 owner_id（RLS）隔离。
 * 策略不变：per-key 时间戳 + 服务端「新者赢」（防旧设备覆盖新数据）；
 * 启动/登录后拉取远端较新的 key 覆盖本地（跨设备恢复）。
 *
 * 【迁移前是什么】此前走同源 `/api/user/data`(拉) / `/api/user/sync`(推)，
 * 而发布环境是静态文件网关，这两个端点恒 404/501 —— **跨设备同步从未真正工作过**
 * （2026-10-05 实测：登录页 172 秒内失败 9 次、控制台零输出）。现已整体换成云数据库。
 *
 * 重要：本模块运行于 Taro 引擎就绪之前的模块加载期，因此一律使用原生 localStorage 直读直写，
 * 绝不经过 Taro.setStorageSync——模块加载期 Taro API 可能尚未注入，会静默失败导致恢复失效（已踩坑验证）。
 * 仅 H5 生效：weapp 走微信 openid + 云数据库，不进本模块。
 *
 * 登录态门禁：云数据库请求必须带会话。未登录 → 推送直接跳过（不是故障）；
 * 登录成功 → onAuthStateChange 触发「先拉后推」；会话过期 → 推送自然停。
 *
 * 恢复时序：启动拉取是异步的，**不保证「先于首屏」**——调用方须 `await initCloudSync()`
 * 或 `await cloudSyncReady()` 之后，再渲染 / 重放依赖云端恢复的界面（语言 / 主题 / 字号等）。
 */
import Taro from '@tarojs/taro';
import { getSession, onAuthStateChange } from './cloudAuth';
import { kvDeleteKeys, kvGetAll, kvSetMany } from './cloudDb';
import type { KvRow } from './cloudDb';
import { classifyPull, mergeConflicts, withoutConflicts, valueHash, type SyncConflict } from '../utils/syncConflict';

const META_KEY = 'cloud-sync-meta'; // { [storageKey]: ts } 本地各 key 最后一次确认同步的时间
const CONFIRM_KEY = 'cloud-sync-confirm'; // { [storageKey]: hash } 各 key 上次成功推送的值哈希（冲突检测用）
const CONFLICT_KEY = 'cloud-sync-conflict'; // SyncConflict[] 待用户裁决的同步冲突（持久化，刷新不丢提示）
const SYNC_INTERVAL = 30_000; // 兜底轮询：每 30 秒推一次变更
const DEBOUNCE = 1500; // 写入后防抖 1.5 秒再推，合并连续写入
const PULL_TIMEOUT_MS = 8000; // 启动拉取超时（SDK 请求自行 abort，避免悬挂）

/** 需要上云的 key（与 src 内实际使用一一对应；设备级隐私同意不上云）。
 * 2026-10-31 起导出：数据保险箱（prefs 页全量导出/导入）按这份清单收集，别再写第二份。 */
export const SYNC_KEYS = [
  'shoppingList',     // 购物清单
  'dailyPlanStore',   // 日程/待办
  'browseHistory',    // 浏览历史
  'newsFeedback',     // 资讯反馈
  'news-interests',        // AI 精选兴趣标签
  'news-interests-custom', // AI 精选自定义关键词
  'activity-log',     // 活动记录
  'learnStore',       // 学习进度
  'ai-memory',        // AI 记忆
  'user-settings',    // 我的页设置
  'user-city',        // 城市
  'collectionStore',  // 收藏库（收件箱确认入库）
  'usage-voice',      // 语音用量月度计数
  'feature-usage',    // 功能记账：按天聚合的各功能真实调用次数（2026-10-24）
  'briefingChatLog',  // 晨报 AI 对话（限长 60）
  'aiAssistantLog',   // 悬浮球 AI 对话（限长 60）
  'brand-theme',      // 主题
  'app-lang',         // 语言
  'ui-scale',          // 字号
  'user-avatar',       // 头像（2026-10-26 接云存储：H5 存 `cloud:<对象键>`，跨设备重取签名 URL；
                       //   小程序端存本地路径，别端读到不认识的值时按无头像处理，不裂图）
  // 记账（v2.0 F23）：刻意**拆成三个 key**而不是一个 ledger 对象。
  // 分类/预算的写入频率远低于条目，分开后 per-key「新者赢」互不干扰 ——
  // 否则在别的设备加一笔账，会把这一端的预算设置一起覆盖掉。
  'ledgerEntries',    // 记账条目
  'ledger-categories', // 记账分类（含用户增删改）
  'ledgerBudget',      // 记账预算（日/月上限）
  // 自选股（2026-10-25）：跨设备同步 —— 手机上加了茅台，平板打开就该看到。
  // 字符串数组（≤8 项腾讯代码），体积可忽略； quotes.ts 的 WATCHLIST_KEY 是唯一写入方。
  'watchlist',
  // 追踪关键词（2026-10-31）：用户盯的词，跨设备一致（与自选股 watchlist 是两码事，键名刻意区分）。
  // briefing-archive 刻意不同步：7 天整包晨报太重，且存档是端上体验，不是要带着走的数据。
  'intel-watchlist',
  // 运动（2026-10-28）：跑步记录 + 周目标。与记账同款拆两个 key ——
  // 记录写入频繁、周目标几乎不改，分开才不会互相覆盖。
  'sportRuns',
  'sport-goal-km',
  // ── 2026-10-30 补齐：这些键**写了本地存储却没进 SYNC_KEYS** ──
  // 后果：换设备 / 重装 / 清缓存 ⇒ 这份数据静默消失（用户视角：功能像坏了，
  // 而界面不提示任何东西）。与「webSearch 打不存在的 PG 函数」同族：
  // 通路断在暗处，用户只看到「数据没了」。
  // 判据：键里装的是**用户自己的内容或权益状态**，且**跨设备有意义**。
  // 明确**不**纳入的（各带理由）：
  //   · mb-cat-affinity-ab / mb_ai_audio_trace —— A/B 分流与追踪计数器，代码注释已写明不上云；
  //   · privacy-consent / sxm-privacy-consent / location-cross-border-consent —— 合规同意，设备级；
  //   · onboarded-v2 / burst-banner-dismissed / sxm-phone-bind-* —— 引导与弹窗展示状态，设备级；
  //   · llm-conversation-id / subscribeStat / subscribeDeny / mb-sub-auth-at —— 会话与实验分流；
  //   · briefingDailyCache / library-open-history / sxm-dial-code / sxm-remember-login —— 缓存与设备偏好；
  //   · h5-subscription —— **派生值**（真值在 orders 表，由订阅回放算出来）；同步缓存反而会与回放打架。
  'learnCommunityStore',  // 学习社区动态 + 打卡（社区页换设备要能接着发）
  'learnAchievements',    // 学习成就徽章（已解锁时间）
  'learnNickname',        // 学习昵称
  'habitStore',           // 习惯守护（连续天数/目标）
  'readStreakStore',      // 阅读连续天数
  'mb-brief-streak',      // 晨报连续天数
  'mb_news_blocklist',    // 资讯屏蔽词（换设备后被屏蔽的内容不能复活）
  'mb-cat-affinity',      // 类目亲和度（影响资讯排序偏好）
  'mb-prefs',             // 内容偏好（科学/文化/健康…，selectByPreference 要用）
  'mb_personalization',   // 个性化开关与画像
  'ai_chat_usage',        // AI 对话本地用量计数（配额显示要一致）
  'notify-log',           // 通知历史
  'mb_tts_voice',         // 语音音色偏好
  'hotspot-disabled-sources', // 资讯来源开关（用户关掉了哪些源；换设备后不该"复活"）
  'mb_renew_remind',      // 续费提醒开关（权益相关提醒）
  'mb_renew_remind_day',  // 续费提醒节流日期
  'mb_locked_price'       // 早鸟终身锁价（2026-10-30 补：**权益**，不派生自 orders 表 ⇒ 不会自动恢复；
                          //   不同步 ⇒ 换设备后用户看到现价，早鸟权益消失）
] as const;

/**
 * removeStorageSync 之后的占位值 —— 必须与该 key 的**真实存储类型**一致。
 *
 * 语义：删除某个 SYNC_KEYS 后写回一个「空值」，让删除动作也能同步到云端
 * （collectLocal 会对 ''/null/undefined 跳过，不写占位就同步不出去）。
 *
 * 类型依据（逐 key 读写入点确认，2026-10-08）：
 *   · 数组类 → `[]`：列表/日志/集合类 key，各处 setStorageSync 写入的都是数组。
 *   · 对象类 → `{}`：仅 `user-settings`。src/pages/mine/index.tsx:143 `CUSTOM_SETTINGS_KEY`，
 *     loadCustom() 按 `{ ...DEFAULT_CUSTOM, ...getStorageSync(key) }` 读取、setCustom() 写回的是
 *     CustomSettings 对象（replyStyle/newsEnabled/morningReminderEnabled），故占位必须是对象；
 *     写成 `[]` 类型不符（空数组展开成对象也不带任何设置字段）。
 *   · 标量类 → `''`：城市/用量/主题/语言/字号，写入的是字符串（既非列表也非对象）。
 *
 * 注意：当前没有任何调用点会单独 remove 这些 key —— 全仓 removeStorageSync 只命中
 * pages/history 的 browseHistory（数组，写 `[]` 正确）与两个不在 SYNC_KEYS 里的 affinity key，
 * 而 pages/mine 的 clearStorageSync 走的是 Taro H5 的 localStorage.clear()、不经过本钩子。
 * 因此这是**防御性修复**，不是线上故障。
 */
const REMOVE_PLACEHOLDER: Record<string, unknown> = {
  // 数组类
  shoppingList: [],
  dailyPlanStore: [],
  browseHistory: [],
  newsFeedback: [],
  'news-interests': [],
  'news-interests-custom': [],
  'activity-log': [],
  learnStore: [],
  'ai-memory': [],
  collectionStore: [],
  briefingChatLog: [],
  aiAssistantLog: [],
  sportRuns: [],
  'mb_news_blocklist': [],
  'mb-cat-affinity': [],
  'notify-log': [],
  // 2026-10-30 补齐（此前这 5 个键漏了占位值 ⇒ 万一整键被删除，删除动作同步不出去，
  // 云端会留着旧数据）。类型逐个读写入点确认：ledgerEntries / ledger-categories 是数组、
  // ledgerBudget 是 { 日上限, 月上限 } 对象、watchlist 是字符串数组、user-avatar 是字符串。
  'ledgerEntries': [],
  'ledger-categories': [],
  'ledgerBudget': {},
  'watchlist': [],
  'intel-watchlist': [],
  'user-avatar': '',
  // 对象类
  'user-settings': {},
  // 功能记账是 `{ 'YYYY-MM-DD': { chat: n } }` 的对象，占位必须是空对象；
  // 写成 '' 会被 parseBuckets 当成空账本 —— 删除动作传不出去，云端留着旧计数。
  'feature-usage': {},
  // 2026-10-30 补齐的 15 个键：占位值必须与**该键真实存储类型**一致
  // （逐个读写入点确认：achievements 存 id→ISO 映射、brief-streak 存 { last, count }、
  //  ai_chat_usage 存 { day, used }、prefs 存 UserPrefs、habit/readStreak 存对象）。
  'learnCommunityStore': {},
  'learnAchievements': {},
  'habitStore': {},
  'readStreakStore': {},
  'mb-brief-streak': {},
  'mb-prefs': {},
  'mb_personalization': {},
  'ai_chat_usage': {},
  'mb_locked_price': {},
  // 标量类
  'user-city': '',
  'usage-voice': '',
  'brand-theme': '',
  'app-lang': '',
  'ui-scale': '',
  'sport-goal-km': '',
  'learnNickname': '',
  'mb_tts_voice': '',
  'mb_renew_remind_day': '',
  // 资讯来源开关：存储形态是数组（关掉的源名），占位必须是空数组 ——
  // 写成 '' 会让云端把它当"未设置"，用户清空开关后另一端不会跟着恢复成全部开启
  'hotspot-disabled-sources': [],
  // 布尔类（开关）：占位必须是布尔，写成 '' 会被读取端当成「未设置」
  'mb_renew_remind': false
};

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pulling = false;
/** 「启动恢复完成」信号：initCloudSync() 返回它，也供 cloudSyncReady() 读取 */
let readyPromise: Promise<void> | null = null;
/** 连续「硬失败」次数：带 PostgreSQL 错误码的失败（表不存在 42P01 / 权限 42501 等）
 *  属于**不会自愈**的故障 —— 与网络抖动（抛错，下一轮照常重试）区分开。
 *  为什么需要它：云数据库若缺表/缺策略，每次防抖+轮询都会打一次，30 秒一次地刷 warn
 *  既查不到重点也耗流量。连续 DB_FAIL_LIMIT 次就停掉轮询并 console.error 一次说清楚。 */
let hardFailures = 0;
let syncDisabled = false;

/* ---------------- 运行期同步排除（2026-11-04，P0：撤回健康同意被架空） ----------------
 *
 * 事故：`sportRuns`（含 GPS 轨迹）在 SYNC_KEYS 里，pushNow 每 30s 把本地所有同步键
 * 整包上传；而撤回健康数据同意只删了本地同意标记 ⇒ 撤回后轨迹继续外传，
 * 与「撤回后不再记录新数据」的告知不一致（敏感个人信息）。
 *
 * 为什么不是直接把 `sportRuns` 从 SYNC_KEYS 删掉：用户**重新授权**后仍应恢复跨设备备份。
 * 所以排除是**运行期状态**：撤回时置位、重新同意时清除，并要求跨刷新生效
 * （由 app 入口在 initCloudSync 之前按当前同意状态调用 setSyncKeyExcluded）。
 *
 * 排除表命中时四处都要短路，缺一处就还有一条出网路径：
 *   collectLocal（不打包）→ markDirty（不排推送）→ applyRemoteData（不把云端副本拉回本机）
 */
const runtimeExcludedKeys = new Set<string>();

/** 设置某同步键是否排除出同步（撤回/重新授权时调用；立即生效） */
export function setSyncKeyExcluded(key: string, excluded: boolean): void {
  if (excluded) {
    runtimeExcludedKeys.add(key);
    // 撤回瞬间取消**尚未发出**的防抖推送，否则 1.5s 后还会按旧计划发一次带轨迹的请求
    cancelPendingPush();
  } else {
    runtimeExcludedKeys.delete(key);
  }
}

/** 某同步键当前是否被排除（供 UI/门禁读取） */
export function isSyncKeyExcluded(key: string): boolean {
  return runtimeExcludedKeys.has(key);
}

/** 串行化推送：撤回同意要求「在途推送要么等完、要么丢弃」，不允许两次 push 并发跑。
 *  同时保证排队的那一次读到的是**最新**排除表，而不是过期快照。 */
let pushInFlight: Promise<void> | null = null;

/** 取消尚未发出的防抖推送（撤回同意时用：别让撤回后还有一次出网） */
export function cancelPendingPush(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
}

/** 等待当前在途推送结束（撤回同意时先等它落地，再删云端副本） */
export async function waitForPushIdle(): Promise<void> {
  if (!pushInFlight) return;
  try {
    await pushInFlight;
  } catch {
    // doPush 内部已按失败语义处理，这里只等它收尾
  }
}

/* ---------------- 熔断可见化（2026-11-04，缺陷 X6） ----------------
 *
 * 事故：云数据库缺表/缺策略等硬故障连续 5 次后 `disableSync()` 只 console.error，
 * 页面照常显示「已登录、已同步」，用户以为数据在云上，换设备才发现没有。
 *
 * 修复：熔断状态暴露给 UI（常驻提示 + 手动重试）；重试会重新开始轮询，
 * 仍失败则继续熔断并如实返回 false。本地数据始终不受影响。
 */
export interface SyncDisabledState {
  disabled: boolean;
  reason: string;
  at: number;
  failures: number;
}

let syncDisabledState: SyncDisabledState = { disabled: false, reason: '', at: 0, failures: 0 };
const syncDisabledListeners = new Set<(state: SyncDisabledState) => void>();

function emitSyncDisabled(): void {
  const snapshot = syncDisabledState;
  syncDisabledListeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch (err) {
      console.warn('[cloudSync] disabled listener failed:', err);
    }
  });
}

export function getSyncDisabledState(): SyncDisabledState {
  return syncDisabledState;
}

export function subscribeSyncDisabled(cb: (state: SyncDisabledState) => void): () => void {
  syncDisabledListeners.add(cb);
  cb(syncDisabledState);
  return () => {
    syncDisabledListeners.delete(cb);
  };
}

/** 手动重试同步：解除熔断、重启轮询并立即拉推一次；返回是否成功 */
export async function retrySync(): Promise<boolean> {
  syncDisabled = false;
  hardFailures = 0;
  syncDisabledState = { disabled: false, reason: '', at: 0, failures: 0 };
  emitSyncDisabled();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void pushNow(), SYNC_INTERVAL);
  await pullRemote();
  await pushNow();
  if (hardFailures > 0) {
    syncDisabled = true;
    syncDisabledState = {
      disabled: true,
      reason: '手动重试仍失败（云端不可达或缺少表/策略）',
      at: Date.now(),
      failures: hardFailures
    };
    emitSyncDisabled();
    return false;
  }
  return true;
}

function disableSync(reason: string) {
  syncDisabled = true;
  syncDisabledState = { disabled: true, reason, at: Date.now(), failures: hardFailures };
  emitSyncDisabled();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.error(
    `[cloudSync] 连续 ${DB_FAIL_LIMIT} 次云数据库失败，已停止轮询（跨设备同步当前不可用），本地数据不受影响。` +
      `首次失败原因：${reason}`
  );
  // 熔断不能只写控制台：用户在任何页面都应看到一次明确提示（缺陷 X6）。
  const isEn = String(taroUnwrap(rawGet('app-lang')) || '') === 'en';
  void Taro.showToast({
    title: isEn ? 'Sync paused — your local data is safe' : '跨设备同步已暂停，本地数据安全',
    icon: 'none',
    duration: 4000
  });
}
const DB_FAIL_LIMIT = 5;

// ---- 原生 localStorage 封装（模块加载期可用，不依赖 Taro） ----
// 注意：Taro H5 的存储是信封格式——setStorageSync 写入 JSON.stringify({ data: 值 })，
// getStorageSync 只认带 data 属性的信封对象（裸值会被当「非 Taro 数据」返回空）。
// 因此恢复数据必须按信封格式写入，读取时解信封，否则页面读到的一律是空（已踩坑验证）。
function rawGet(key: string): string {
  // 有意静默：localStorage 在隐私模式 / 被禁用时会直接抛错，这里按「无数据」降级即可；
  // 该函数在每次存储读写时都会命中，warn 只会刷屏，且调用方对「要用到的数据缺失」另有兜底。
  try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
}
/** 内部写盘标记：pull / 推送确认 / 隔离搬迁写的不是「用户改动」，
 *  不能被下面的 storage 钩子当成新写入去抬时间戳（否则 pull 完立刻又推一遍）。 */
let internalStorageWrite = false;
function rawSet(key: string, value: string) {
  // 有意静默：与 rawGet 对称的写兜底。localStorage 不可用（被禁用 / 配额满）时，
  // 同步能力本身已失效；而「应用远端数据」这条关键路径另有 console.warn 兜底（见 applyRemoteData）。
  internalStorageWrite = true;
  try { window.localStorage.setItem(key, value); } catch {}
  finally { internalStorageWrite = false; }
}
/** 内部删除：隔离/还原动作不是「用户删除」，不能触发删除占位值与推送。 */
function rawRemove(key: string) {
  internalStorageWrite = true;
  try { window.localStorage.removeItem(key); } catch {}
  finally { internalStorageWrite = false; }
}
/** 按 Taro 语义读值：信封 { data } 解包返回，裸值原样返回 */
function taroUnwrap(raw: string): unknown {
  let item: unknown;
  // 有意静默：本地可能残留非 JSON 的裸值（历史数据），解析失败按「无值」跳过即可。
  try { item = JSON.parse(raw); } catch { return undefined; }
  if (item && typeof item === 'object' && !Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, 'data')) {
    return (item as { data: unknown }).data;
  }
  return item;
}
function rawGetJSON<T>(key: string, fallback: T): T {
  const s = rawGet(key);
  if (!s) return fallback;
  // 有意静默：脏数据（非 JSON）降级为 fallback。readMeta 在**每次**存储写入时都会被调用，
  // 在此 warn 会随写入频率刷屏，故保持静默。
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/**
 * 同步元数据按 **owner（账号 uid）隔离**（2026-11-03，自选股 P0 修复）。
 *
 * 事故：`cloud-sync-meta/confirm` 原来不带 uid，A 账号确认过 `watchlist` 后，
 * 换到 B 账号登录，B 的远端较新「空数组」被当成 clean 覆盖本地，且空数组又被回推云端 ——
 * 用户看到的现象就是「自选股突然没了」。
 * 现在：每个 uid 一份 meta/confirm；升级时把旧全局键**原样备份**再复制进首个 owner，
 * 不删除旧键（兼容读），任何账号都不会因迁移丢数据。
 */
let activeOwner: string | null = null;

function ownerKey(base: string): string {
  return activeOwner ? `${base}:${activeOwner}` : base;
}

/* ---------------- 换账号隔离（2026-11-04，缺陷 B1：隐私） ----------------
 *
 * 事故链：H5 退出登录只清了登录键，**业务同步键全部留在本机**；
 * 下一位用户登录后 initCloudSync 的「先拉后推」直接 collectLocal → kvSetMany，
 * 把上一位用户的数据（记账/收藏/运动/聊天记录…）推进新账号，属于跨账号数据串号。
 *
 * 修复原则：
 *   1. 本机业务数据有**明确的归属标记** `cloud-sync-owner`（谁登录时写下的）；
 *   2. 登录账号与标记不一致 → 先把旧数据整体搬进 `pii-quarantine-<旧owner>`，
 *      再允许新账号 pull/push（绝不静默）；
 *   3. push 前后各校验一次 owner，期间账号被切换 → 直接 abort，不写 confirm/meta。
 *
 * 隔离是**移动**（原 key 删除），不是复制：否则 collectLocal 仍会把旧数据推上去。
 * 归档键不在 SYNC_KEYS 里，后续同步不会再碰它。
 */
const OWNER_KEY = 'cloud-sync-owner'; // { owner, at } —— 本机业务数据归谁
const OWNER_NOTICE_KEY = 'cloud-sync-owner-notice'; // 最近一次换账号隔离提示（持久化，刷新不丢）
const QUARANTINE_PREFIX = 'pii-quarantine-';

export interface SyncOwnerNotice {
  kind: 'owner-switch';
  from: string;
  to: string;
  keys: number;
  quarantineKey: string;
  at: number;
}

const ownerNoticeListeners = new Set<(notice: SyncOwnerNotice | null) => void>();
let ownerNoticeCache: SyncOwnerNotice | null = rawGetJSON<SyncOwnerNotice | null>(OWNER_NOTICE_KEY, null);

function emitOwnerNotice(): void {
  const snapshot = ownerNoticeCache;
  ownerNoticeListeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch (err) {
      console.warn('[cloudSync] owner notice listener failed:', err);
    }
  });
}

/** 当前待展示的「已换账号、旧数据已归档」提示（供 UI 订阅前读取） */
export function getSyncOwnerNotice(): SyncOwnerNotice | null {
  return ownerNoticeCache;
}

/** 用户确认看到提示后清掉（不删隔离数据；隔离数据留给用户人工找回） */
export function dismissSyncOwnerNotice(): void {
  ownerNoticeCache = null;
  rawSet(OWNER_NOTICE_KEY, '');
  emitOwnerNotice();
}

/** 订阅换账号提示：订阅时立即回调一次当前值，返回取消订阅函数 */
export function subscribeSyncOwnerNotice(cb: (notice: SyncOwnerNotice | null) => void): () => void {
  ownerNoticeListeners.add(cb);
  cb(ownerNoticeCache);
  return () => {
    ownerNoticeListeners.delete(cb);
  };
}

/* ---------------- 单键超限提示（2026-11-04，缺陷 X5：512KB 静默丢弃） ----------------
 *
 * 事故：云端 `kv_set_many` 有硬约束 `pg_column_size(value) < 524288`，超限行**直接不写入**，
 * RPC 只返回「写入了几行」。客户端不比对行数，于是浏览历史/AI 记忆等大键
 * 「看着同步成功、换设备却没有」—— 用户只会认为数据丢了。
 *
 * 修复：推送前按 UTF-8 字节预估，超过 512KB 的键**不发**，落一条持久提示并在 UI 明示；
 * 该键不写 meta/confirm（下一轮仍会重试，直到用户清理或导出）。
 * 注意：不能用 `JSON.stringify(value).length` 估字节——中文 1 字符 = 3 字节，会低估 3 倍。
 */
const SIZE_NOTICE_KEY = 'cloud-sync-oversize-notice';
const SIZE_TOAST_KEY = 'cloud-sync-oversize-toast-at';
const KV_VALUE_LIMIT = 512 * 1024;
const SIZE_NOTICE_MAX_ITEMS = 20;

export interface SyncOversizeItem {
  key: string;
  bytes: number;
}

export interface SyncSizeNotice {
  kind: 'oversize';
  at: number;
  items: SyncOversizeItem[];
}

const sizeNoticeListeners = new Set<(notice: SyncSizeNotice | null) => void>();
let sizeNoticeCache: SyncSizeNotice | null = rawGetJSON<SyncSizeNotice | null>(SIZE_NOTICE_KEY, null);

function emitSizeNotice(): void {
  const snapshot = sizeNoticeCache;
  sizeNoticeListeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch (err) {
      console.warn('[cloudSync] size notice listener failed:', err);
    }
  });
}

/** 当前待展示的「单键超过 512KB、未同步」提示 */
export function getSyncSizeNotice(): SyncSizeNotice | null {
  return sizeNoticeCache;
}

/** 用户确认后清掉提示（不清数据；下一次推送若仍超限会再次出现） */
export function dismissSyncSizeNotice(): void {
  sizeNoticeCache = null;
  rawSet(SIZE_NOTICE_KEY, '');
  emitSizeNotice();
}

export function subscribeSyncSizeNotice(cb: (notice: SyncSizeNotice | null) => void): () => void {
  sizeNoticeListeners.add(cb);
  cb(sizeNoticeCache);
  return () => {
    sizeNoticeListeners.delete(cb);
  };
}

/** UTF-8 字节数（含代理对处理），用于对齐云端 512KB 上限 */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // 代理对：两个 char 合计 4 字节
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** 同步值序列化后的字节数（无法序列化时按「超限」处理，宁可不传也不静默丢） */
function kvByteSize(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value) ?? 'null');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** 记录超限键并（最多 6 小时一次）弹 toast；绝不静默 */
function recordOversize(items: SyncOversizeItem[]): void {
  if (items.length === 0) return;
  const prev = sizeNoticeCache?.items || [];
  const merged = new Map<string, number>();
  for (const it of prev) merged.set(it.key, it.bytes);
  for (const it of items) merged.set(it.key, it.bytes);
  sizeNoticeCache = {
    kind: 'oversize',
    at: Date.now(),
    items: Array.from(merged, ([key, bytes]) => ({ key, bytes })).slice(0, SIZE_NOTICE_MAX_ITEMS)
  };
  rawSet(SIZE_NOTICE_KEY, JSON.stringify(sizeNoticeCache));
  emitSizeNotice();
  console.error('[cloudSync] 单键超过 512KB，已跳过同步:', items);

  const now = Date.now();
  const lastToast = Number(rawGetJSON<{ at?: number }>(SIZE_TOAST_KEY, {}).at) || 0;
  if (now - lastToast < 6 * 3600 * 1000) return;
  rawSet(SIZE_TOAST_KEY, JSON.stringify({ at: now }));
  const isEn = String(taroUnwrap(rawGet('app-lang')) || '') === 'en';
  void Taro.showToast({
    title: isEn
      ? `${items.length} item(s) exceed 512KB and were not synced`
      : `有 ${items.length} 项数据超过 512KB，未同步`,
    icon: 'none',
    duration: 4000
  });
}

function readOwnerMarker(): string | null {
  const raw = rawGetJSON<{ owner?: unknown }>(OWNER_KEY, {});
  return typeof raw.owner === 'string' && raw.owner ? raw.owner : null;
}

function writeOwnerMarker(owner: string): void {
  rawSet(OWNER_KEY, JSON.stringify({ owner, at: Date.now() }));
}

function scopedKey(base: string, owner: string): string {
  return `${base}:${owner}`;
}

/**
 * 把本机所有业务同步键**移动**到 `pii-quarantine-<fromOwner>`（含未裁决冲突快照与同步元数据）。
 *
 * 同时清空该账号在本机的 meta/confirm：数据已经不在本机了，这些「已确认同步」时间戳若留着，
 * 下次切回该账号时 `remoteTs <= metaTs` 会让云端数据被跳过 —— 用户会以为数据丢了。
 * 元数据随隔离快照一起保存，切回时按原样恢复（含「有未推送修改」的信息，避免误判 clean）。
 */
function quarantineLocalPii(fromOwner: string): { quarantineKey: string; keys: number } {
  const quarantineKey = `${QUARANTINE_PREFIX}${fromOwner}`;
  const snapshot = rawGetJSON<Record<string, string>>(quarantineKey, {});
  let keys = 0;
  for (const k of SYNC_KEYS) {
    const raw = rawGet(k);
    if (!raw) continue;
    snapshot[k] = raw; // 保留原始信封，可原样还原
    keys++;
    rawRemove(k);
  }
  // 冲突快照里含**远端明文**（旧账号数据），同样属于隐私数据，一并隔离
  const conflicts = rawGet(CONFLICT_KEY);
  if (conflicts) {
    snapshot[CONFLICT_KEY] = conflicts;
    rawRemove(CONFLICT_KEY);
  }
  const oldMeta = rawGet(scopedKey(META_KEY, fromOwner));
  const oldConfirm = rawGet(scopedKey(CONFIRM_KEY, fromOwner));
  if (oldMeta) {
    snapshot['__meta'] = oldMeta;
    rawSet(scopedKey(META_KEY, fromOwner), '{}');
  }
  if (oldConfirm) {
    snapshot['__confirm'] = oldConfirm;
    rawSet(scopedKey(CONFIRM_KEY, fromOwner), '{}');
  }
  if (keys > 0 || conflicts || oldMeta || oldConfirm) rawSet(quarantineKey, JSON.stringify(snapshot));
  // 内存态也要清：否则冲突提示仍展示旧账号的数据
  conflictCache = [];
  emitConflicts();
  // 旧账号的防抖推送必须取消，避免隔离后又被抢跑推一次
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  return { quarantineKey, keys };
}

/** 切到某账号时，把它上次离开本机时归档的数据放回来（本机已有同名 key 时不覆盖） */
function restoreQuarantineFor(owner: string): number {
  const quarantineKey = `${QUARANTINE_PREFIX}${owner}`;
  const snapshot = rawGetJSON<Record<string, string>>(quarantineKey, {});
  if (Object.keys(snapshot).length === 0) return 0;
  let restored = 0;
  for (const k of SYNC_KEYS) {
    const raw = snapshot[k];
    if (!raw || rawGet(k)) continue; // 本机已有当前数据：以现值为准，归档留作备份
    rawSet(k, raw);
    delete snapshot[k];
    restored++;
  }
  const metaPath = scopedKey(META_KEY, owner);
  const confirmPath = scopedKey(CONFIRM_KEY, owner);
  const meta = rawGetJSON<Record<string, number>>(metaPath, {});
  const confirm = rawGetJSON<Record<string, string>>(confirmPath, {});
  const archivedMeta = snapshot['__meta'];
  if (archivedMeta) {
    // 有意静默：归档数据损坏时保留空表即可，不能因此阻断登录
    try {
      Object.assign(meta, JSON.parse(archivedMeta) as Record<string, number>);
    } catch {}
    delete snapshot['__meta'];
  }
  const archivedConfirm = snapshot['__confirm'];
  if (archivedConfirm) {
    try {
      Object.assign(confirm, JSON.parse(archivedConfirm) as Record<string, string>);
    } catch {}
    delete snapshot['__confirm'];
  }
  rawSet(metaPath, JSON.stringify(meta));
  rawSet(confirmPath, JSON.stringify(confirm));
  if (Object.keys(snapshot).length === 0) {
    rawRemove(quarantineKey);
  } else {
    rawSet(quarantineKey, JSON.stringify(snapshot));
  }
  return restored;
}

/** 登录态变化时调用：切 owner 前先把旧全局元数据备份并复制到新 owner（只做一次） */
export function setSyncOwner(uid: string | null | undefined): void {
  const next = uid || null;
  if (!next) {
    activeOwner = null;
    return; // 登出只解绑，不动数据：再次登录同一账号仍能看到自己的数据
  }
  if (next === activeOwner) {
    writeOwnerMarker(next);
    return;
  }

  const prevOwner = readOwnerMarker();
  activeOwner = next; // 先切命名空间：后续 meta/confirm 都写新账号的

  if (prevOwner && prevOwner !== next) {
    const q = quarantineLocalPii(prevOwner);
    // 若该账号上次在本机也留下过归档，先放回来：切回自己的账号应当能看到自己的数据
    const back = restoreQuarantineFor(next);
    if (back > 0) console.info('[cloudSync] 恢复本账号归档数据:', back, 'keys');
    const notice: SyncOwnerNotice = {
      kind: 'owner-switch',
      from: prevOwner,
      to: next,
      keys: q.keys,
      quarantineKey: q.quarantineKey,
      at: Date.now()
    };
    ownerNoticeCache = notice;
    rawSet(OWNER_NOTICE_KEY, JSON.stringify(notice));
    emitOwnerNotice();
    // 明确提示，不能静默：隔离发生在登录瞬间，toast 之外「我的」页还会常驻一条可关闭的提示
    try {
      Taro.showToast({ title: '已切换账号，本机旧数据已归档', icon: 'none', duration: 3000 });
    } catch {}
    console.warn('[cloudSync] 账号切换，已隔离本机旧数据:', q.keys, 'keys ->', q.quarantineKey);
  } else if (!prevOwner) {
    // 首次启用归属标记：迁移旧全局 meta/confirm 进首个 owner（只做一次）
    for (const base of [META_KEY, CONFIRM_KEY]) {
      const scoped = `${base}:${next}`;
      if (rawGet(scoped)) continue; // 该账号已有自己的元数据，不覆盖
      const legacy = rawGet(base);
      if (!legacy) continue;
      const backup = `${base}-backup-${next}`;
      if (!rawGet(backup)) rawSet(backup, legacy); // 迁移前备份，只留一份最早的
      rawSet(scoped, legacy); // 兼容读：旧全局数据继续生效，但之后只写 owner 键
    }
  }

  writeOwnerMarker(next);
}

/** 会话账号与本机数据归属是否不一致（不一致 = 绝不允许该会话读写本机业务数据） */
function ownerMismatch(sessionOwner: string | null): boolean {
  const localOwner = readOwnerMarker();
  return !!sessionOwner && !!localOwner && localOwner !== sessionOwner;
}

function readMeta(): Record<string, number> {
  return rawGetJSON<Record<string, number>>(ownerKey(META_KEY), {});
}
function writeMeta(meta: Record<string, number>) {
  rawSet(ownerKey(META_KEY), JSON.stringify(meta));
}

/** 读「上次成功推送的值哈希」表（2026-10-19 新增，旧版本没有此键 → 空表） */
function readConfirm(): Record<string, string> {
  return rawGetJSON<Record<string, string>>(ownerKey(CONFIRM_KEY), {});
}
function writeConfirm(confirm: Record<string, string>) {
  rawSet(ownerKey(CONFIRM_KEY), JSON.stringify(confirm));
}

/**
 * 待裁决的同步冲突（内存缓存 + 持久化）。
 * 持久化的理由：冲突常在「登录后拉取」时发现，用户可能先离开页面再处理；
 * 只存内存的话刷新一次提示就没了，而未裁决意味着该键同步一直停着。
 */
let conflictCache: SyncConflict[] = readConflictsFromStorage();
const conflictListeners = new Set<(list: SyncConflict[]) => void>();

function readConflictsFromStorage(): SyncConflict[] {
  const raw = rawGetJSON<unknown>(CONFLICT_KEY, []);
  if (!Array.isArray(raw)) return [];
  // 形状校验：只认带 string key 的条目，脏数据整条丢弃（冲突提示丢了可以再检测，不可信数据不能留）
  return raw.filter(
    (c): c is SyncConflict =>
      !!c && typeof c === 'object' && typeof (c as { key?: unknown }).key === 'string'
  );
}
function writeConflicts(list: SyncConflict[]) {
  rawSet(CONFLICT_KEY, JSON.stringify(list));
}
function emitConflicts() {
  const snapshot = conflictCache.slice();
  conflictListeners.forEach((cb) => {
    try {
      cb(snapshot);
    } catch (err) {
      console.warn('[cloudSync] conflict listener failed:', err);
    }
  });
}

/** 当前待裁决的同步冲突快照（供 UI 订阅前读取） */
export function getSyncConflicts(): SyncConflict[] {
  return conflictCache.slice();
}

/** 订阅同步冲突变化：订阅时立即回调一次当前快照，返回取消订阅函数 */
export function subscribeSyncConflicts(cb: (list: SyncConflict[]) => void): () => void {
  conflictListeners.add(cb);
  cb(conflictCache.slice());
  return () => {
    conflictListeners.delete(cb);
  };
}

/** 墓碑行后缀：`<业务键>#deletedAt`，value 存删除时的 ts。用于「删除最后一条」跨端生效。 */
const TOMBSTONE_SUFFIX = '#deletedAt';

/** 收集本地需推送的 key → [{ key, value, ts }]；ts 取本地记录时间（无记录用 1 兜底，输给远端真实版本） */
function collectLocal(forceEmptyKeys: string[] = []): Array<{ key: string; value: unknown; ts: number }> {
  const meta = readMeta();
  const items: Array<{ key: string; value: unknown; ts: number }> = [];
  // 未裁决的冲突键**不推**：它的 ts 必然旧于远端（否则不会被判成冲突），推上去也是 0 行，
  // 白耗一次 RPC；且用户明确选「保留本机」时会抬 ts 再推，选「采用云端」则本机就该被覆盖。
  const conflicted = new Set(conflictCache.map((c) => c.key));
  for (const k of SYNC_KEYS) {
    // 2026-11-04（P0）：已撤回同意/被排除的键**不打包**。这是「不再上传」的第一道闸，
    // 后面的空数组/超限逻辑都到不了这里，因此不会因 forceEmptyKeys 绕过。
    if (runtimeExcludedKeys.has(k)) continue;
    if (conflicted.has(k)) continue;
    const s = rawGet(k);
    if (!s) continue;
    const v = taroUnwrap(s);
    if (v === '' || v === null || v === undefined) continue;
    // 2026-11-04（缺陷：日历云端不落库）：`1` 是旧版「没有可信时间戳」的哨兵。
    // 继续拿它推 = 服务端按 ts 判旧（远端行本来就是 client_ts=1 或更大），**永远写 0 行**，
    // 云端值被永久冻结（实测 user_kv.dailyPlanStore 恒 {"events":[]} / client_ts=1，
    // 而同期 kv_set_many 请求体里确实带着改后的标题）。
    // initCloudSync 是「先拉后推」，拉取会把每个现存远端 key 的 meta 对齐成真实 remoteTs；
    // 未裁决冲突键也不会进到这里。因此「没有本地计时」时按当前时刻推是安全的：
    // 它只让真正的本地改动成功落地，不会覆盖刚从云端拉下来的更新值。
    const recorded = Number(meta[k]);
    const ts = recorded > 1 ? recorded : Date.now();
    // 2026-11-03（自选股 P0）：**空数组不上推**。
    // 事故链：远端较新的 [] 覆盖本地 → 本地变空 → 30s 后把 [] 回写云端，全端一起清空。
    // 这条规则让「空」永远不能覆盖「有」，宁可牺牲「跨设备同步清空」，也不再丢用户数据。
    // 例外：用户**明确删除**（forceEmptyKeys）时必须推空 —— 否则删掉最后一条自选
    // 就只剩本地生效，云端旧列表下次登录会把它整体拉回来（2026-11-03 实测缺口）。
    if (Array.isArray(v) && v.length === 0) {
      if (!forceEmptyKeys.includes(k)) continue;
      // 缺陷 B3：**显式墓碑**。空数组本身要推（云端存成空），但另一端的「空数组保护」
      // 会拒绝它；墓碑行是独立 key，携带同一个 ts，接收端据此确认「这是删除，不是残影」。
      // 只有走 forced 路径才产生墓碑 ⇒ 非删除场景（空数组不回推）的保护仍然有效。
      items.push({ key: `${k}${TOMBSTONE_SUFFIX}`, value: ts, ts });
    }
    items.push({ key: k, value: v, ts });
  }
  return items;
}

function schedulePush(delay = DEBOUNCE) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushNow();
  }, delay);
}

/* ---------------- 云端副本删除（撤回敏感授权用，2026-11-04 P0） ---------------- */

const PURGE_PENDING_KEY = 'cloud-sync-purge-pending'; // 待删的云端键（删除失败后排队重试）

function readPendingPurges(): string[] {
  const list = rawGetJSON<string[]>(PURGE_PENDING_KEY, []);
  return Array.isArray(list) ? list.filter((k) => typeof k === 'string') : [];
}

function writePendingPurges(keys: string[]): void {
  if (keys.length === 0) rawRemove(PURGE_PENDING_KEY);
  else rawSet(PURGE_PENDING_KEY, JSON.stringify(keys));
}

function queuePurge(keys: string[]): void {
  const next = new Set(readPendingPurges());
  for (const k of keys) next.add(k);
  writePendingPurges([...next]);
}

function dequeuePurge(keys: string[]): void {
  writePendingPurges(readPendingPurges().filter((k) => !keys.includes(k)));
}

/**
 * 删除云端指定同步键，并**回读校验**。
 *
 * 为什么不把「调用过删除」当成功：DELETE 成功也可能被 RLS / 触发器拦下（返回 200 但 0 行），
 * 明确告知用户「已从云端删除」之前必须再拉一次、确认行真的没了。
 * 返回：deleted 成功 / failed 失败（已排队重试）/ no-session 未登录（本机就没有云端副本）。
 */
export async function purgeSyncKeysFromCloud(keys: string[]): Promise<'deleted' | 'failed' | 'no-session'> {
  if (keys.length === 0) return 'deleted';
  const session = await getSession();
  if (!session?.user?.id) return 'no-session';
  const removed = await kvDeleteKeys(keys);
  if (removed === null) {
    queuePurge(keys);
    return 'failed';
  }
  const rows = await kvGetAll();
  if (rows === null) {
    queuePurge(keys);
    return 'failed';
  }
  // console.error 而非 warn：生产构建会剔除 warn，删除失败必须留痕
  const leftover = rows.filter((r) => keys.includes(r.key));
  if (leftover.length > 0) {
    console.error('[cloudSync] 云端副本删除未生效，已排队重试:', leftover.map((r) => r.key).join(','));
    queuePurge(keys);
    return 'failed';
  }
  dequeuePurge(keys);
  return 'deleted';
}

/** 推送周期里补删上次失败的云端副本（30s 一次，成功后出队） */
async function flushPendingPurges(): Promise<void> {
  const pending = readPendingPurges();
  if (pending.length === 0) return;
  const removed = await kvDeleteKeys(pending);
  if (removed === null) return; // 下轮再试
  const rows = await kvGetAll();
  if (rows === null) return;
  if (rows.some((r) => pending.includes(r.key))) return; // 还在，继续排队
  writePendingPurges([]);
  console.info('[cloudSync] 云端副本补删成功:', pending.join(','));
}

/** 推送本地数据到云端（云数据库 kv_set_many，服务端新者赢）。
 *
 *  未登录 → 直接跳过：这不是故障，是「还没到能同步的时候」。
 *  登录后由 onAuthStateChange 补一次「先拉后推」，本地积累的写入不会丢。 */
async function pushNow(forceEmptyKeys: string[] = []): Promise<void> {
  if (syncDisabled) return;
  // 串行化：等待上一轮结束（含「撤回同意时正在飞行的那一次」），再按**最新**排除表收集。
  // 这样撤回后排队的推送不会带着撤回前的快照把轨迹再发一次。
  const previous = pushInFlight;
  const run: Promise<void> = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // 上一轮的失败已在 doPush 内部处理，与本次无关
      }
    }
    await doPush(forceEmptyKeys);
  })();
  pushInFlight = run;
  try {
    await run;
  } finally {
    if (pushInFlight === run) pushInFlight = null;
  }
}

async function doPush(forceEmptyKeys: string[] = []): Promise<void> {
  const session = await getSession();
  const sessionOwner = session?.user?.id || null;
  if (!sessionOwner) return; // 未登录：跳过（不计失败）

  // 撤回敏感授权后若云端删除失败，会排进待删队列；每次推送先尝试补删（30s 一次，
  // 满足「云端删除失败，稍后会重试」的告知）。删成功即出队，不再重复打。
  await flushPendingPurges();

  // 缺陷 B1：推之前先校验「会话账号 == 本机数据归属」。
  // 首次登录（还没有标记）时补记；不一致说明 setSyncOwner 尚未完成隔离（或账号在推送排队期间被切换），
  // 此时**直接 abort**，绝不让本机旧账号数据进新账号的 user_kv。
  if (!readOwnerMarker()) writeOwnerMarker(sessionOwner);
  if (ownerMismatch(sessionOwner)) {
    console.error(
      '[cloudSync] push aborted: 本机数据归属',
      readOwnerMarker(),
      '但当前会话是',
      sessionOwner,
      '（账号切换未完成隔离）'
    );
    return;
  }

  const items = collectLocal(forceEmptyKeys);
  if (items.length === 0) return;
  // 缺陷 X5：云端单键上限 512KB（SQL `pg_column_size(value) < 524288`），超限行会被服务端
  // **静默丢弃**。客户端先按 UTF-8 字节预筛：超限键不发送、不落确认，并明确告知用户。
  const sendable: typeof items = [];
  const oversized: SyncOversizeItem[] = [];
  for (const it of items) {
    const bytes = kvByteSize(it.value);
    if (bytes > KV_VALUE_LIMIT) oversized.push({ key: it.key, bytes });
    else sendable.push(it);
  }
  if (oversized.length > 0) recordOversize(oversized);
  if (sendable.length === 0) return;
  try {
    const written = await kvSetMany(sendable);
    if (written === null) {
      // null = 真故障（SDK 不可用 / 数据库报错）。区分「写不进去」与「被更新的远端挡住」：
      // 后者返回 0 是正常的（旧设备推送陈旧版本），不计失败。
      hardFailures += 1;
      if (hardFailures >= DB_FAIL_LIMIT) disableSync('kv_set_many 返回 null（详见上方 warn）');
      return;
    }
    // 缺陷 B1：推完再校验一次。账号在请求飞行期间被切换 → 数据可能已经落到旧会话的
    // 云端命名空间，但**绝不能**把这次结果记成新账号的已确认状态（否则后续拉取判断全错）。
    const afterOwner = (await getSession())?.user?.id || null;
    if (afterOwner !== sessionOwner) {
      console.error(
        '[cloudSync] push aborted: 会话账号在上传过程中变化（',
        sessionOwner,
        '→',
        afterOwner,
        '），本次不写本地确认记录'
      );
      return;
    }
    hardFailures = 0;
    // 确认时间落本地 meta：后续只推比这个时间更新的写入。
    // 注意「写入 0 行」也要落 —— 那意味着云端已有更新版本，拉取会对齐，不会把旧值推回去。
    // 同时落确认哈希：这条 key 现在相对「已推送状态」是干净的，下次拉取若远端更新可直接覆盖。
    //
    // 缺陷 B3：**只记「本次实际发出的 ts」，不要记 Date.now()**。
    // 旧写法把 meta 抬到当前时间，而云端可能只到本次发出的 ts（写入 0 行 = 被同 ts/更新版本挡住）。
    // 于是另一端随后产生的删除墓碑（ts 介于两者之间）会被 `remoteTs <= metaTs` 判成过旧、
    // 直接跳过 —— 删除永远不生效。取 max(现有 meta, it.ts) 同时兼容「推送飞行中又有本地写入」
    // （那次写入已经把 meta 抬得更高，不能被回退）。
    const meta = readMeta();
    const confirm = readConfirm();
    for (const it of sendable) {
      meta[it.key] = Math.max(Number(meta[it.key]) || 0, it.ts);
      confirm[it.key] = valueHash(it.value);
    }
    writeMeta(meta);
    writeConfirm(confirm);
  } catch (err) {
    // 网络失败等瞬时错误：下一轮轮询再试，不计入硬失败
    console.warn('[cloudSync] push failed (transient):', err);
  }
}

/**
 * 立即推送一次（2026-11-03，自选股删除「真同步」修复）。
 *
 * 为什么需要：`hookStorage()` 会把本地写入排进 1.5s 防抖 + 30s 轮询才推，
 * 删除自选后用户若立刻退出/换设备，云端旧值还留着 —— 下次拉取「云端较新」又把它拉回来，
 * 表现为「删了又复活」。删除这类**用户明确表达删除意图**的写入必须当场推。
 *
 * 失败语义与 pushNow 完全一致：未登录直接跳过（不是故障）；网络失败下轮再试，不抛错。
 *
 * `forceEmptyKeys`：用户明确删除后需要把空值推上去的 key（如删掉最后一条自选）。
 * 默认空数组仍不推（见 collectLocal 的说明）。
 */
export async function syncNow(forceEmptyKeys: string[] = []): Promise<void> {
  await pushNow(forceEmptyKeys);
}

/**
 * 纯函数：把远端数据合并进本地（只认 SYNC_KEYS，且只覆盖 clientTs 比本地已确认值更新的 key）。
 * 按 Taro 信封格式写入本地，页面 getStorageSync 才能读到。返回本次恢复的 key 数。
 *
 * 冲突检测（2026-10-19）：远端较新、但**本机该键有尚未推送的修改**时，不再静默覆盖 ——
 * 记入待裁决冲突（两端数据都保留），由 UI 提示用户选择。判定矩阵见 utils/syncConflict.ts。
 *
 * 抽成纯函数是为了可单测：传输层从 /api 换成云数据库后，**合并口径保持不变**。
 */
function applyRemoteData(remote: KvRow[]): number {
  const meta = readMeta();
  const confirm = readConfirm();
  const newConflicts: SyncConflict[] = [];
  let restored = 0;
  for (const row of remote) {
    if (!row || typeof row.key !== 'string' || !('value' in row)) continue;
    // 缺陷 B3：墓碑行（`<key>#deletedAt`）——显式删除的唯一可信来源。
    // 只有用户走 forced 路径删除时才会产生；普通「空数组回推」没有墓碑，仍被下面的保护拦下。
    if (row.key.endsWith(TOMBSTONE_SUFFIX)) {
      const base = row.key.slice(0, -TOMBSTONE_SUFFIX.length);
      if (!(SYNC_KEYS as readonly string[]).includes(base)) continue;
      // 2026-11-04（P0）：被排除键的墓碑也不落地 —— 撤回后云端副本正在删除，
      // 不能因为一条旧墓碑把本机记录改成占位值（本机记录按告知是「保留」）。
      if (runtimeExcludedKeys.has(base)) continue;
      const remoteTs = Number(row.clientTs) || 0;
      const metaTs = Number(meta[base]) || 0;
      if (remoteTs <= metaTs) continue;
      const localRaw = rawGet(base);
      const localValue = localRaw ? taroUnwrap(localRaw) : undefined;
      const placeholder = REMOVE_PLACEHOLDER[base] ?? [];
      const outcome = classifyPull({ remoteTs, metaTs, localValue, confirmedHash: confirm[base] });
      if (outcome === 'skip') continue;
      if (outcome === 'conflict') {
        newConflicts.push({
          key: base,
          remoteTs,
          remoteValue: placeholder,
          localTs: metaTs,
          at: Date.now()
        });
        continue;
      }
      // 删除落地：写占位值（数组 → []），并与墓碑时间对齐，避免下轮把旧值推回去
      try {
        rawSet(base, JSON.stringify({ data: placeholder }));
        meta[base] = remoteTs;
        confirm[base] = valueHash(placeholder);
        restored++;
        console.warn('[cloudSync] 已应用远端删除标记:', base);
      } catch (err) {
        console.warn('[cloudSync] apply tombstone failed for', base, err);
      }
      continue;
    }
    if (!(SYNC_KEYS as readonly string[]).includes(row.key)) continue;
    // 2026-11-04（P0）：被排除键**不从云端拉回本机**。撤回后云端副本会被删除，
    // 若仍按远端较新覆盖本地，删除动作反而会「复活」一份轨迹数据。
    if (runtimeExcludedKeys.has(row.key)) continue;
    const remoteTs = Number(row.clientTs) || 0;
    const metaTs = Number(meta[row.key]) || 0;
    if (remoteTs <= metaTs) continue; // 远端不比本地已确认的新：廉价先行判断，省掉后面的本地值读取
    const localRaw = rawGet(row.key);
    const localValue = localRaw ? taroUnwrap(localRaw) : undefined;
    // 2026-11-03（自选股 P0）：远端「空数组」永远不覆盖本地「有内容」。
    // 空值只可能是别的设备被清空/回推的残影，宁可保留本地，也不让用户看到数据消失。
    if (Array.isArray(row.value) && row.value.length === 0 && Array.isArray(localValue) && localValue.length > 0) {
      console.warn('[cloudSync] 远端为空数组，拒绝覆盖本地非空数据:', row.key);
      continue;
    }
    const outcome = classifyPull({ remoteTs, metaTs, localValue, confirmedHash: confirm[row.key] });
    if (outcome === 'skip') continue;
    if (outcome === 'conflict') {
      // 双端都有未同步修改：不覆盖任何一端，留给用户裁决（remoteValue 快照供「采用云端」落地）
      newConflicts.push({
        key: row.key,
        remoteTs,
        remoteValue: row.value,
        localTs: metaTs,
        at: Date.now()
      });
      continue;
    }
    // restore / overwrite：本地无值或相对上次推送无新修改，安全采用远端
    try {
      rawSet(row.key, JSON.stringify({ data: row.value }));
      meta[row.key] = remoteTs; // 与远端对齐，避免下轮把旧值又推回去
      confirm[row.key] = valueHash(row.value);
      restored++;
    } catch (err) {
      console.warn('[cloudSync] apply failed for', row.key, err);
    }
  }
  if (restored) writeMeta(meta);
  if (restored || newConflicts.length > 0) writeConfirm(confirm);
  if (newConflicts.length > 0) {
    conflictCache = mergeConflicts(conflictCache, newConflicts);
    writeConflicts(conflictCache);
    console.warn(
      '[cloudSync] 检测到同步冲突（本机未上传的修改已保留，未被覆盖）:',
      newConflicts.map((c) => c.key).join(', ')
    );
    emitConflicts();
  }
  return restored;
}

/**
 * 裁决同步冲突（UI 的「保留本机 / 采用云端」按钮调用）。
 *
 * - `remote`：把云端版本落到本机。**会放弃该键在本机未上传的修改**（这正是按钮的语义），
 *   云端值取拉取时记录的快照，并尽量重新拉一次最新值——设备 B 在提示挂起期间可能又写过，
 *   用过期快照落地会「复活」旧版本。
 * - `local`：保留本机版本。把 meta 抬到当前时间，下一次推送必能盖过云端旧版本。
 *
 * keys 省略 = 处理全部冲突。未裁决前该键不推送（collectLocal 跳过），
 * 因此冲突会一直挂着直到用户选择——这是有意的：宁停同步，不静默丢数据。
 */
export async function resolveSyncConflicts(choice: 'local' | 'remote', keys?: string[]): Promise<void> {
  const targets = keys && keys.length > 0
    ? conflictCache.filter((c) => keys.includes(c.key))
    : conflictCache.slice();
  if (targets.length === 0) return;

  const meta = readMeta();
  const confirm = readConfirm();
  const now = Date.now();

  if (choice === 'remote') {
    // 尽量拿当前云端值；拉取失败（未登录/网络）才退回记录时的快照
    let rows: KvRow[] | null = null;
    try {
      rows = await kvGetAll();
    } catch (err) {
      console.warn('[cloudSync] resolve(remote): refresh pull failed, using snapshot:', err);
    }
    for (const c of targets) {
      const fresh = rows?.find((r) => r.key === c.key);
      const value = fresh && 'value' in fresh ? fresh.value : c.remoteValue;
      rawSet(c.key, JSON.stringify({ data: value }));
      meta[c.key] = Number(fresh?.clientTs) || Number(c.remoteTs) || now;
      confirm[c.key] = valueHash(value);
    }
  } else {
    for (const c of targets) {
      // 抬到最新：下一次推送的 ts 必大于云端已存版本，服务端新者赢会放行
      meta[c.key] = now;
    }
  }

  writeMeta(meta);
  writeConfirm(confirm);
  conflictCache = withoutConflicts(conflictCache, targets.map((c) => c.key));
  writeConflicts(conflictCache);
  emitConflicts();
  if (choice === 'local') schedulePush(0); // 保留本机：立刻推上去，别等下一个防抖/轮询
}

/**
 * 启动/登录后拉取：远端 clientTs 较新的 key 覆盖本地（跨设备恢复）。
 * 未登录 → 直接返回（不是故障）；拉取失败 → warn 一次，本地数据不受影响。
 */
async function pullRemote(): Promise<void> {
  if (syncDisabled) return; // 熔断后停的是「整个跨设备同步」：缺表/缺策略不会自愈，拉取每次都会同样失败
  if (pulling) return;
  pulling = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);
  try {
    const sessionOwner = (await getSession())?.user?.id || null;
    if (!sessionOwner) return; // 未登录：无云端数据可拉
    // 缺陷 B1：拉取前校验归属；若本机还挂着旧账号数据（隔离未完成），绝不能把新账号的
    // 远端数据写进同一个本地命名空间，否则旧数据会被「新数据」混着展示、甚至反推回新账号。
    if (ownerMismatch(sessionOwner)) {
      console.error('[cloudSync] pull aborted: 本机数据归属与当前会话不一致');
      return;
    }
    const rows = await kvGetAll(controller.signal);
    if (rows === null) return; // 真故障，kvGetAll 内已 warn
    const afterOwner = (await getSession())?.user?.id || null;
    if (afterOwner !== sessionOwner) {
      console.error('[cloudSync] pull aborted: 会话账号在拉取过程中变化（', sessionOwner, '→', afterOwner, '）');
      return;
    }
    const restored = applyRemoteData(rows);
    if (restored) console.info('[cloudSync] restored', restored, 'keys from cloud');
  } catch (err) {
    // 网络失败 / 超时中止：有意静默降级（本地数据不受影响），warn 一次便于排查。
    console.warn('[cloudSync] pull failed:', err);
  } finally {
    clearTimeout(timer);
    pulling = false;
  }
}

/** 劫持本地写入：任何 SYNC_KEYS 的写/删都触发防抖推送（不改动任何业务代码）。
 *
 *  2026-11-04（缺陷：日历云端不落库）—— 原实现是把 `Taro.setStorageSync` 整个替换掉。
 *  实测该赋值**并不生效**（真机日志里改完日程后 `cloud-sync-meta:<uid>.dailyPlanStore`
 *  仍是旧值 1，且写入探针显示只有 `dailyPlanStore` 被 setItem、meta 没有跟着写），
 *  于是所有本地写入都不记时间戳 ⇒ collectLocal 取到哨兵 1 ⇒ 推送永远 0 行 ⇒ 云端永久冻结。
 *
 *  现在改挂 `window.localStorage.setItem/removeItem`：这是 Taro H5 存储的**最终落点**
 *  （实测确认），与模块加载顺序无关，也不依赖 Taro 对象是否可写。
 *  内部写盘（pull 对齐 / 推送确认 / 隔离搬迁）走 rawSet 的标记，不会触发自己。
 */
function hookStorage(): void {
  try {
    const ls = window.localStorage;
    const origSet = ls.setItem.bind(ls);
    const origRemove = ls.removeItem.bind(ls);
    const markDirty = (key: string) => {
      if (!(SYNC_KEYS as readonly string[]).includes(key)) return;
      // 2026-11-04（P0）：被排除的键**不抬时间戳、不排推送**。
      // 即使有别的代码路径在撤回后仍写了一次 sportRuns，也不会触发一次出网。
      if (runtimeExcludedKeys.has(key)) return;
      const meta = readMeta();
      meta[key] = Date.now(); // 本地写入即计时；推送确认后更新为确认时间
      writeMeta(meta);
      schedulePush();
    };
    ls.setItem = (key: string, value: string) => {
      origSet(key, value);
      if (!internalStorageWrite) markDirty(key);
    };
    ls.removeItem = (key: string) => {
      origRemove(key);
      if (internalStorageWrite || !(SYNC_KEYS as readonly string[]).includes(key)) return;
      // 被排除的键（撤回健康同意后的 sportRuns）：本地删除只在本机生效，不写占位、不排推送
      if (runtimeExcludedKeys.has(key)) return;
      // 删除后写入与该 key 类型一致的占位值（见 REMOVE_PLACEHOLDER），保证删除动作同步到云端
      rawSet(key, JSON.stringify({ data: REMOVE_PLACEHOLDER[key] }));
      const meta = readMeta();
      meta[key] = Date.now();
      writeMeta(meta);
      schedulePush();
    };
  } catch (err) {
    console.warn('[cloudSync] hook failed:', err);
  }
}

/**
 * 应用入口调用：仅 H5。启动恢复（异步）→ 接管写入 → 登录态订阅 → 轮询兜底。
 *
 * 返回的 Promise 在**恢复完成后** resolve。调用方若在首屏渲染 / 存储重放前依赖云端恢复的数据
 * （语言 / 主题 / 字号等），必须 await 或 .then() 这个 Promise。
 */
export function initCloudSync(): Promise<void> {
  if (process.env.TARO_ENV !== 'h5') return Promise.resolve();
  hookStorage();
  // 启动恢复：已登录就拉（未登录立即 resolve；登录后的拉取走下面的订阅）
  readyPromise = getSession()
    .then((s) => {
      // 2026-11-03（自选股 P0）：拉取前先绑定 owner，元数据按账号隔离并做迁移备份。
      setSyncOwner(s?.user?.id);
      return s ? pullRemote() : undefined;
    })
    .catch((err) => {
      console.warn('[cloudSync] bootstrap session check failed:', err);
    });
  // 登录成功 → 先拉后推：把另一台设备上的较新数据合进来，再把本机积累的推送上去。
  // 不挑事件名（SIGNED_IN / INITIAL_SESSION 都以「带会话」为准）——SDK 的事件名字面
  // 没有在文档里承诺，按「有没有会话」判最稳。
  onAuthStateChange((session) => {
    // 2026-11-03（自选股 P0）：每次登录态变化都切 owner（含登出置空），
    // 不同账号的 meta/confirm 互不污染。
    setSyncOwner(session?.user?.id);
    if (!session) return;
    void pullRemote().then(() => pushNow());
  });
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void pushNow(), SYNC_INTERVAL);
  // 页面隐藏/关闭前兜底推送一次
  try {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void pushNow();
    });
  } catch (err) {
    // 注册失败不阻断主流程（30s 轮询仍在），但值得留痕：否则「关页前不推送」将无从排查。
    console.warn('[cloudSync] visibilitychange 兜底推送注册失败（关闭页面前不再兜底推送）:', err);
  }
  return readyPromise;
}

/** 「启动恢复完成」信号：供无法捕获 initCloudSync() 返回值的调用方 await（未初始化时立即 resolve） */
export function cloudSyncReady(): Promise<void> {
  return readyPromise || Promise.resolve();
}
