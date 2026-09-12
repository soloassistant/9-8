import Taro from '@tarojs/taro'

/**
 * 用户授权定位（H5: 浏览器 geolocation；weapp: wx.getLocation，需 app.config permission 声明）
 * → BigDataCloud 免费端点逆地理编码（无需 key，支持 CORS）取城市名
 * → 存 storage('user-city')，cloud.ts getBriefing 自动用新城市拉天气
 * 合规：坐标仅在本地换取城市名，不落库不上传；拒绝授权/失败返回 null，不阻塞晨报
 */
export async function locateCity(): Promise<string | null> {
  try {
    const pos = await Taro.getLocation({ type: 'wgs84' })
    const { latitude, longitude } = pos
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=zh`
    )
    if (!res.ok) return null
    const data = await res.json()
    const city = String(data.city || data.locality || data.principalSubdivision || '').trim()
    if (!city) return null
    Taro.setStorageSync('user-city', city)
    return city
  } catch (err) {
    console.warn('[Location] locateCity failed:', err)
    return null
  }
}

export function getCurrentCity(): string {
  return String(Taro.getStorageSync('user-city') || '北京')
}
