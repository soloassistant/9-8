import Taro from '@tarojs/taro'
import { ensurePermission } from '@/utils/permission'

/**
 * 用户授权定位（H5: 浏览器 geolocation；weapp: wx.getLocation，需 app.config permission 声明）
 * → BigDataCloud 免费端点逆地理编码（无需 key，支持 CORS）取城市名
 * → 存 storage('user-city')，cloud.ts getBriefing 自动用新城市拉天气
 * 合规：坐标仅在本地换取城市名，不落库不上传；拒绝授权/失败返回 null，不阻塞晨报
 *
 * C-02：本函数是唯一的真实定位调用点，因此在此加「权限闸门」——
 * 未取得位置授权（本地未同意 或 系统侧已拒绝）直接返回 null，
 * 绝不发起 Taro.getLocation，避免绕过应用内授权弹窗。
 * 调用方（晨报页）负责功能触发式弹窗与「去设置」引导，本函数不弹任何 UI。
 */
export async function locateCity(): Promise<string | null> {
  try {
    // 权限闸门：已同意则直接通过（weapp 顺带与系统授权对账）；未同意 / 已达拒绝上限 → 返回 null
    const granted = await ensurePermission('location')
    if (!granted) {
      console.warn('[Location] 位置权限未授权，已跳过定位（不发起 getLocation）')
      return null
    }
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

