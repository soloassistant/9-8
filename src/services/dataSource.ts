import Taro from '@tarojs/taro'
import { getCloudRpc } from './cloudAuth'

/** 平台判定：两端走不同后端，但**契约相同**（都是 name + data → result）。 */
export const isWeapp = process.env.TARO_ENV === 'weapp'

/**
 * 允许 H5 经 database.rpc 调用的云函数白名单。
 *
 * **为什么必须有白名单（2026-10-05 审计发现）**：cloudfunctions/ 下多数函数开头是裸的
 * `const { OPENID } = cloud.getWXContext()`，而 H5 发起 RPC 时没有微信上下文。
 * 若放行，OPENID 为 undefined，`where({ openid: undefined })` 会让**所有 H5 用户共用同一个
 * 数据桶** —— events / todos / items / shopping / user_prefs / user_affinity / usage 全部串。
 *
 * 准入条件（两条都满足才放行）：
 *   ① 只认服务端权威身份，或本身无用户态；
 *   ② 取不到身份时**拒绝**（抛错），而不是让 openid 以 undefined 落库。
 *
 * 目前放行：
 *   · ~~`webSearch`~~ —— **2026-10-30 摘除**。线上实测（匿名探针）：
 *     `POST /.cloud/database/rest/rpc/webSearch` → **404 DATABASE_PGRST202
 *     "Could not find the function public.webSearch(action, feedback, id) in the schema cache"**
 *     —— 应用数据库里**根本没有** `webSearch` 这个 PG 函数（微信云开发里的那个同名云函数
 *     与应用数据库是两套运行时）。而它此前在白名单里 ⇒ H5 每次调它都白发一发**注定 404** 的请求，
 *     并把「webSearch」登记进降级表 ⇒ 页级横幅亮出「云端功能暂不可用，当前为本地演示数据」，
 *     而页面上显示的是**真实** RSS ⇒ 把真实数据说成演示数据（反向谎言）。
 *     一次带倒 4 个功能：视频精选 / 视频资讯 / 全网搜索 / AI 资讯精选（+ 👍👎 的多余落库请求）。
 *     摘除后任何残留调用**立即抛错**（不发网络请求）⇒ 失败可被门禁与控制台立刻发现。
 *     H5 的替代通路：视频改走**同源静态载荷**（services/cloud.ts 的 getHotspotPayload +
 *     services/api.ts 的 apiVideoNews），AI 精选改走 cloud.llm；
 *     小程序端不受影响（走 Taro.cloud.callFunction，不经过这张表）。
 *   · `chat` / `extract` — 有用户态，但 2026-10-08 已收口为**只认微信上下文**
 *     （`cloud.getWXContext().OPENID`，取不到即 throw）。H5 没有微信上下文，故当前必被拒 ——
 *     这是身份契约，不是缺陷。
 *
 * ⚠️ 2026-10-13 迁移注记：`database.rpc` 调的是**应用数据库里的 PostgreSQL 函数**，
 * 而 cloudfunctions/ 跑在微信云开发里 —— 两者不是一套运行时。上述放行项在应用数据库里
 * 尚未注册对应 PG 函数，因此当前调用必然失败、由调用方降级；白名单保留的是「端口径」：
 * 将来哪个函数被移植进应用数据库，先确认它在上面两条下安全，再进来。
 * H5 的对话已改走 cloud.llm（见 services/cloudLlm），不经 RPC。
 *
 * ★ **放行前必须有线上探针证明对应的 PG 函数真实存在**（2026-10-30 立规）：
 *   探针形状：`POST {endpoint}/.cloud/database/rest/rpc/<name>`，看返回码。
 *   PGRST202「Could not find the function」= 函数不存在 ⇒ **不许放行**。
 *   探针必须匿名跑（无登录态 ⇒ 服务端身份分支必拒绝 ⇒ 零写入风险）。
 *
 * **平台文档（cloud-service 技能 references/database/code-generation.md）明确要求：身份由
 * `cloud.auth` 会话在请求层自动附带，客户端不得传任何 token / user id / owner id。**
 * 因此本层**不再注入 openid** —— 客户端自传 openid 既被平台明令禁止，又可被冒用（谁都能填别人的 id）。
 * H5 若将来要读用户数据，正确做法是在**应用数据库**里建 PostgreSQL 函数、在函数内用 `auth.uid()`
 * 取当前会话身份，而不是把身份当参数传来传去。
 *
 * **新增云函数进白名单前，先确认它在上面两条下是安全的。** 闸门放在传输层而不是业务代码里，
 * 是为了不依赖调用方自觉 —— 放业务层的话新调用点一定会绕过。
 */
const RPC_ALLOWLIST = new Set(['chat', 'extract'])

/**
 * 云函数调用面 —— 唯一的跨端传输层。
 *
 * 为什么需要它（2026-10-05）：业务代码此前直接写 `Taro.cloud.callFunction`，
 * 那只在小程序成立；H5 上 `Taro.cloud` 是 undefined，调用直接抛 TypeError，
 * 于是每一次数据请求都掉进 mock 兜底，且**失败被 console.warn 吞掉、用户无感**。
 * 现在 H5 改走云服务自带的 `client.database.rpc()`（PostgREST 风格，POST {endpoint}/.cloud/database/rest/rpc/{name}），
 * 由 SDK 自动注入登录 access token —— 与小程序云函数**同一套业务逻辑、同一份实现**。
 *
 * 本层负责两件事：传输、白名单闸门、**信封归一**。
 * 协议归一（PostgREST 的 `{ data, error }` vs 微信云函数的 `{ code, message, data }` vs 裸业务体）
 * 与降级策略留在 services/cloud.ts。
 */
export async function invoke(name: string, data?: Record<string, unknown>): Promise<unknown> {
  if (isWeapp) {
    if (!Taro.cloud) throw new Error('taro-cloud-unavailable')
    const res = await Taro.cloud.callFunction({ name, data })
    return res.result
  }
  if (!RPC_ALLOWLIST.has(name)) {
    // 抛错而非静默：调用方会接住并降级到 mock，但控制台会留下「为什么不走 RPC」的可查痕迹
    throw new Error(`rpc-not-allowed:${name} (H5 无微信上下文，且平台禁止客户端自传身份)`)
  }
  const rpc = await getCloudRpc()
  if (!rpc) throw new Error('cloud-rpc-unavailable')
  // PostgREST 信封 → 裸业务体（与小程序路径对齐）；error 非空即抛，调用方降级
  const res = (await rpc(name, data ?? {})) as { data?: unknown; error?: { message?: string } | null } | null
  if (res && typeof res === 'object' && 'error' in res) {
    if (res.error) throw new Error(`rpc-error:${name}:${res.error.message || 'unknown'}`)
    return res.data
  }
  return res
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
