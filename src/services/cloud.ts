import Taro from '@tarojs/taro'
import type { Briefing, BriefingIntel, HotspotNews } from '../types'
import type { UserPrefs } from '../utils/prefs'
import { fetchWeatherDirect } from '../utils/weather'
import { evaluatePriceAlerts, type PricedItem, type PriceAlert } from '../utils/price'
import { categoryOf } from '../utils/categoryLabel'
import { invoke, isWeapp } from './dataSource'

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

/** H5 真实 AI：转发到本地 llm-proxy（8138）。chat → POST /，extract → POST /extract；失败返回 null 由调用方降级 */
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

/** 流式 chat 结果（F-03）：与 apiChat 最小公共字段对齐 */
export interface ChatStreamResult {
  reply: string
  action: string
}

/**
 * H5 AI 流式对话（F-03）：POST llm-proxy /stream（NDJSON 增量行），
 * onDelta 逐段回调 reply 文本（打字机追加），末行 done 给最终 reply/action 校正。
 * 仅 H5 生效（weapp 云函数非流式维持整段）；任何失败返回 null，由调用方降级 apiChat 整段。
 */
export async function chatLocalStream(
  message: string,
  deep: boolean,
  onDelta: (chunk: string) => void,
  memories?: string[]
): Promise<ChatStreamResult | null> {
  if (isWeapp) return null
  try {
    const res = await fetch(`${LLM_PROXY_BASE}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, deep, memories })
    })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let result: ChatStreamResult | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parsed = JSON.parse(trimmed) as { t?: string; done?: boolean; reply?: string; action?: string }
        if (parsed.done) {
          result = { reply: parsed.reply || '', action: parsed.action || 'chat' }
        } else if (parsed.t) {
          onDelta(parsed.t)
        }
      }
    }
    return result
  } catch (err) {
    console.warn('[Cloud] chat stream failed:', err)
    return null
  }
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
        return payload.items as T
      }
      hotspotMeta = null
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
        console.warn('[Cloud] briefing intel patch failed, keep mock:', err)
      }
      return briefing as T
    }
    // AI 能力：① 云函数（与小程序同一套实现）→ ② 本地 LLM 代理（开发态）
    // → ③ 本地规则 mock。2026-10-05 之前只有 ②③，而 ② 的代理只在开发机跑，
    // 线上必然落到 ③ —— 于是 H5 的"AI 对话"在生产环境其实一直是假规则。
    if (name === 'chat' || name === 'extract') {
      try {
        return (await invoke(name, data)) as T
      } catch (err) {
        console.warn(`[Cloud] ${name} via cloud rpc failed, try local proxy:`, err)
      }
      const ai = await callLocalAI<T>(name, data)
      if (ai) return ai
      console.warn(`[Cloud] local AI proxy unavailable, fallback to mock: ${name}`)
    }
    // 其余云函数（getLibrary / updateSettings / getUsage / shopping / confirmItem /
    // createOrder / deleteAccount …）：**先走云服务**，两端同一套实现；
    // 拿不到才降级本地 mock。src/data 下每个云函数都有同名模块，故回退路径不破。
    try {
      return (await invoke(name, data)) as T
    } catch (err) {
      console.warn(`[Cloud] ${name} via cloud rpc failed, fallback to mock:`, err)
    }
    const mockModule = await import(`../data/${name}`)
    return mockModule.default(data) as T
  }
  if (name === 'getHotspot') {
    // 热点资讯：真机走 webSearch 云函数（RSS 聚合，强制标注来源），失败降级本地 mock
    try {
      return await callFunction<T>('webSearch', { action: 'hotspot' })
    } catch (err) {
      console.warn('[Cloud] getHotspot via webSearch failed, fallback to mock:', err)
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
