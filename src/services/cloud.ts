import Taro from '@tarojs/taro'
import { fetchWeatherDirect } from '../utils/weather'

const isWeapp = process.env.TARO_ENV === 'weapp'

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

/** H5 热点数据源（真实数据分层）：① 同源 /api/hotspot（本地预览聚合接口）
 *  ② Pages 静态 api/hotspot.json（GitHub Actions 每 30 分钟抓 RSS 刷新，相对路径兼容 /9-8/ 子路径）
 *  ③ 全部失败返回 null，调用方自行 mock 兜底 */
async function loadHotspotPayload(): Promise<{ items: any[]; updatedAt: string | null; stale: boolean; sources: any[] } | null> {
  for (const url of ['/api/hotspot', './api/hotspot.json']) {
    try {
      const res = await fetch(url)
      const payload = await res.json()
      if (Array.isArray(payload.items) && payload.items.length > 0) {
        return {
          items: payload.items,
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
async function callLocalAI<T>(name: string, data?: Record<string, any>): Promise<T | null> {
  try {
    const isExtract = name === 'extract'
    const url = isExtract ? `${LLM_PROXY_BASE}/extract` : `${LLM_PROXY_BASE}/`
    const body = isExtract
      ? { content: data?.content, images: data?.images }
      : { message: data?.message, deep: data?.deep, mode: data?.mode, workAction: data?.workAction }
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

export async function callFunction<T = any>(
  name: string,
  data?: Record<string, any>
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
      const briefing: any = mockModule.default()
      try {
        const city = String(Taro.getStorageSync('user-city') || '北京')
        const [hotspot, weather] = await Promise.all([loadHotspotPayload(), loadWeather(city)])
        const intel: any = { subscribed: false, weather: null, intelItems: [], degraded: true }
        if (weather) intel.weather = weather
        if (hotspot) {
          intel.intelItems = hotspot.items.slice(0, 3).map((it: any) => ({
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
    // AI 能力接真 DeepSeek：本地 LLM 代理（node .tools/llm-proxy.js，端口 8138，
    // key 只存在本地服务端不进前端产物）；代理未启动时降级本地规则 mock
    if (name === 'chat' || name === 'extract') {
      const ai = await callLocalAI<T>(name, data)
      if (ai) return ai
      console.warn(`[Cloud] local AI proxy unavailable, fallback to mock: ${name}`)
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
  const res = await Taro.cloud.callFunction({ name, data })
  const result = res.result as any
  // 返回协议兼容：webSearch/shopping/deleteAccount 全包 { code, message, data }；
  // login/extract/getBriefing/chat/getUsage 等为裸业务体——统一归一后再校验
  if (result && typeof result === 'object' && 'code' in result) {
    if (result.code !== 0) {
      console.error(`[Cloud] ${name} failed:`, result.message)
      throw new Error(result.message || '请求失败')
    }
    return result.data as T
  }
  return result as T
}

/** 资讯 AI 精选（手动触发；H5 同源 /api/news/ai-filter → DeepSeek 筛选，2h 缓存）
 *  weapp 或接口失败返回 null，调用方自行提示兜底；不阻塞原始资讯列表 */
export async function apiAiNewsFilter(
  interests: string[],
  custom: string,
  signals: string[]
): Promise<{ items: import('../types').HotspotNews[]; summary: string } | null> {
  if (!isWeapp) {
    try {
      const res = await fetch('/api/news/ai-filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interests, custom, signals })
      })
      if (!res.ok) return null
      const payload = await res.json()
      if (!payload || !Array.isArray(payload.items)) return null
      return { items: payload.items as import('../types').HotspotNews[], summary: String(payload.summary || '') }
    } catch (err) {
      console.warn('[Cloud] aiNewsFilter failed:', err)
      return null
    }
  }
  return null
}
