import Taro from '@tarojs/taro'
import { ensurePermission } from '@/utils/permission'
import { dict, useLanguageStore } from '@/store/language'

/* ---------------- 坐标出境单独同意（PIPL 第 39 条） ---------------- */

/** 出境同意的 storage key：与「位置权限」分开记 —— 撤回权限 ≠ 撤回出境同意，反之亦然 */
export const CROSS_BORDER_CONSENT_KEY = 'location-cross-border-consent'

/** 同意版本：披露对象 / 用途变化时递增，旧同意自动失效（重新征求） */
const CROSS_BORDER_CONSENT_VERSION = 'v1-20261024'

/** 取当前语言下的弹窗文案（服务层无 React 上下文，与 utils/tts.ts 同一取法） */
function t(key: 'perm.locCrossTitle' | 'perm.locCrossBody' | 'perm.locCrossAgree' | 'perm.locCrossDecline'): string {
  try {
    const lang = useLanguageStore.getState().lang
    return dict[lang][key] ?? dict.zh[key] ?? ''
  } catch {
    return ''
  }
}

/** 是否已就「坐标发送至境外地图服务」单独同意过 */
export function hasCrossBorderConsent(): boolean {
  try {
    const rec = Taro.getStorageSync(CROSS_BORDER_CONSENT_KEY) as { agreed?: boolean; version?: string } | ''
    return !!(rec && rec.agreed === true && rec.version === CROSS_BORDER_CONSENT_VERSION)
  } catch {
    return false
  }
}

/**
 * 出境单独同意闸门：**未取得同意就不发起定位**。
 *
 * 为什么单列一个弹窗（2026-10-24 法务一致性核对）：原来只有权限用途说明弹窗，而
 * 「坐标发往澳大利亚 BigDataCloud」属《个人信息保护法》第 39 条的**单独同意**事项 ——
 * 权限用途告知 ≠ 出境同意。弹窗拉不起来（低版本内核 / 弹窗冲突）时按「不同意」处理：
 * 宁可不定位，也不静默出境。
 */
async function ensureCrossBorderConsent(): Promise<boolean> {
  if (hasCrossBorderConsent()) return true
  const title = t('perm.locCrossTitle')
  const body = t('perm.locCrossBody')
  // 文案缺失时**不能弹一个空框让人点同意**（等于没有告知）——直接按不同意处理
  if (!title || !body) {
    console.warn('[Location] 出境同意文案缺失，已跳过定位（不发起 getLocation）')
    return false
  }
  try {
    const res = await Taro.showModal({
      title,
      content: body,
      confirmText: t('perm.locCrossAgree'),
      cancelText: t('perm.locCrossDecline')
    })
    if (!res.confirm) return false
  } catch (err) {
    console.warn('[Location] 出境同意弹窗失败，已跳过定位（不发起 getLocation）:', err)
    return false
  }
  try {
    Taro.setStorageSync(CROSS_BORDER_CONSENT_KEY, {
      agreed: true,
      version: CROSS_BORDER_CONSENT_VERSION,
      time: Date.now()
    })
  } catch (err) {
    // 记录失败不阻断本次使用（用户已明确同意），只是下次会再问一次
    console.warn('[Location] 出境同意记录写入失败（下次会重新征求）:', err)
  }
  return true
}

/**
 * 用户授权定位（H5: 浏览器 geolocation；weapp: wx.getLocation，需 app.config permission 声明）
 * → BigDataCloud 免费端点逆地理编码（无需 key，支持 CORS）取城市名
 * → 存 storage('user-city')，cloud.ts getBriefing 自动用新城市拉天气
 * 合规事实（2026-10-12 审计澄清，**勿再把这里写成「不上传」**）：
 * · 经纬度**确实被发送给 api.bigdatacloud.net**（第三方、境外服务）做逆地理编码 ——
 *   这是个人信息出境；该服务是否留存坐标不在本应用控制范围内。
 * · 所以只能说「本应用不落库」，**不能说「不上传」**——原文那句是错的，
 *   而且它已经导致《隐私政策》「坐标…不存储、不上传」与代码互相矛盾。
 * · 正确处置三条路：① 如实告知 + 单独同意；② 换国内地图开放平台；③ 直接砍掉定位
 *   （合规成本最低）。**2026-10-24：已按 ① 落地** —— 发起定位前单独弹「坐标出境说明」，
 *   未同意直接返回 null（见 ensureCrossBorderConsent）。出境合规路径（标准合同/安全评估）仍待产品决策。
 * 拒绝授权/失败返回 null，不阻塞晨报
 *
 * C-02：本函数是唯一的真实定位调用点，因此在此加「权限闸门」——
 * 未取得位置授权（本地未同意 或 系统侧已拒绝）直接返回 null，
 * 绝不发起 Taro.getLocation，避免绕过应用内授权弹窗。
 * 调用方（晨报页）负责功能触发式弹窗与「去设置」引导；本函数**只**会为「出境单独同意」弹一个
 * 系统级确认框（这是法定义务，不能省），其余 UI 不碰。
 */
export async function locateCity(): Promise<string | null> {
  try {
    // 权限闸门：已同意则直接通过（weapp 顺带与系统授权对账）；未同意 / 已达拒绝上限 → 返回 null
    const granted = await ensurePermission('location')
    if (!granted) {
      console.warn('[Location] 位置权限未授权，已跳过定位（不发起 getLocation）')
      return null
    }
    // 出境单独同意闸门：未同意 → 不采集坐标、不向第三方发起任何请求
    if (!(await ensureCrossBorderConsent())) {
      console.warn('[Location] 未取得坐标出境单独同意，已跳过定位（不发起 getLocation）')
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

