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
import { classifyPull, mergeConflicts, withoutConflicts, valueHash, type SyncConflict } from '../utils/syncConflict';

const META_KEY = 'cloud-sync-meta'; // { [storageKey]: ts } 本地各 key 最后一次确认同步的时间
const CONFIRM_KEY = 'cloud-sync-confirm'; // { [storageKey]: hash } 各 key 上次成功推送的值哈希（冲突检测用）
const CONFLICT_KEY = 'cloud-sync-conflict'; // SyncConflict[] 待用户裁决的同步冲突（持久化，刷新不丢提示）
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
  // 运动（2026-10-28）：跑步记录 + 周目标。与记账同款拆两个 key ——
  // 记录写入频繁、周目标几乎不改，分开才不会互相覆盖。
  'sportRuns',
  'sport-goal-km'
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
  // 对象类
  'user-settings': {},
  // 功能记账是 `{ 'YYYY-MM-DD': { chat: n } }` 的对象，占位必须是空对象；
  // 写成 '' 会被 parseBuckets 当成空账本 —— 删除动作传不出去，云端留着旧计数。
  'feature-usage': {},
  // 标量类
  'user-city': '',
  'usage-voice': '',
  'brand-theme': '',
  'app-lang': '',
  'ui-scale': '',
  'sport-goal-km': ''
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

/** 读「上次成功推送的值哈希」表（2026-10-19 新增，旧版本没有此键 → 空表） */
function readConfirm(): Record<string, string> {
  return rawGetJSON<Record<string, string>>(CONFIRM_KEY, {});
}
function writeConfirm(confirm: Record<string, string>) {
  rawSet(CONFIRM_KEY, JSON.stringify(confirm));
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

/** 收集本地需推送的 key → [{ key, value, ts }]；ts 取本地记录时间（无记录用 1 兜底，输给远端真实版本） */
function collectLocal(): Array<{ key: string; value: unknown; ts: number }> {
  const meta = readMeta();
  const items: Array<{ key: string; value: unknown; ts: number }> = [];
  // 未裁决的冲突键**不推**：它的 ts 必然旧于远端（否则不会被判成冲突），推上去也是 0 行，
  // 白耗一次 RPC；且用户明确选「保留本机」时会抬 ts 再推，选「采用云端」则本机就该被覆盖。
  const conflicted = new Set(conflictCache.map((c) => c.key));
  for (const k of SYNC_KEYS) {
    if (conflicted.has(k)) continue;
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
    // 同时落确认哈希：这条 key 现在相对「已推送状态」是干净的，下次拉取若远端更新可直接覆盖。
    const now = Date.now();
    const meta = readMeta();
    const confirm = readConfirm();
    for (const it of items) {
      meta[it.key] = now;
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
    if (!(SYNC_KEYS as readonly string[]).includes(row.key)) continue;
    if (!row || !('value' in row)) continue;
    const remoteTs = Number(row.clientTs) || 0;
    const metaTs = Number(meta[row.key]) || 0;
    if (remoteTs <= metaTs) continue; // 远端不比本地已确认的新：廉价先行判断，省掉后面的本地值读取
    const localRaw = rawGet(row.key);
    const localValue = localRaw ? taroUnwrap(localRaw) : undefined;
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
