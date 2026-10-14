import Taro from '@tarojs/taro'
import type { Briefing, BriefingIntel, HotspotNews } from '../types'
import type { UserPrefs } from '../utils/prefs'
import { fetchWeatherDirect } from '../utils/weather'
import { evaluatePriceAlerts, type PricedItem, type PriceAlert } from '../utils/price'
import { categoryOf } from '../utils/categoryLabel'
import { invoke, isWeapp } from './dataSource'
import { chatViaCloudLlm, typewriter } from './cloudLlm'

/** 热点数据来源元信息（服务端 /api/hotspot 附带，mock/真机路径为 null） */
export interface HotspotMeta {
  updatedAt: string | null
  stale: boolean
  sources: { name: string; count: number; ok: boolean }[]
}
let hotspotMeta: HotspotMeta | null = null
export function getHotspotMeta(): HotspotMeta | null {
  return hotspotMeta
}

/** ── 降级登记表（诚实性，2026-10-12）─────────────────────────────────────
 *  H5 端多数云函数**没有可用的 RPC 通道**（services/dataSource.ts 的 RPC_ALLOWLIST 只放行
 *  webSearch / chat / extract），拿不到就走 src/data/* 的本地实现；chat/extract 的本地 LLM 代理
 *  也只在本机开发时存在。此前这一步是**静默**的：用户看到的是本地/演示数据，却以为来自云端。
 *
 *  这里把「哪些 action 发生了降级」登记成模块级状态，供 UI 订阅后如实提示。
 *  ⚠️ 必须**可复位**：真实路径成功时清掉对应条目（clearDegraded），否则一次降级会永久显示提示。 */
const degradedActions = new Set<string>()
const degradedListeners = new Set<(actions: string[]) => void>()

/** 本地实现返回的是**用户真实本地数据**（不是演示数据）的 action。
 *  回退到这些 action 时**不**登记降级 —— 否则会出现「把用户真实收藏/购物清单谎报成演示数据」
 *  的**反向不诚实**。这正是 src/data/getLibrary.ts 注释「不造演示数据」与
 *  「src/data/* 一律被当作 mock 兜底目录」这一约定之间的既有语义矛盾：
 *  该文件确实只读 collectionStore 里的真实本地数据（src/data/collectionStore.ts:19），
 *  注释与**它自身的行为**一致，矛盾在于**调用路径把他当 mock**。
 *  新增本地模块时请同步维护本表。 */
const REAL_LOCAL_ACTIONS = new Set(['getLibrary', 'shopping', 'confirmItem', 'getUsage'])

function emitDegraded(): void {
  const snapshot = Array.from(degradedActions)
  degradedListeners.forEach((cb) => {
    try {
      cb(snapshot)
    } catch (err) {
      console.warn('[Cloud] degraded listener failed:', err)
    }
  })
}

/** 登记一次降级（幂等；只在真正新增条目时通知订阅者） */
export function markDegraded(name: string): void {
  if (REAL_LOCAL_ACTIONS.has(name) || degradedActions.has(name)) return
  degradedActions.add(name)
  emitDegraded()
}

/** 复位一次降级（真实路径成功时调用；只在真正删除条目时通知订阅者） */
export function clearDegraded(name: string): void {
  if (!degradedActions.delete(name)) return
  emitDegraded()
}

/** 当前处于降级状态的 action 快照（供非 React 代码读取） */
export function getDegradedActions(): string[] {
  return Array.from(degradedActions)
}

/** 订阅降级变化：订阅时**立即回调一次当前快照**，返回取消订阅函数（可直接作为 useEffect 的 cleanup） */
export function subscribeDegraded(cb: (actions: string[]) => void): () => void {
  degradedListeners.add(cb)
  cb(Array.from(degradedActions))
  return () => {
    degradedListeners.delete(cb)
  }
}

/** 线上实时热点 JSON（GitHub Actions 每 30 分钟刷新 gh-pages 上的这一份）。
 *
 *  为什么需要它（2026-09-29 发布正式版时发现）：**发布包与 gh-pages 是两份独立快照**。
 *  发布时烘焙进 dist/api/hotspot.json 的数据会停在打包那一刻，不重新发布会一直是旧的 ——
 *  对用户就是「刚上线就已经过期」。因此把线上那份**动态数据**提到同源烘焙文件之前：
 *  优先取新鲜的，取不到才退回烘焙版（离网 / 被墙时页面仍不为空）。
 *
 *  GitHub Pages 对该文件返回 `Access-Control-Allow-Origin: *`（已实测），故可跨域直取。 */
const LIVE_HOTSPOT_URL = 'https://soloassistant.github.io/9-8/api/hotspot.json'

/** H5 热点数据源（真实数据分层，顺序即优先级）：
 *  ① 同源 /api/hotspot（本地预览 / 带后端的部署，最新鲜）
 *  ② 线上实时 JSON（每 30 分钟刷新，发布版靠它不过期）
 *  ③ 同源烘焙 ./api/hotspot.json（相对路径兼容 /9-8/ 子路径；离线兜底）
 *  ④ 全部失败返回 null，调用方自行 mock 兜底 */
async function loadHotspotPayload(): Promise<{
  items: HotspotNews[]
  updatedAt: string | null
  stale: boolean
  sources: { name: string; count: number; ok: boolean }[]
} | null> {
  for (const url of ['/api/hotspot', LIVE_HOTSPOT_URL, './api/hotspot.json']) {
    try {
      const res = await fetch(url)
      const payload = await res.json()
      if (Array.isArray(payload.items) && payload.items.length > 0) {
        return {
          // 信任边界：服务端聚合 JSON 未逐字段校验，在此收口为 HotspotNews
          items: payload.items as HotspotNews[],
          updatedAt: payload.updatedAt || null,
          stale: !!payload.stale,
          sources: payload.sources || []
        }
      }
    } catch {
      /* 换下一个数据源 */
    }
  }
  return null
}

/** H5 天气数据源：同源 /api/briefing（本地预览）→ 失败直连 Open-Meteo（Pages 线上）→ null */
async function loadWeather(city: string): Promise<{ text: string; updateTime: string } | null> {
  try {
    const res = await fetch(`/api/briefing?city=${encodeURIComponent(city)}`)
    if (res.ok) {
      const p = await res.json()
      if (p && p.weather) return p.weather
    }
  } catch {
    /* 同源接口不可用，直连 Open-Meteo */
  }
  return fetchWeatherDirect(city)
}

/** 流式 chat 结果（F-03）：与 apiChat 最小公共字段对齐 */
export interface ChatStreamResult {
  reply: string
  action: string
}

/**
 * H5 AI 流式对话（F-03）：cloud.llm 流式收集 → 解析出 reply → 客户端打字机增量回调。
 *
 * 为什么要「先收完再打字」（2026-10-13）：模型输出是 JSON 契约（reply/action/proposals…），
 * 原始分片直接灌进气泡会把 JSON 结构露给用户。因此整条流收完、解析、再按 onDelta
 * 复刻打字机动效（cloudLlm.typewriter）—— 动效一致，且绝不显示 JSON。
 * onDelta 契约与旧 llm-proxy 路径完全相同，调用方无感。
 *
 * 返回 null = 云端 LLM 不可用（未登录/无可用模型/流失败），调用方降级 apiChat 整段。
 * weapp 端受云函数非流式限制维持整段返回。
 */
export async function chatCloudStream(
  message: string,
  deep: boolean,
  onDelta: (chunk: string) => void,
  memories?: string[]
): Promise<ChatStreamResult | null> {
  if (isWeapp) return null
  const res = await chatViaCloudLlm({ message, deep, memories })
  if (!res) return null
  await typewriter(res.reply, onDelta)
  return { reply: res.reply, action: res.action }
}

/** H5 开发态兜底：本地 llm-proxy（8138）。chat → POST /，extract → POST /extract；
 *  只在开发机存在，线上必然不可达 —— 因此它只是 ② 级兜底，不再是主路径。 */
const LLM_PROXY_BASE = 'http://localhost:8138'
async function callLocalAI<T>(name: string, data?: Record<string, unknown>): Promise<T | null> {
  try {
    const isExtract = name === 'extract'
    const url = isExtract ? `${LLM_PROXY_BASE}/extract` : `${LLM_PROXY_BASE}/`
    const body = isExtract
      ? { content: data?.content, images: data?.images }
      : { message: data?.message, deep: data?.deep, mode: data?.mode, workAction: data?.workAction, memories: data?.memories }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch (err) {
    console.warn('[Cloud] local AI proxy error:', err)
    return null
  }
}

/** H5 真实 AI：cloud.llm 直连（2026-10-13 起生产可用的真 AI 路径）→ 本地 LLM 代理（开发态）
 *  → 本地规则 mock。2026-10-05 之前只有 ②③，而 ② 的代理只在开发机跑，
 *  线上必然落到 ③ —— 于是 H5 的"AI 对话"在生产环境其实一直是假规则。 */
async function callChatOrExtract<T>(name: string, data?: Record<string, unknown>): Promise<T | null> {
  if (name === 'chat') {
    const viaCloud = await chatViaCloudLlm(data)
    if (viaCloud) return viaCloud as T
    console.warn('[Cloud] chat via cloud.llm unavailable, try local proxy')
  }
  return callLocalAI<T>(name, data)
}

/**
 * H5 端晨报的降价提醒（P-01 时机② 晨报生成时）：
 * 读 mock 购物清单里已有的价格记录，按 utils/price.ts 的同一规则比对心理价位，失败降级为空数组。
 */
async function loadMockPriceAlerts(): Promise<PriceAlert[]> {
  try {
    const shopModule = await import('../data/shopping')
    const items = shopModule.default({ action: 'list' }) as unknown as PricedItem[]
    return evaluatePriceAlerts(Array.isArray(items) ? items : [])
  } catch (err) {
    console.warn('[Cloud] price alerts failed:', err)
    return []
  }
}

/** X3 偏好上报（weapp 走 chat 云函数 savePrefs，云端白名单清洗后 upsert）；H5 无云函数通道返回 false 不阻塞 */
export async function apiSavePrefs(prefs: UserPrefs): Promise<boolean> {
  if (!isWeapp) return false
  try {
    const res = await callFunction<{ saved?: boolean }>('chat', { action: 'savePrefs', prefs })
    return !!(res && res.saved)
  } catch (err) {
    console.warn('[Cloud] apiSavePrefs failed:', err)
    return false
  }
}

/** X3 偏好读取（weapp 走 chat 云函数 getPrefs）；从未上报/失败返回 null，由调用方保留本地值 */
export async function apiGetPrefs(): Promise<UserPrefs | null> {
  if (!isWeapp) return null
  try {
    const res = await callFunction<{ prefs?: UserPrefs | null }>('chat', { action: 'getPrefs' })
    return res && res.prefs ? res.prefs : null
  } catch (err) {
    console.warn('[Cloud] apiGetPrefs failed:', err)
    return null
  }
}

/** 类目偏好摘要（上云口径：只有类目名 + 分数，逐条原始行为记录不上云，服务端白名单会再清洗一次） */
export interface AffinitySyncItem {
  category: string
  score: number
}

/**
 * 类目偏好摘要上报（weapp 走 chat 云函数 saveAffinity）；H5 无云函数通道返回 false 不阻塞。
 * 与 apiSavePrefs 同一约定：任何失败都吞掉并返回 false，调用方无需 try/catch。
 */
export async function apiSaveAffinity(items: Array<AffinitySyncItem>): Promise<boolean> {
  if (!isWeapp) return false
  try {
    const res = await callFunction<{ saved?: boolean }>('chat', { action: 'saveAffinity', affinity: items })
    return !!(res && res.saved)
  } catch (err) {
    console.warn('[Cloud] apiSaveAffinity failed:', err)
    return false
  }
}

/** 类目偏好摘要读取（weapp 走 chat 云函数 getAffinity）；从未上报/失败返回 null，由调用方保留本地值 */
export async function apiGetAffinity(): Promise<Array<AffinitySyncItem> | null> {
  if (!isWeapp) return null
  try {
    const res = await callFunction<{ affinity?: Array<AffinitySyncItem> | null }>('chat', {
      action: 'getAffinity'
    })
    return res && Array.isArray(res.affinity) ? res.affinity : null
  } catch (err) {
    console.warn('[Cloud] apiGetAffinity failed:', err)
    return null
  }
}

export async function callFunction<T = unknown>(
  name: string,
  data?: Record<string, unknown>
): Promise<T> {
  if (!isWeapp) {
    // H5 预览：双端先用本地 mock（前端清 storage）
    if (name === 'getHotspot') {
      // 真实数据优先：同源聚合接口（本地预览）/ Pages 静态聚合（Actions 定时刷新），失败降级本地 mock
      const payload = await loadHotspotPayload()
      if (payload) {
        hotspotMeta = payload.updatedAt
          ? { updatedAt: payload.updatedAt, stale: payload.stale, sources: payload.sources }
          : null
        clearDegraded('getHotspot')
        return payload.items as T
      }
      hotspotMeta = null
      markDegraded('getHotspot')
      const mockModule = await import('../data/getHotspot')
      return mockModule.default() as T
    }
    if (name === 'getBriefing') {
      // 晨报：日程/待办照常本地数据；intel（天气+资讯）用真实数据补齐，失败不阻塞晨报（v1.3 原则）
      const mockModule = await import('../data/getBriefing')
      // P-01：mock 已带 priceAlerts；缺失时（如 mock 侧异常降级）按同一规则现算，保证字段不缺
      const briefing: Briefing & { priceAlerts?: PriceAlert[] } = mockModule.default()
      if (!Array.isArray(briefing.priceAlerts)) {
        briefing.priceAlerts = await loadMockPriceAlerts()
      }
      try {
        const city = String(Taro.getStorageSync('user-city') || '北京')
        const [hotspot, weather] = await Promise.all([loadHotspotPayload(), loadWeather(city)])
        // H5 本地兜底走的是与免费档同构的路径（RSS 原始条目、零 LLM），
        // 故 aiEnabled:false —— 不能让前端把它误显示成「AI 提炼暂不可用」。
        const intel: BriefingIntel = { subscribed: false, weather: null, intelItems: [], degraded: false, aiEnabled: false }
        if (weather) intel.weather = weather
        if (hotspot) {
          intel.intelItems = hotspot.items.slice(0, 3).map((it) => ({
            text: it.title,
            source: it.source
          }))
        }
        briefing.intel = intel
      } catch (err) {
        // 不静默失败（AGENTS.md:215）：原来这里只 console.warn 然后放行，
        // 结果 `briefing.intel` 保持 undefined —— 页面只知道「没数据」，
        // 分不清是「用户还没转发内容」还是「云端没接通」。二者对用户的下一步动作完全不同。
        // 记下 degraded:true，让晨报空态能如实说明原因（消费点：pages/briefing 的 EmptyState hint）。
        briefing.intel = { subscribed: false, weather: null, intelItems: [], degraded: true, aiEnabled: false }
        console.warn('[Cloud] briefing intel patch failed, mark degraded:', err)
      }
      return briefing as T
    }
    // AI 能力（chat / extract）：① cloud.llm 直连（2026-10-13 起 H5 生产可用的真 AI 路径）
    // → ② 本地 LLM 代理（开发态）→ ③ 本地规则 mock。
    // 2026-10-05 之前只有 ②③，而 ② 的代理只在开发机跑，线上必然落到 ③
    // —— 于是 H5 的"AI 对话"在生产环境其实一直是假规则。
    // ⚠️ 这里**直接落到 mock，不再 fallthrough 到下面的通用 rpc 分支**：
    //   chat/extract 是微信云函数，没有注册为应用数据库的 PG 函数，rpc 必败；
    //   老代码在这里 fallthrough，等于每个失败请求多打一发注定失败的 rpc（已修）。
    if (name === 'chat' || name === 'extract') {
      const ai = await callChatOrExtract<T>(name, data)
      if (ai) {
        clearDegraded(name)
        return ai
      }
      console.warn(`[Cloud] all AI paths unavailable, fallback to mock: ${name}`)
      markDegraded(name)
      const mockModule = await import(`../data/${name}`)
      return mockModule.default(data) as T
    }
    // 其余云函数（getLibrary / updateSettings / getUsage / shopping / confirmItem /
    // createOrder / deleteAccount …）：**先走云服务**，两端同一套实现；
    // 拿不到才降级本地 mock。src/data 下每个云函数都有同名模块，故回退路径不破。
    try {
      const viaCloud = (await invoke(name, data)) as T
      clearDegraded(name)
      return viaCloud
    } catch (err) {
      console.warn(`[Cloud] ${name} via cloud rpc failed, fallback to mock:`, err)
    }
    markDegraded(name)
    const mockModule = await import(`../data/${name}`)
    return mockModule.default(data) as T
  }
  if (name === 'getHotspot') {
    // 热点资讯：真机走 webSearch 云函数（RSS 聚合，强制标注来源），失败降级本地 mock
    try {
      const viaCloud = await callFunction<T>('webSearch', { action: 'hotspot' })
      clearDegraded('getHotspot')
      return viaCloud
    } catch (err) {
      console.warn('[Cloud] getHotspot via webSearch failed, fallback to mock:', err)
      markDegraded('getHotspot')
      const mockModule = await import('../data/getHotspot')
      return mockModule.default() as T
    }
  }
  const result = (await invoke(name, data)) as Record<string, unknown> | null
  // 返回协议兼容：webSearch/shopping/deleteAccount 全包 { code, message, data }；
  // login/extract/getBriefing/chat/getUsage 等为裸业务体——统一归一后再校验
  if (result && typeof result === 'object' && 'code' in result) {
    if (result.code !== 0) {
      console.error(`[Cloud] ${name} failed:`, result.message)
      throw new Error(String(result.message || '请求失败'))
    }
    return result.data as T
  }
  return result as T
}

/** 资讯 AI 精选（手动触发）。
 *
 *  2026-10-05 重写：原先 weapp 直接 return null、H5 打同源 `/api/news/ai-filter`，
 *  而生产环境只静态托管 dist/，该路径恒 404 —— **这个功能从未在线上工作过**。
 *  现在两端统一走 webSearch 云函数的 `action=aiFilter`（纯内容转换，不碰用户数据）。
 *
 *  分工：云函数只负责「LLM 挑选」（返回 picks 编号 + 理由）；**候选映射与同类目去重留在前端**
 *  —— ① 数据本来就在这里（items 是页面当前可见列表，可能已按偏好排序）；
 *  ② 云函数无状态，进程内缓存不可靠，不适合承担 2h 单槽缓存。
 *
 *  仍保留 `/api/news/ai-filter` 作为本地 static-server 预览时的兜底。
 */
const AI_FILTER_CANDIDATE_MAX = 110; // 与 static-server.js 的候选上限同口径
const AI_FILTER_MAX = 10; // 展示条数上限（AI_PICK_MAX）
const AI_FILTER_PER_CATEGORY_MAX = 2; // 同类目硬上限（AI_PICK_PER_CATEGORY_MAX）

export async function apiAiNewsFilter(
  items: HotspotNews[],
  interests: string[],
  custom: string,
  signals: string[]
): Promise<{ items: HotspotNews[]; summary: string } | null> {
  if (!items.length) return null;
  // 候选串带上 [来源·类目]：类目由数据自己带（tags），而不是把「哪个源属于哪个类目」
  // 硬编码进上游提示词 —— 那样一改源清单就失真。
  const pool = items.slice(0, AI_FILTER_CANDIDATE_MAX);
  const candidates = pool.map((it, i) => {
    const tags = Array.isArray(it.tags) && it.tags.length ? '·' + it.tags.join('/') : '';
    return `${i + 1}. [${it.source}${tags}] ${it.title}`;
  });
  try {
    const res = (await invoke('webSearch', {
      action: 'aiFilter',
      interests,
      custom,
      signals,
      candidates
    })) as {
      code?: number;
      message?: string;
      data?: { picks?: Array<{ n?: number; reason?: string; why?: string }>; summary?: string } | null;
    } | null;
    if (!res || res.code !== 0 || !res.data) throw new Error((res && res.message) || 'aiFilter failed');
    const picks = Array.isArray(res.data.picks) ? res.data.picks : [];
    // 确定性多样性兜底：按模型给的相关度顺序贪心取，同类目超上限则跳过。
    // 提示词不可靠（实测教育曾占 4/10），这里才是唯一能保证结果的地方。
    const perCat = new Map<string, number>();
    const out: HotspotNews[] = [];
    for (const p of picks) {
      const it = pool[Number(p.n) - 1];
      if (!it) continue;
      const cat = categoryOf(it.tags);
      const used = perCat.get(cat) || 0;
      if (used >= AI_FILTER_PER_CATEGORY_MAX || out.length >= AI_FILTER_MAX) continue;
      perCat.set(cat, used + 1);
      const why = typeof p.why === 'string' ? p.why.trim() : '';
      out.push({ ...it, aiReason: String(p.reason || ''), ...(why ? { whyItMatters: why } : {}) });
    }
    if (!out.length) return null;
    return { items: out, summary: String(res.data.summary || '') };
  } catch (err) {
    // 云函数未部署 / 未注册为 RPC 时，退回本地 static-server 预览路径
    console.warn('[Cloud] aiFilter via cloud function failed, try local endpoint:', err);
  }
  if (isWeapp) return null; // 小程序没有同源 /api
  try {
    const res = await fetch('/api/news/ai-filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interests, custom, signals })
    });
    if (!res.ok) return null;
    const payload = await res.json();
    if (!payload || !Array.isArray(payload.items)) return null;
    return { items: payload.items as HotspotNews[], summary: String(payload.summary || '') };
  } catch (err) {
    console.warn('[Cloud] aiNewsFilter local endpoint failed:', err);
    return null;
  }
}
