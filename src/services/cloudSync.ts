/**
 * 用户数据轻云同步：微信云开发就绪前的过渡方案。
 * 数据流：localStorage ←→ 同源 /api/user/data(拉) /api/user/sync(推)，服务端按 userId 隔离存 JSON 文件。
 * 策略：per-key 时间戳 + 服务端保留较新版本（防旧设备覆盖新数据）；启动时远端较新的 key 覆盖本地（跨设备恢复）。
 *
 * 重要：本模块运行于 Taro 引擎就绪之前的模块加载期（必须先于页面首屏恢复数据），
 * 因此一律使用原生 localStorage 直读直写，绝不经过 Taro.setStorageSync——
 * 模块加载期 Taro API 可能尚未注入，会静默失败导致恢复失效（已踩坑验证）。
 * 仅 H5 生效：weapp 走微信 openid + 云数据库，不进本模块。
 */
import Taro from '@tarojs/taro';
import { LEARNING_SYNC_KEYS } from '@/features/learning/host-sync';

const USER_ID_KEY = 'cloud-user-id';
const META_KEY = 'cloud-sync-meta'; // { [storageKey]: ts } 本地各 key 最后一次确认同步的时间
const SYNC_INTERVAL = 30_000; // 兜底轮询：每 30 秒推一次变更
const DEBOUNCE = 1500; // 写入后防抖 1.5 秒再推，合并连续写入

/** 需要上云的 key（与 src 内实际使用一一对应；设备级隐私同意不上云） */
const SYNC_KEYS = [
  'shoppingList',     // 购物清单
  'dailyPlanStore',   // 日程/待办
  'browseHistory',    // 浏览历史
  'newsFeedback',     // 资讯反馈
  'news-interests',        // AI 精选兴趣标签
  'news-interests-custom', // AI 精选自定义关键词
  'activity-log',     // 活动记录
  ...LEARNING_SYNC_KEYS, // 学习平台进度
  'ai-memory',        // AI 记忆
  'user-settings',    // 我的页设置
  'user-city',        // 城市
  'briefingChatLog',  // 晨报 AI 对话（限长 60）
  'aiAssistantLog',   // 悬浮球 AI 对话（限长 60）
  'brand-theme',      // 主题
  'app-lang',         // 语言
  'ui-scale'          // 字号
] as const;

let userId = '';
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pulling = false;

// ---- 原生 localStorage 封装（模块加载期可用，不依赖 Taro） ----
// 注意：Taro H5 的存储是信封格式——setStorageSync 写入 JSON.stringify({ data: 值 })，
// getStorageSync 只认带 data 属性的信封对象（裸值会被当「非 Taro 数据」返回空）。
// 因此恢复数据必须按信封格式写入，读取时解信封，否则页面读到的一律是空（已踩坑验证）。
function rawGet(key: string): string {
  try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
}
function rawSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch {}
}
/** 按 Taro 语义读值：信封 { data } 解包返回，裸值原样返回 */
function taroUnwrap(raw: string): unknown {
  let item: unknown;
  try { item = JSON.parse(raw); } catch { return undefined; }
  if (item && typeof item === 'object' && !Array.isArray(item) && Object.prototype.hasOwnProperty.call(item, 'data')) {
    return (item as { data: unknown }).data;
  }
  return item;
}
function rawGetJSON<T>(key: string, fallback: T): T {
  const s = rawGet(key);
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function ensureUserId(): string {
  if (userId) {
    // localStorage 被清（模拟换设备/清缓存）时重新生成，保持内存态与存储一致
    if (!rawGet(USER_ID_KEY)) userId = '';
  }
  if (!userId) {
    let id = rawGet(USER_ID_KEY);
    if (!id || id.length < 6) {
      id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      rawSet(USER_ID_KEY, id);
    }
    userId = id;
  }
  return userId;
}

function readMeta(): Record<string, number> {
  return rawGetJSON<Record<string, number>>(META_KEY, {});
}
function writeMeta(meta: Record<string, number>) {
  rawSet(META_KEY, JSON.stringify(meta));
}

/** 收集本地需推送的 key → { key: { v, ts } }；ts 取本地记录时间（无记录用 1 兜底，输给远端真实版本） */
function collectLocal(): { data: Record<string, { v: unknown; ts: number }>; keys: string[] } {
  const meta = readMeta();
  const data: Record<string, { v: unknown; ts: number }> = {};
  const keys: string[] = [];
  for (const k of SYNC_KEYS) {
    const s = rawGet(k);
    if (!s) continue;
    const v = taroUnwrap(s);
    if (v === '' || v === null || v === undefined) continue;
    const ts = Math.max(Number(meta[k]) || 1, 1);
    data[k] = { v, ts };
    keys.push(k);
  }
  return { data, keys };
}

function schedulePush(delay = DEBOUNCE) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushNow();
  }, delay);
}

/** 推送本地数据到云端 */
async function pushNow(): Promise<void> {
  const { data, keys } = collectLocal();
  if (!keys.length) return;
  try {
    const res = await fetch('/api/user/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: ensureUserId(), data })
    });
    if (!res.ok) return;
    const j = await res.json().catch(() => null);
    if (j && j.ok) {
      const now = Date.now();
      const meta = readMeta();
      for (const k of keys) meta[k] = now; // 记录确认时间，后续只推更新的
      writeMeta(meta);
    }
  } catch {
    // 网络失败静默：下轮轮询再试
  }
}

/** 启动拉取：远端 ts 较新的 key 覆盖本地（跨设备恢复）。同步 XHR，保证页面首屏渲染前完成恢复 */
function pullRemote(): void {
  if (pulling) return;
  pulling = true;
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/user/data?userId=' + encodeURIComponent(ensureUserId()), false); // sync XHR：H5 仅此一处，恢复必须先于首屏
    xhr.send(null);
    if (xhr.status !== 200) {
      console.info('[cloudSync] pull skipped, status', xhr.status);
      return;
    }
    const j = JSON.parse(xhr.responseText || '{}') as { data?: Record<string, { v: unknown; ts: number }> };
    const remote = j.data || {};
    const meta = readMeta();
    let restored = 0;
    for (const k of Object.keys(remote)) {
      if (!(SYNC_KEYS as readonly string[]).includes(k)) continue;
      const r = remote[k];
      if (!r || !('v' in r)) continue;
      if ((Number(r.ts) || 0) > (Number(meta[k]) || 0)) {
        // 远端比本机已确认的新 → 覆盖本地（按 Taro 信封格式写入，页面 getStorageSync 才能读到）
        try {
          rawSet(k, JSON.stringify({ data: r.v }));
          meta[k] = Number(r.ts) || 0; // 与远端对齐，避免下轮把旧值又推回去
          restored++;
        } catch (err) {
          console.warn('[cloudSync] apply failed for', k, err);
        }
      }
    }
    if (restored) {
      writeMeta(meta);
      console.info('[cloudSync] restored', restored, 'keys from cloud');
    }
  } catch (err) {
    console.warn('[cloudSync] pull failed:', err);
  } finally {
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
        // 删除后写入空数组占位（清空浏览历史等场景），保证删除动作同步到云端
        origSet(key, []);
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

/** 应用入口调用：仅 H5。先恢复 → 再接管写入 → 启动轮询兜底 */
export function initCloudSync(): void {
  if (process.env.TARO_ENV !== 'h5') return;
  pullRemote(); // 同步执行，先于首屏
  hookStorage();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => void pushNow(), SYNC_INTERVAL);
  // 页面隐藏/关闭前兜底推送一次
  try {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void pushNow();
    });
  } catch {}
}
