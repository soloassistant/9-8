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
import { kvGetAll, kvSetMany } from './cloudDb';
import type { KvRow } from './cloudDb';

const META_KEY = 'cloud-sync-meta'; // { [storageKey]: ts } 本地各 key 最后一次确认同步的时间
const SYNC_INTERVAL = 30_000; // 兜底轮询：每 30 秒推一次变更
const DEBOUNCE = 1500; // 写入后防抖 1.5 秒再推，合并连续写入
const PULL_TIMEOUT_MS = 8000; // 启动拉取超时（SDK 请求自行 abort，避免悬挂）

/** 需要上云的 key（与 src 内实际使用一一对应；设备级隐私同意不上云） */
const SYNC_KEYS = [
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
  'briefingChatLog',  // 晨报 AI 对话（限长 60）
  'aiAssistantLog',   // 悬浮球 AI 对话（限长 60）
  'brand-theme',      // 主题
  'app-lang',         // 语言
  'ui-scale',          // 字号
  // 记账（v2.0 F23）：刻意**拆成三个 key**而不是一个 ledger 对象。
  // 分类/预算的写入频率远低于条目，分开后 per-key「新者赢」互不干扰 ——
  // 否则在别的设备加一笔账，会把这一端的预算设置一起覆盖掉。
  'ledgerEntries',    // 记账条目
  'ledger-categories', // 记账分类（含用户增删改）
  'ledgerBudget'      // 记账预算（日/月上限）
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
  // 对象类
  'user-settings': {},
  // 标量类
  'user-city': '',
  'usage-voice': '',
  'brand-theme': '',
  'app-lang': '',
  'ui-scale': ''
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
function rawSet(key: string, value: string) {
  // 有意静默：与 rawGet 对称的写兜底。localStorage 不可用（被禁用 / 配额满）时，
  // 同步能力本身已失效；而「应用远端数据」这条关键路径另有 console.warn 兜底（见 applyRemoteData）。
  try { window.localStorage.setItem(key, value); } catch {}
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

function readMeta(): Record<string, number> {
  return rawGetJSON<Record<string, number>>(META_KEY, {});
}
function writeMeta(meta: Record<string, number>) {
  rawSet(META_KEY, JSON.stringify(meta));
}

/** 收集本地需推送的 key → [{ key, value, ts }]；ts 取本地记录时间（无记录用 1 兜底，输给远端真实版本） */
function collectLocal(): Array<{ key: string; value: unknown; ts: number }> {
  const meta = readMeta();
  const items: Array<{ key: string; value: unknown; ts: number }> = [];
  for (const k of SYNC_KEYS) {
    const s = rawGet(k);
    if (!s) continue;
    const v = taroUnwrap(s);
    if (v === '' || v === null || v === undefined) continue;
    items.push({ key: k, value: v, ts: Math.max(Number(meta[k]) || 1, 1) });
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

function disableSync(reason: string) {
  syncDisabled = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.error(
    `[cloudSync] 连续 ${DB_FAIL_LIMIT} 次云数据库失败，已停止轮询（跨设备同步当前不可用），本地数据不受影响。` +
      `首次失败原因：${reason}`
  );
}

/** 推送本地数据到云端（云数据库 kv_set_many，服务端新者赢）。
 *
 *  未登录 → 直接跳过：这不是故障，是「还没到能同步的时候」。
 *  登录后由 onAuthStateChange 补一次「先拉后推」，本地积累的写入不会丢。 */
async function pushNow(): Promise<void> {
  if (syncDisabled) return;
  if (!(await getSession())) return; // 未登录：跳过（不计失败）
  const items = collectLocal();
  if (items.length === 0) return;
  try {
    const written = await kvSetMany(items);
    if (written === null) {
      // null = 真故障（SDK 不可用 / 数据库报错）。区分「写不进去」与「被更新的远端挡住」：
      // 后者返回 0 是正常的（旧设备推送陈旧版本），不计失败。
      hardFailures += 1;
      if (hardFailures >= DB_FAIL_LIMIT) disableSync('kv_set_many 返回 null（详见上方 warn）');
      return;
    }
    hardFailures = 0;
    // 确认时间落本地 meta：后续只推比这个时间更新的写入。
    // 注意「写入 0 行」也要落 —— 那意味着云端已有更新版本，拉取会对齐，不会把旧值推回去。
    const now = Date.now();
    const meta = readMeta();
    for (const it of items) meta[it.key] = now;
    writeMeta(meta);
  } catch (err) {
    // 网络失败等瞬时错误：下一轮轮询再试，不计入硬失败
    console.warn('[cloudSync] push failed (transient):', err);
  }
}

/**
 * 纯函数：把远端数据合并进本地（只认 SYNC_KEYS，且只覆盖 clientTs 比本地已确认值更新的 key）。
 * 按 Taro 信封格式写入本地，页面 getStorageSync 才能读到。返回本次恢复的 key 数。
 *
 * 抽成纯函数是为了可单测：传输层从 /api 换成云数据库后，**合并口径保持不变**。
 */
function applyRemoteData(remote: KvRow[]): number {
  const meta = readMeta();
  let restored = 0;
  for (const row of remote) {
    if (!(SYNC_KEYS as readonly string[]).includes(row.key)) continue;
    if (!row || !('value' in row)) continue;
    if ((Number(row.clientTs) || 0) > (Number(meta[row.key]) || 0)) {
      // 远端比本机已确认的新 → 覆盖本地（按 Taro 信封格式写入，页面 getStorageSync 才能读到）
      try {
        rawSet(row.key, JSON.stringify({ data: row.value }));
        meta[row.key] = Number(row.clientTs) || 0; // 与远端对齐，避免下轮把旧值又推回去
        restored++;
      } catch (err) {
        console.warn('[cloudSync] apply failed for', row.key, err);
      }
    }
  }
  if (restored) writeMeta(meta);
  return restored;
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
    if (!(await getSession())) return; // 未登录：无云端数据可拉
    const rows = await kvGetAll(controller.signal);
    if (rows === null) return; // 真故障，kvGetAll 内已 warn
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

/** 劫持 Taro 写入：本地任何 SYNC_KEYS 的写/删都触发防抖推送（不改动任何业务代码） */
function hookStorage(): void {
  try {
    const origSet = Taro.setStorageSync.bind(Taro);
    const origRemove = Taro.removeStorageSync.bind(Taro);
    (Taro as unknown as { setStorageSync: typeof Taro.setStorageSync }).setStorageSync = (key: string, value: unknown) => {
      origSet(key, value);
      if ((SYNC_KEYS as readonly string[]).includes(key)) {
        const meta = readMeta();
        meta[key] = Date.now(); // 本地写入即计时；推送确认后更新为确认时间
        writeMeta(meta);
        schedulePush();
      }
    };
    (Taro as unknown as { removeStorageSync: typeof Taro.removeStorageSync }).removeStorageSync = (key: string) => {
      origRemove(key);
      if ((SYNC_KEYS as readonly string[]).includes(key)) {
        // 删除后写入与该 key 类型一致的占位值（见 REMOVE_PLACEHOLDER），保证删除动作同步到云端
        origSet(key, REMOVE_PLACEHOLDER[key]);
        const meta = readMeta();
        meta[key] = Date.now();
        writeMeta(meta);
        schedulePush();
      }
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
    .then((s) => (s ? pullRemote() : undefined))
    .catch((err) => {
      console.warn('[cloudSync] bootstrap session check failed:', err);
    });
  // 登录成功 → 先拉后推：把另一台设备上的较新数据合进来，再把本机积累的推送上去。
  // 不挑事件名（SIGNED_IN / INITIAL_SESSION 都以「带会话」为准）——SDK 的事件名字面
  // 没有在文档里承诺，按「有没有会话」判最稳。
  onAuthStateChange((session) => {
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
