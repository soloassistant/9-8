import Taro from '@tarojs/taro'
import { getCloudRpc } from './cloudAuth'

/** 平台判定：两端走不同后端，但**契约相同**（都是 name + data → result）。 */
export const isWeapp = process.env.TARO_ENV === 'weapp'

/**
 * 云函数调用面 —— 唯一的跨端传输层。
 *
 * 为什么需要它（2026-10-05）：业务代码此前直接写 `Taro.cloud.callFunction`，
 * 那只在小程序成立；H5 上 `Taro.cloud` 是 undefined，调用直接抛 TypeError，
 * 于是每一次数据请求都掉进 mock 兜底，且**失败被 console.warn 吞掉、用户无感**。
 * 现在 H5 改走云服务自带的 `client.database.rpc()`（PostgREST 风格，POST {endpoint}/.cloud/database/rest/rpc/{name}），
 * 由 SDK 自动注入登录 access token —— 与小程序云函数**同一套业务逻辑、同一份实现**。
 *
 * 实测依据（匿名探测）：`/.cloud/database/rest/rpc/getBriefing` 返回 **401**（而非 404），
 * 说明路由在线、只是要鉴权 —— 匿名探测无法确认每个云函数是否都注册为 RPC，
 * 这一点需要**登录态下**跑一次冒烟才能定论，见 services/cloud.ts 的降级分支。
 *
 * 本层只负责「把请求送到后端并取回原始结果」。
 * 协议归一（{ code, message, data } vs 裸业务体）与降级策略留在 services/cloud.ts，
 * 不要在这里加 —— 混在一起会让「传输失败」和「业务返回错误」无法区分。
 */
export async function invoke(name: string, data?: Record<string, unknown>): Promise<unknown> {
  if (isWeapp) {
    if (!Taro.cloud) throw new Error('taro-cloud-unavailable')
    const res = await Taro.cloud.callFunction({ name, data })
    return res.result
  }
  const rpc = await getCloudRpc()
  if (!rpc) throw new Error('cloud-rpc-unavailable')
  return rpc(name, data ?? {})
}

/** 可选功能的取用方式：失败返回 null，不抛。调用方决定要不要提示用户。 */
export async function invokeOrNull(
  name: string,
  data?: Record<string, unknown>
): Promise<unknown | null> {
  try {
    return await invoke(name, data)
  } catch (err) {
    console.warn(`[DataSource] ${name} unavailable:`, err)
    return null
  }
}
