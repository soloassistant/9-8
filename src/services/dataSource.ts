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
 *   · ~~`chat` / `extract`~~ — **2026-10-31 一并摘除**。
 *     它们是**微信云函数**（`cloudfunctions/chat`、`cloudfunctions/extract`），跑在微信云开发里，
 *     **不是**应用数据库的 PG 函数。线上匿名探针实测（2026-10-31）：
 *       POST /.cloud/database/rest/rpc/chat    → 404 DATABASE_PGRST202
 *         "Could not find the function public.chat(messages) in the schema cache"
 *       POST /.cloud/database/rest/rpc/extract → 404 DATABASE_PGRST202
 *         "Could not find the function public.extract(text) in the schema cache"
 *     放行它们 = 给 H5 开两扇通往**不存在**的函数的门。
 *     为什么一直没炸：H5 上 `services/cloud.ts` 在 invoke 之前就把 chat/extract 特判走
 *     cloud.llm 了（`if (name === 'chat' || name === 'extract')`），而小程序端走
 *     `Taro.cloud.callFunction`、**根本不过这张表** ⇒ 这两个名字在本表里**不可达**。
 *     不可达 ⇒ 留着不炸，但它是**假的安全感**：谁按「chat/extract 已放行」去写新调用点，
 *     就会得到一发注定 404 的请求 + 一条「云端不可用」的假降级横幅。摘掉后残留调用
 *     **立即抛错**（不发网络请求），失败可被门禁与控制台立刻发现。
 *
 * ⚠️ 2026-10-31 复核并**改口**：此前这段写「chat/extract 有用户态，当前必被拒 —— 这是身份
 *   契约，不是缺陷」。那说的是**微信云函数**侧的身份契约（`getWXContext().OPENID`），
 *   与本表无关。就「应用数据库 PG 函数」而言，它们是**不存在**，不是「存在但被拒」。
 *   两者修法不同：后者只需摘表，前者要造函数。
 *
 * ⚠️ 2026-10-13 迁移注记：`database.rpc` 调的是**应用数据库里的 PostgreSQL 函数**，
 * 而 cloudfunctions/ 跑在微信云开发里 —— 两者不是一套运行时。
 * H5 的对话已改走 cloud.llm（见 services/cloudLlm），不经 RPC。
 *
 * ★ **放行前必须有线上探针证明对应的 PG 函数真实存在**（2026-10-30 立规，2026-10-31 加闸）：
 *   探针形状：`POST {endpoint}/.cloud/database/rest/rpc/<name>`，看返回码。
 *   PGRST202「Could not find the function」= 函数不存在 ⇒ **不许放行**。
 *   探针必须匿名跑（无登录态 ⇒ 服务端身份分支必拒绝 ⇒ 零写入风险）。
 *   ⚠️ 探针必须**带真实参数名**：PostgREST 按参数名匹配函数签名，
 *   不带参数时返回「Could not find the function public.X **without parameters**」——
 *   那句话只说明没匹配上这个调用形状，**不能**据此断定函数不存在。
 *   闸门：`.tools/verify-db-contract.mjs` 逐个探针本表的每个名字，不存在即红。
 *
 * ★ **本表当前为空**：应用数据库侧**没有任何**面向客户端的 PG 函数。
 *   H5 的用户数据读写走的是**另一条通道** —— `services/cloudDb.ts` 的 `db.rpc('kv_set_many')`
 *   / `db.rpc('kv_clear')`（会话态、RLS 按 auth.uid() 过滤），**不经过本闸**。
 *   两条通道必须分开看：本闸管的是「H5 能不能打应用数据库的 rpc」，cloudDb 管的是
 *   「能不能读写自己那一行的键值」。
 *
 * **平台文档（cloud-service 技能 references/database/code-generation.md）明确要求：身份由
 * `cloud.auth` 会话在请求层自动附带，客户端不得传任何 token / user id / owner id。**
 * 因此本层**不再注入 openid** —— 客户端自传 openid 既被平台明令禁止，又可被冒用（谁都能填别人的 id）。
 * H5 若将来要读用户数据，正确做法是在**应用数据库**里建 PostgreSQL 函数、在函数内用 `auth.uid()`
 * 取当前会话身份，而不是把身份当参数传来传去。
 *
 * **新增云函数进白名单前，先确认它在上面两条下是安全的。** 闸门放在传输层而不是业务代码里，
 * 是为了不依赖调用方自觉 —— 放业务层的话新调用点一定会绕过。
 *
 * ⚠️ 2026-10-31：本表被**清空**。改前是 `new Set(['chat', 'extract'])` ——
 *   这两个名字在应用数据库里**都不存在**（线上探针 PGRST202，见上），且在 H5 上
 *   **不可达**（cloud.ts 已特判截走）。改后是空集：H5 的 `invoke()` 一律**立即抛错、
 *   不发网络请求**。行为变化逐条核过，**无功能回退**：
 *     · H5：chat/extract 的既有调用点**全部**在 invoke 之前被 cloud.ts 特判截走 ⇒ 改前改后完全同路。
 *     · weapp：`invoke()` 在 `if (isWeapp)` 分支里就 `return` 了，**根本不过本表** ⇒ 无影响。
 *     · 唯一差别：若将来有人直接写 `invoke('chat')`，改前是「发一发注定 404 的请求」，
 *       改后是「立刻抛 rpc-not-allowed」—— 后者更快、更可查、且不污染降级表。
 */
const RPC_ALLOWLIST = new Set<string>([])

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
