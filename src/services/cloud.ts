import Taro from '@tarojs/taro'
import type { Briefing, BriefingIntel, HotspotNews } from '../types'
import type { UserPrefs } from '../utils/prefs'
import { fetchWeatherDirect } from '../utils/weather'
import { evaluatePriceAlerts, type PricedItem, type PriceAlert } from '../utils/price'
import { categoryOf } from '../utils/categoryLabel'
import { selectByPreference } from '../utils/prefSelect'
import { readProfileSettings } from './localProfile'
import { invoke, isWeapp } from './dataSource'
import { chatViaCloudLlm, extractViaCloudLlm, typewriter, cloudLlmChat } from './cloudLlm'
import { recordUsage } from '../utils/usageLog'

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
 *  H5 端多数云函数**没有可用的 RPC 通道**（services/dataSource.ts 的 RPC_ALLOWLIST
 *  **当前为空** —— 应用数据库里没有任何面向客户端的 PG 函数），拿不到就走 src/data/* 的
 *  本地实现；chat/extract 的本地 LLM 代理也只在本机开发时存在。此前这一步是**静默**的：
 *  用户看到的是本地/演示数据，却以为来自云端。
 *
 *  ⚠️ 2026-10-31 修正本注释的过时事实：原文写「RPC_ALLOWLIST 只放行 webSearch / chat / extract」——
 *    `webSearch` 已于 2026-10-30 摘除，`chat` / `extract` 也于 2026-10-31 摘除
 *    （线上探针：public.chat / public.extract 均 PGRST202「不存在」）。
 *    注释不是事实，探针才是 —— 写在这里免得下一个人又照着旧注释去加名字。
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

/** 同源烘焙副本（发布时由 .tools/copy-assets.js 从 gh-pages 落盘）。
 *  2026-10-30 新增到优先级第一位：它是**同源**请求 —— 无跨域 DNS/TLS、无 CORS 预检，
 *  且线上实测它与 gh-pages 那份**内容完全相同**（copy-assets 就是从 gh-pages 拉的）。
 *  实测原先的第一优先项 `/api/hotspot`（目录形态）在 WorkBuddy 部署下**必然 404** ——
 *  每个用户都要白付一次 404 往返。 */
const SAME_ORIGIN_HOTSPOT_URL = './api/hotspot.json'
/** 带后端部署（本地预览 / 自托管 static-server）时的实时接口 */
const LOCAL_API_HOTSPOT_URL = '/api/hotspot'

/** 同源烘焙副本「算新鲜」的阈值：CI 每 30 分钟刷一次 gh-pages，
 *  取 35 分钟（略大于刷新周期）—— 落在窗口内就不必再问远端，省一次跨域往返。 */
const HOTSPOT_FRESH_MS = 35 * 60 * 1000
/** 内存缓存有效期（ms）：同一会话内跨页（热点页 / 晨报页）不重复下载几百 KB 的 JSON。
 *  取 5 分钟：远端数据本身是 30 分钟粒度的静态快照，5 分钟足够新。 */
const HOTSPOT_CACHE_MS = 5 * 60 * 1000

/** 热点数据载荷（items + videos + 元信息） */
export interface HotspotPayload {
  items: HotspotNews[]
  /** 视频条目（2026-10-30 新增）：由 .tools/fetch-data.js 从 B站热榜产出，
   *  与 items 同一个 JSON、同一次请求 —— 不新增任何网络请求。 */
  videos: HotspotNews[]
  updatedAt: string | null
  stale: boolean
  sources: { name: string; count: number; ok: boolean }[]
}

/** 内存缓存 + in-flight 去重：并发调用共用同一个请求；完成后按 TTL 复用。 */
let hotspotCache: { at: number; payload: HotspotPayload | null } | null = null
let hotspotInFlight: Promise<HotspotPayload | null> | null = null

/** 取热点载荷（带缓存与 in-flight 去重）。**并发调用只发一轮请求。 */
export function getHotspotPayload(): Promise<HotspotPayload | null> {
  if (hotspotCache && Date.now() - hotspotCache.at < HOTSPOT_CACHE_MS) {
    return Promise.resolve(hotspotCache.payload)
  }
  if (!hotspotInFlight) {
    hotspotInFlight = loadHotspotPayload().then(
      (payload) => {
        hotspotCache = { at: Date.now(), payload }
        hotspotInFlight = null
        return payload
      },
      (err) => {
        hotspotInFlight = null
        throw err
      }
    )
  }
  return hotspotInFlight
}

/** 已加载热点载荷里的视频条目（H5 端「视频精选 / 视频资讯」的唯一数据源）。
 *  没加载过热点数据时返回空数组 —— 调用方按空数组隐藏板块（既有约定）。 */
export function getHotspotVideos(): HotspotNews[] {
  return (hotspotCache && hotspotCache.payload && hotspotCache.payload.videos) || []
}

/** 拉一份热点 JSON 并归一。失败/结构不对返回 null（调用方换下一个源）。 */
async function fetchHotspotJson(url: string): Promise<HotspotPayload | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const payload = await res.json()
    if (!Array.isArray(payload.items) || payload.items.length === 0) return null
    // 信任边界：服务端聚合 JSON 未逐字段校验，在此收口为 HotspotNews。
    // ⚠️ 必须逐条归一 tags/summary（2026-10-24 审计）：资讯库页直接
    // `item.tags.some(...)` / `item.tags.forEach(...)`，任一条目缺 tags 就是
    // TypeError 整页白屏。一个 as 断言挡不住运行时的脏数据 —— 在数据入口
    // 一处收口，而不是每个使用点各自防御（AGENTS.md 铁律）。
    const norm = (list: unknown): HotspotNews[] =>
      (Array.isArray(list) ? list : []).map((it) => {
        const o = (it || {}) as Partial<HotspotNews>
        return {
          ...o,
          tags: Array.isArray(o.tags) ? o.tags : [],
          summary: typeof o.summary === 'string' ? o.summary : ''
        }
      }) as HotspotNews[]
    return {
      items: norm(payload.items),
      videos: norm(payload.videos),
      updatedAt: payload.updatedAt || null,
      stale: !!payload.stale,
      sources: payload.sources || []
    }
  } catch {
    return null
  }
}

/** H5 热点数据源（真实数据分层，顺序即优先级）：
 *  ① 同源 ./api/hotspot.json（发布时烘焙；无跨域成本；够新鲜时直接用它）
 *  ② 线上实时 JSON（每 30 分钟刷新；① 不够新鲜或取不到时才问它）
 *  ③ 同源 /api/hotspot（带后端部署的本地预览 / 自托管）
 *  ④ 全部失败返回 null，调用方自行 mock 兜底
 *
 * 2026-10-30 改动：原先顺序是「/api/hotspot → 线上实时 → 同源烘焙」，
 * 在 WorkBuddy 部署下第一跳必然 404（目录路由不存在）⇒ 每次进页面白付一次 404 往返，
 * 而**同源那份（其实与远端内容相同）永远用不上**。现在同源优先。
 *
 * ⚠️ 首屏预算：这条链路只允许**不增加**请求数。当前常态是 1 个请求（同源），
 * 只有烘焙副本过期（发布后未再构建）才付第 2 个（远端跨域）。 */
async function loadHotspotPayload(): Promise<HotspotPayload | null> {
  const same = await fetchHotspotJson(SAME_ORIGIN_HOTSPOT_URL)
  if (same) {
    const ts = same.updatedAt ? Date.parse(same.updatedAt) : NaN
    if (!Number.isFinite(ts) || Date.now() - ts < HOTSPOT_FRESH_MS) {
      // 同源这份够新鲜（或没有时间戳可判）⇒ 不用再问远端
      return same
    }
  }
  const live = await fetchHotspotJson(LIVE_HOTSPOT_URL)
  if (live) {
    // 两份都有时间戳时取新的；同源无时间戳但内容可用时，优先同源（省跨域依赖）
    if (!same || !same.updatedAt || !live.updatedAt) return live.updatedAt ? live : same
    return Date.parse(live.updatedAt) > Date.parse(same.updatedAt) ? live : same
  }
  if (same) return same
  return fetchHotspotJson(LOCAL_API_HOTSPOT_URL)
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
  /** 排班提案原始条目（action='plan' 时由 chatViaCloudLlm 解析出；此前流式路径整个丢弃，
   *  H5 用户问「帮我把周会挪到周四」永远看不到方案卡片，只能自己再发一句话） */
  proposals?: unknown[]
  /** 模型要求写入的长期记忆条目（M-03；此前流式路径丢弃，H5 上记忆永不落库） */
  memories?: string[]
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
/** 流式对话的过程钩子（可选，调用方不传则无过程反馈）。 */
export interface ChatStreamHooks {
  /** 云端流开始前调用（此时气泡已挂出）——用于把空气泡置为「正在思考…」占位 */
  onThinking?: () => void;
  /** 云端流成功返回、打字机开始前调用——清掉思考态占位文本 */
  onClear?: () => void;
}

export async function chatCloudStream(
  message: string,
  deep: boolean,
  onDelta: (chunk: string) => void,
  memories?: string[],
  hooks?: ChatStreamHooks
): Promise<ChatStreamResult | null> {
  if (isWeapp) return null
  // hy4-preview 是推理模型：reasoning 阶段实测可达 ~20s（2026-10-20），期间
  // content 为空、气泡毫无变化 —— 用户视角像卡死。先用占位文本明确告知
  // 「在思考」，流回来再清空走打字机（动效不脏）。
  if (hooks && hooks.onThinking) hooks.onThinking()
  const res = await chatViaCloudLlm({ message, deep, memories })
  if (!res) return null
  // 流式对话是**另一条真实路径**（AiAssistant 走它，不走 callFunction('chat')），
  // 所以这里也要记一次；两处不会同一次调用都命中（成功即 return）。
  recordUsage('chat')
  if (hooks && hooks.onClear) hooks.onClear()
  await typewriter(res.reply, onDelta)
  // proposals/memories 一并透传：调用方（AiAssistant 流式分支）要靠它们
  // 与非流式降级路径汇合（方案卡片 + 记忆写入），此前只回 {reply, action} 等于丢弃。
  return { reply: res.reply, action: res.action, proposals: res.proposals, memories: res.memories }
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
 *  线上必然落到 ③ —— 于是 H5 的"AI 对话"在生产环境其实一直是假规则。
 *
 *  ⚠️ 2026-10-15 修：`extract` 原先和 chat 一样会落到 ③（mock）—— 因为这里只对
 *  name==='chat' 走云端，extract 被直接送去 callLocalAI 打 localhost:8138（线上不可达）。
 *  后果是收件箱「AI 提取」在生产环境**恒返回 src/data/extract.ts 的固定示例**
 *  （「产品评审会 / 评审前更新演示文稿」），用户看到"提取成功"却是假数据。
 *  这正是 2026-10-14 测试报告 P1-02 怀疑的形态，已在代码层坐实。 */
async function callChatOrExtract<T>(name: string, data?: Record<string, unknown>): Promise<T | null> {
  if (name === 'chat') {
    const viaCloud = await chatViaCloudLlm(data)
    if (viaCloud) return viaCloud as T
    console.warn('[Cloud] chat via cloud.llm unavailable, try local proxy')
  } else if (name === 'extract') {
    const viaCloud = await extractViaCloudLlm(data as { content?: string; images?: string[] })
    if (viaCloud) return viaCloud as T
    // 走到这里的两种情况：① 云端真的不可用 ② 只有截图、无文字（该通道无多模态）。
    // 两者都还有本地 mock 兜底（mock 至少能从截图旁的文字里认时间），故继续往下走。
    console.warn('[Cloud] extract via cloud.llm unavailable, try local proxy')
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
      const payload = await getHotspotPayload()
      if (payload) {
        hotspotMeta = payload.updatedAt
          ? { updatedAt: payload.updatedAt, stale: payload.stale, sources: payload.sources }
          : null
        clearDegraded('getHotspot')
        // 2026-10-23：按用户偏好重排（云函数 selectForUser 的客户端镜像），
        // 不改条数、不截断 —— 只让用户选了「科学/文化/健康」时这些条目排前面。
        // 不这样做，H5 上这两个偏好标签就是"能点但没有任何效果"。
        const prefs = readProfileSettings().preferences
        return selectByPreference(payload.items, prefs, payload.items.length) as T
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
        const [hotspot, weather] = await Promise.all([getHotspotPayload(), loadWeather(city)])
        // H5 本地兜底走的是与免费档同构的路径（RSS 原始条目、零 LLM），
        // 故 aiEnabled:false —— 不能让前端把它误显示成「AI 提炼暂不可用」。
        const intel: BriefingIntel = { subscribed: false, weather: null, intelItems: [], degraded: false, aiEnabled: false }
        if (weather) intel.weather = weather
        if (hotspot) {
          // 2026-10-23：原先是 `hotspot.items.slice(0, 3)` —— 硬切前 3 条，
          // 用户在「我的」里选的科学/文化/健康偏好**完全不参与**。
          // 改用与云函数 selectForUser 同算法的客户端选位（src/utils/prefSelect.ts）。
          const prefs = readProfileSettings().preferences
          const picked = selectByPreference(hotspot.items, prefs, 3)
          // 2026-10-24 补 url/image：原映射只留 {text,source}，与云端 fallback 路径
          // （briefing/index.tsx:1459 注释：实际带 image/url）不一致 —— 后果是
          // H5 兜底态条目不可点开原文、不可分享、无缩略图，2026-10-22 的
          // 卡片化/分享增量在兜底态全部失效。字段可选，缺失时组件自动降级。
          //
          // 2026-10-26 补 createTime：热点契约的 RSS 条目由 fetch-data.js 从 pubDate 转出，
          // 原样透传给晨报 intelItems，突发识别的 24h 时效闸才有真实时间可用（此前恒缺 → 空转）。
          // 只透传可解析的 ISO 串；缺失/非法不补当前时间（不伪造，消费侧保守放行）。
          intel.intelItems = picked.map((it) => {
            const createTime =
              typeof it.createTime === 'string' && Number.isFinite(Date.parse(it.createTime))
                ? it.createTime
                : undefined
            return {
              text: it.title,
              source: it.source,
              url: it.url,
              image: it.image,
              ...(createTime ? { createTime } : {})
            }
          })
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
        // 功能记账（2026-10-24）：**只在这一支记**。下面的 mock 分支是 src/data 里的
        // 示例数据，不是一次真实调用 —— 在那里记账等于虚报用户用量（诚实性铁律）。
        recordUsage(name === 'chat' ? 'chat' : 'extract')
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

/** AI 精选的系统提示 —— **必须与 webSearch 云函数 `action=aiFilter` 的 systemContent 逐字一致**。
 *
 *  2026-10-30：H5 端改走 cloud.llm 直连（下面 AI_FILTER_SYSTEM_PROMPT 的说明）。
 *  两端各有一份提示词（云函数那一份在 cloudfunctions/webSearch/index.js）——
 *  云函数目录会**独立打包部署**（只含自身目录），src/ 也从不跨目录 import（仓库无此先例），
 *  所以这里**不能**共用一个模块。改口径时必须**同时改两处**，
 *  `.tools/verify-live-bridge.mjs` 有一条断言强制两者逐字一致（改一处不改另一处会被门禁抓住）。
 */
const AI_FILTER_SYSTEM_PROMPT =
  '你是新闻筛选助手。根据用户兴趣画像，从候选新闻中挑出最值得看的条目，按相关度从高到低排序，最多输出 20 条。' +
  '规则：1) 只挑与兴趣相关或与近期关注相近的条目；若整体相关度都低，也要挑出相对最相关的 6 条；' +
  '2) 合规降权（优先级最高，覆盖第1条）：时政/外交/军事/突发事件监管类内容不得入选 picks；财经类最多 1 条；优先科技/数字生活/健康/教育等生活建设性议题；' +
  '3) 类目多样性（优先级仅次于合规）：候选条目格式为「编号. [来源·类目] 标题」，请据此判断每条的类目；' +
  '同一类目最多给 2 条；请把不同类目的条目都排进这 20 条里 —— 给出 20 条是为了让下游按类目去重后仍能凑满 10 条，' +
  '所以同类目的备用条目请排在后面，不要用同一类目占满靠前的位置；' +
  '4) reason 用不超过16字说明「为什么推荐给这位用户」，不要复述标题；' +
  '5) 对每个选中条目额外输出 why 字段：不超过30字的中文，回答「为什么这条值得**这个用户**看」，必须结合其 interests/custom 画像给出个人化理由（不是通用新闻价值）；' +
  '6) summary 以早报员「小晨」的口吻写（克制友好、少废话），不超过20字；' +
  '7) 严格返回 JSON：{"picks":[{"n":编号数字,"reason":"理由","why":"个人化理由(30字内)"}],"summary":"一句话概括筛选依据(20字内)"}，不要输出任何其他内容；why 缺失时允许为空字符串，但字段必须存在。'

/** 解析 LLM 返回的 JSON（容忍 ```json 包裹与前后杂字）。
 *  与云函数 safeParse 同口径：**解析失败就当没有结果**，不猜、不用正则抠碎片。 */
function parseAiFilterPayload(raw: string): { picks?: Array<{ n?: number; reason?: string; why?: string }>; summary?: string } | null {
  if (!raw) return null;
  let s = String(raw).trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

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

  // ── H5：走 cloud.llm 直连（2026-10-30）────────────────────────────────
  // 原先 H5 也调 webSearch 云函数的 aiFilter 动作，而应用数据库里**没有**
  // `webSearch` 这个 PG 函数（线上实测 404 PGRST202）⇒ 必然失败；退到 `/api/news/ai-filter`
  // 那条本地 static-server 路径，而线上是纯静态托管 ⇒ 恒 404。
  // ⇒ 「✨ 生成 AI 精选」在 H5 上**从来没有成功过**。
  // 现在 H5 改走 cloud.llm（H5 的 AI 对话/AI 提取已在用的真 AI 通道），提示词与云函数一致。
  if (!isWeapp) {
    const userContent =
      `兴趣标签：${interests.length ? interests.join('、') : '（未设置）'}\n` +
      `自定义关注：${custom || '（无）'}\n` +
      `近期关注（参考）：${signals.length ? signals.join(' / ').slice(0, 120) : '（无）'}\n\n` +
      `候选新闻：\n${candidates.join('\n')}`;
    try {
      const raw = await cloudLlmChat({ system: AI_FILTER_SYSTEM_PROMPT, userContent });
      const data = raw ? parseAiFilterPayload(raw) : null;
      if (!data) throw new Error('aiFilter: LLM 返回无法解析');
      const picked = pickAiFilterItems(pool, data.picks);
      if (picked.length) return { items: picked, summary: String(data.summary || '') };
      throw new Error('aiFilter: 挑不出条目');
    } catch (err) {
      console.warn('[Cloud] aiFilter via cloud.llm failed, try local endpoint:', err);
    }
    // 最后兜底：本地 static-server 预览路径（开发态）。生产环境纯静态托管 ⇒ 该路由不存在 ⇒ 404 ⇒ null。
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
    const picked = pickAiFilterItems(pool, res.data.picks);
    if (!picked.length) return null;
    return { items: picked, summary: String(res.data.summary || '') };
  } catch (err) {
    console.warn('[Cloud] aiFilter via cloud function failed:', err);
    return null;
  }
}

/** 候选 → 展示条数：按模型给的相关度顺序贪心取，同类目超上限则跳过。
 *  确定性多样性兜底：提示词不可靠（实测教育曾占 4/10），这里才是唯一能保证结果的地方。 */
function pickAiFilterItems(
  pool: HotspotNews[],
  picks: Array<{ n?: number; reason?: string; why?: string }> | undefined
): HotspotNews[] {
  const list = Array.isArray(picks) ? picks : [];
  const perCat = new Map<string, number>();
  const out: HotspotNews[] = [];
  for (const p of list) {
    const it = pool[Number(p.n) - 1];
    if (!it) continue;
    const cat = categoryOf(it.tags);
    const used = perCat.get(cat) || 0;
    if (used >= AI_FILTER_PER_CATEGORY_MAX || out.length >= AI_FILTER_MAX) continue;
    perCat.set(cat, used + 1);
    const why = typeof p.why === 'string' ? p.why.trim() : '';
    out.push({ ...it, aiReason: String(p.reason || ''), ...(why ? { whyItMatters: why } : {}) });
  }
  return out;
}
