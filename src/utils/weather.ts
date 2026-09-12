/**
 * Open-Meteo 天气直连（H5 线上无 /api/briefing 同源接口时的真实数据源）
 * 免 key、支持浏览器 CORS；与云函数 webSearch 的和风天气语义一致（text/updateTime）
 */

const FETCH_TIMEOUT = 8000;

function fetchJson(url: string): Promise<any> {
  return Promise.race([
    fetch(url).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), FETCH_TIMEOUT))
  ]);
}

/** WMO 天气码 → 中文（与 static-server.js 同表） */
const WMO_TEXT: Record<number, string> = {
  0: '晴', 1: '多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹'
};

export interface WeatherNow {
  text: string;
  updateTime: string;
}

/** 城市名 → 现况天气；失败返回 null（调用方保持降级，不阻塞晨报） */
export async function fetchWeatherDirect(city: string): Promise<WeatherNow | null> {
  try {
    const geo = await fetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`
    );
    const loc = (geo.results || [])[0];
    if (!loc) return null;

    const fc = await fetchJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
        '&current_weather=true&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=1'
    );
    const cw = fc.current_weather;
    if (!cw) return null;

    const daily = fc.daily || {};
    const desc = WMO_TEXT[cw.weathercode] || '多云';
    const min = daily.temperature_2m_min ? Math.round(daily.temperature_2m_min[0]) : '?';
    const max = daily.temperature_2m_max ? Math.round(daily.temperature_2m_max[0]) : '?';
    return {
      text: `${loc.name} ${desc}，当前 ${Math.round(cw.temperature)}°C，今日 ${min}~${max}°C`,
      updateTime: new Date().toISOString()
    };
  } catch (err) {
    console.warn('[weather] direct fetch failed:', err);
    return null;
  }
}
