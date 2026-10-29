/**
 * WorkBuddy 云服务认证（邮箱 / 手机号）—— **仅 H5 / 发布版使用**。
 *
 * 标识方式（2026-10-05 按 SDK 实现核对，非猜测）：SDK 的 `resolveAuthIdentifier` 读
 *   `{ email }` 或 `{ phone }`，且**两者恰好只能给一个** —— 都给或都不给会返回
 *   `invalid-request: requires exactly one of email or phone`。内部再归一化成
 *   `{ kind, username }`，`normalizePhone` 会剥离 +86 / 86 / 0086 并按 /^1\d{10}$/ 校验。
 *   所以调用方只需把 email 换成 phone，不必自己拼 E.164。
 *
 * 为什么需要它：发布版是**公开链接**，此前任何人拿到链接就能直接进入；而 H5 侧的数据隔离
 * 靠的是 localStorage 里**自生成的 UUID**（`cloud-user-id`），等于没有认证 —— 谁都能进、
 * 且换个 UUID 就是另一个"用户"。现在改为：进入必须先登录。
 *
 * 为什么走 CDN 全局而不是 npm 包（2026-10-01 决策，附证据）：
 *   仓库有 yarn.lock，CI 跑的是 `yarn install --frozen-lockfile`；但**本机没有 yarn**。
 *   用 npm 装只会写 package-lock、**不更新 yarn.lock** → CI 立刻挂在 lockfile 校验上。
 *   故按 SDK 文档给出的降级路径改用 CDN IIFE（全局 `WorkBuddyCloud`），
 *   并且**不往 package.json 加依赖**，避免留下一个装不上的幽灵依赖。
 *   副作用（必须知道）：SDK 变成运行时从 CDN 拉取 → 离网时登录不可用（但认证本来就需要网络）。
 *
 * 安全边界：
 *   · 只有 end-user 的 `publishableKey` 出现在前端 —— 它本身**不带任何权限**，服务端按
 *     **Origin 精确匹配**校验，所以写进源码是允许的；本文件不打印它、也不打印任何令牌。
 *   · 令牌只由 SDK 自己保管（内存 + 它的存储），本文件不读取、不外传、不落日志。
 *   · **不做任何假身份兜底**：没有 localStorage 假用户、没有 mock session、没有匿名登录。
 *     取不到会话就是「未登录」，由门禁拦住。
 *
 * ⚠️ 维护须知：`CLOUD_ENDPOINT` 必须来自 `workbuddy_cloud_service` 返回的 `publicConfig.endpoint`，
 *   且**与应用的发布域名严格一致**（服务端做 Origin 精确匹配）。若应用被重新发布到新域名，
 *   这里必须同步更新，否则登录会在服务端被拒 —— 这是本文件唯一的硬耦合。
 */

/** 来自 workbuddy_cloud_service inspect/activate 返回的 publicConfig */
const CLOUD_ENDPOINT = 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host';
const CLOUD_PUBLISHABLE_KEY = 'wbpk_nT3qDLBM2NVl5IdCtfJOex_V995lF7ChHLBFND6zV3jJqBl4mRYQ3pY';

const H5 = process.env.TARO_ENV === 'h5';

/** 认证结果统一形状（与 SDK 一致）：error 为 null 表示成功 */
export interface AuthResp<T> {
  data: T;
  error: { kind?: string; message?: string } | null;
}

export interface CloudUser {
  id?: string;
  email?: string;
  /** 2026-10-05 SDK 实测：parseUser 同时读 phone_number 与 phone 两个字段。
   *  微信登录的用户两者都没有，故保持可选。 */
  phone?: string;
}
export interface CloudSession {
  user?: CloudUser;
}

/** 登录标识：**email 与 phone 恰好给一个**（SDK 的 resolveAuthIdentifier 会拒绝"两个都给"或"都不给"）。
 *
 *  手机号不用在前端做国际区号归一化 —— SDK 内部 `normalizePhone` 会剥离 +86 / 86 / 0086，
 *  按 /^1\d{10}$/ 校验，并在不符合时原样回传以便服务端报错。前端只做"看起来像手机号"的轻校验。 */
export type AuthIdentifier = { email: string } | { phone: string };

/** 该标识是不是手机号（登录页据此切文案、决定是否显示「忘记密码」——SDK 只有邮箱改密） */
export function isPhoneIdentifier(id: AuthIdentifier): id is { phone: string } {
  return 'phone' in id;
}

interface CloudAuthApi {
  getSession(): Promise<AuthResp<CloudSession | null>>;
  signInWithPassword(input: AuthIdentifier & { password: string }): Promise<AuthResp<CloudSession>>;
  sendOtp(input: AuthIdentifier): Promise<
    AuthResp<{ verificationId: string; isExistingUser: boolean }>
  >;
  verifyOtp(input: AuthIdentifier & {
    verificationId: string;
    isExistingUser: boolean;
    token: string;
    password?: string;
  }): Promise<AuthResp<CloudSession>>;
  resetPasswordForEmail(
    email: string
  ): Promise<AuthResp<{ updateUser(input: { nonce: string; password: string }): Promise<AuthResp<CloudSession>> }>>;
  /** 已登录改密（SDK 契约）：先 POST /v1/user/sudo 用旧密码换 sudo_token，再 PATCH /v1/user/password。
   *  必须证明持有旧密码，所以「忘了密码」走不了这条。
   *  ⚠️ 2026-10-29 更正旧注释：服务端**有**短信重置能力，只是 SDK 没封装 ——
   *  见下方 requestPasswordResetByPhone 的探测记录（已实测并对接）。 */
  resetPasswordForOld(input: { oldPassword: string; newPassword: string }): Promise<AuthResp<CloudSession>>;
  signOut(): Promise<AuthResp<null>>;
  onAuthStateChange(cb: (event: string, session: CloudSession | null) => void): () => void;
}

/** 云函数调用面（PostgREST 风格）：H5 走它，小程序走 Taro.cloud —— 契约相同，见 services/dataSource */
export interface DbError {
  code?: string;
  message?: string;
}
export interface DbResponse<T> {
  data: T;
  error: DbError | null;
  /** 仅 count 查询（select(..., { count:'exact', head:true })）有值 */
  count?: number | null;
}

/**
 * PostgREST 查询构建器（supabase-js 形状，见 cloud-service 技能 database/code-generation.md）：
 * thenable —— `await from(...)` 得到 `{ data, error }`；链式方法返回构建器本身。
 * 这里只声明本应用用到的面；运行时对象由 CDN SDK 提供，按结构匹配。
 */
export interface DbQuery<T = unknown> extends Promise<DbResponse<T>> {
  select(columns?: string, opts?: { count?: 'exact'; head?: boolean }): DbQuery<T>;
  insert(rows: Record<string, unknown> | Array<Record<string, unknown>>): DbQuery<T>;
  upsert(
    values: Record<string, unknown>,
    opts?: { onConflict?: string; ignoreDuplicates?: boolean }
  ): DbQuery<T>;
  update(values: Record<string, unknown>): DbQuery<T>;
  delete(): DbQuery<T>;
  eq(column: string, value: unknown): DbQuery<T>;
  neq(column: string, value: unknown): DbQuery<T>;
  gt(column: string, value: unknown): DbQuery<T>;
  gte(column: string, value: unknown): DbQuery<T>;
  lt(column: string, value: unknown): DbQuery<T>;
  lte(column: string, value: unknown): DbQuery<T>;
  like(column: string, pattern: string): DbQuery<T>;
  ilike(column: string, pattern: string): DbQuery<T>;
  is(column: string, value: unknown): DbQuery<T>;
  in(column: string, values: unknown[]): DbQuery<T>;
  or(filters: string): DbQuery<T>;
  match(obj: Record<string, unknown>): DbQuery<T>;
  order(column: string, opts?: { ascending?: boolean }): DbQuery<T>;
  limit(n: number): DbQuery<T>;
  range(from: number, to: number): DbQuery<T>;
  single(): DbQuery<T>;
  maybeSingle(): DbQuery<T>;
  abortSignal(signal: AbortSignal): DbQuery<T>;
}

interface CloudDatabaseApi {
  /** PostgreSQL 函数调用：返回 thenable 的 `{ data, error }`（可再链 .select/.limit） */
  rpc<T = unknown>(fn: string, params?: Record<string, unknown>): DbQuery<T>;
  from(table: string): DbQuery<unknown>;
}

/** 存储能力（2026-10-26 接入：头像上传）。
 *  平台模型见 cloud-service 技能的 storage/code-generation.md：
 *   · 只有一个逻辑 Bucket `runtime`，路径必须是 `users/<自己的 uid>/...` 或 `shared/<ownerUid>/...`；
 *   · 目录 = 对象键前缀，上传即创建，没有 mkdir；
 *   · **没有公开 URL** —— 读要换签名 URL（1–3600s）；签名是短时凭证，不落日志不长存；
 *   · 需要登录会话（未登录不该调）。
 *  字段形状按文档给出并**兼容两种大小写**（signedUrl / signedURL）：SDK 版本间命名可能漂移，
 *  取不到就如实报错，不猜别的字段。 */
export interface CloudStorageApi {
  userPath(uid: string, sub: string): string;
  sharedPath(uid: string, sub: string): string;
  upload(
    path: string,
    body: Blob | File | ArrayBuffer,
    opts?: { contentType?: string; cacheControl?: string; upsert?: boolean; metadata?: Record<string, string> }
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  createSignedUrl(
    path: string,
    ttl?: number
  ): Promise<{ data: { signedUrl?: string; signedURL?: string } | null; error: { code?: string; message?: string } | null }>;
  exists(path: string): Promise<{ data: boolean | null; error: { code?: string; message?: string } | null }>;
  remove(paths: string[]): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

interface CloudClient {
  auth: CloudAuthApi;
  /** 2026-10-05 实测 SDK 内部结构：WorkBuddyCloudClient 同时挂 auth / database / storage / llm。
   *  database 复用 auth 的 access token，因此必须在登录之后调用。 */
  database?: CloudDatabaseApi;
  /** OpenAI 兼容的 chat.completions，替代原先只能本地跑的 .tools/llm-proxy.mjs。
   *  2026-10-13 按 llm/code-generation.md 补真形状：只支持 stream:true，
   *  create() 返回**异步可迭代**的 SSE chunk 流（for await 消费）。 */
  llm?: CloudLlmApi;
  /** 文件存储（2026-10-26）：与 auth/database 同一个 client，**必须在登录之后调用** */
  storage?: CloudStorageApi;
}
interface CloudGlobal {
  createWorkBuddyCloud(config: { endpoint: string; publishableKey: string }): CloudClient;
}

declare global {
  interface Window {
    WorkBuddyCloud?: CloudGlobal;
  }
}

function readGlobal(): CloudGlobal | null {
  if (typeof window === 'undefined') return null;
  return window.WorkBuddyCloud || null;
}

/** 等 CDN 脚本就绪：`<script>` 是异步加载的，首屏检查可能早于它完成。
 *  轮询而非事件，因为 IIFE 不提供 load 回调；上限 5s，超时按「SDK 不可用」处理。 */
export function waitForSdk(timeoutMs = 5000): Promise<CloudGlobal | null> {
  if (!H5) return Promise.resolve(null);
  const found = readGlobal();
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const g = readGlobal();
      if (g || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(g || null);
      }
    }, 100);
  });
}

let client: CloudClient | null = null;

/** 初始化一次，全模块复用同一个 client（认证/数据库/存储共用） */
export async function getCloudClient(): Promise<CloudClient | null> {
  if (!H5) return null;
  if (client) return client;
  const g = await waitForSdk();
  if (!g) return null;
  client = g.createWorkBuddyCloud({
    endpoint: CLOUD_ENDPOINT,
    publishableKey: CLOUD_PUBLISHABLE_KEY
  });
  return client;
}

/** 统一收口所有 SDK 调用：**绝不让它 reject**。
 *
 *  为什么必须有（2026-10-05 真实故障）：SDK 在异常路径上可能 throw 而**不是**返回 `{ error }`。
 *  一旦 throw，调用方的 `await` 会直接抛出；而登录页的处理函数里 `setBusy(false)` 在 await 之后，
 *  于是**既不会显示任何错误、也不会解除禁用态** —— 用户看到的就是「点了没反应、验证码也收不到」，
 *  按钮此后永久卡住。这是最糟的静默失败，单点收口即可根除，不必在每个使用点各自防御。 */
async function safeAuth<T>(
  fn: (c: CloudClient) => Promise<AuthResp<T>>,
  fallback: T
): Promise<AuthResp<T>> {
  const c = await getCloudClient();
  if (!c) {
    return { data: fallback, error: { kind: 'backend-unavailable', message: 'cloud sdk unavailable' } };
  }
  try {
    return await fn(c);
  } catch (e) {
    return { data: fallback, error: { kind: 'network', message: String((e && e.message) || e) } };
  }
}

/** 是否需要在进入前拦截（仅 H5/发布版；微信小程序侧由微信身份直接登录，不走这里） */
export const needsAuthGate = H5;

/* ---------------- 门禁重定向标记（消除重复的 token 请求） ---------------- */
/** app.tsx 的门禁刚把「未登录」用户 reLaunch 到登录页时会打这个标记。
 *  登录页 onLoad 里本来还要再查一次会话；冷启动未登录时两次检查都会打到
 *  POST /.cloud/auth/v1/token（2026-10-28 浏览器实测重复两次）。
 *  门禁那次检查已经证明「后端可达 + 无会话」，登录页直接采信即可 ——
 *  用一次性标记而不是给 getSession 加缓存，避免把真实登录后的新会话读成旧值。 */
let gateRedirectAt = 0;
const GATE_REDIRECT_TTL_MS = 5000;

export function markGateRedirect(): void {
  gateRedirectAt = Date.now();
}

/** 取用一次即失效；超过 TTL 视为陈旧（用户可能在登录页停留很久后手动刷新）。 */
export function consumeGateRedirect(): boolean {
  if (!gateRedirectAt) return false;
  const fresh = Date.now() - gateRedirectAt <= GATE_REDIRECT_TTL_MS;
  gateRedirectAt = 0;
  return fresh;
}

/** SDK/云服务是否真的可用。
 *  为什么要单独暴露：取不到会话有两种完全不同的原因 ——「未登录」和「后端根本连不上」。
 *  若把后者也当成前者，用户会看到一个能填、点了却永远失败的登录表单（等于静默失败）。
 *  上层据此给出明确提示。 */
export async function isCloudReady(): Promise<boolean> {
  return !!(await getCloudClient());
}

/** 取当前会话；未登录 / SDK 不可用都返回 null（调用方据此显示登录页） */
export async function getSession(): Promise<CloudSession | null> {
  const c = await getCloudClient();
  if (!c) return null;
  try {
    const { data, error } = await c.auth.getSession();
    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

export function signInWithPassword(
  id: AuthIdentifier,
  password: string
): Promise<AuthResp<CloudSession>> {
  return safeAuth((c) => c.auth.signInWithPassword({ ...id, password }), {} as CloudSession);
}

/** 取验证码（邮箱或手机号）。**改名而非加函数**：它已经不再只发邮件，
 *  沿用 sendEmailCode 会让调用方误以为只能走邮箱。 */
export function sendLoginCode(
  id: AuthIdentifier
): Promise<AuthResp<{ verificationId: string; isExistingUser: boolean }>> {
  return safeAuth((c) => c.auth.sendOtp({ ...id }), { verificationId: '', isExistingUser: false });
}

export function verifyLoginCode(input: {
  id: AuthIdentifier;
  verificationId: string;
  isExistingUser: boolean;
  token: string;
  password?: string;
}): Promise<AuthResp<CloudSession>> {
  const { id, ...rest } = input;
  return safeAuth((c) => c.auth.verifyOtp({ ...id, ...rest }), {} as CloudSession);
}

/** 已登录修改密码（「我的」页入口）。安全模型：必须先出示**旧密码**（服务端 sudo 校验）
 *  才允许设新密码 —— 手机被别人拿着时改不了密。忘了旧密码的手机号用户走短信验证码登录，
 *  服务端没有短信重置接口（见 CloudAuthApi.resetPasswordForOld 注释）。 */
export function resetPasswordForOld(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<AuthResp<CloudSession>> {
  return safeAuth((c) => c.auth.resetPasswordForOld(input), {} as CloudSession);
}

/** 供 dataSource 层取已登录的云函数调用面。**未登录返回 null** —— 调用方据此决定降级。
 *  注意返回的是 PostgREST 构建器：await 得到 `{ data, error }` 信封，不是裸业务值
 *  （2026-10-13 按 database/code-generation.md 更正，此前类型标成 Promise<T> 是错的）。 */
export async function getCloudRpc(): Promise<CloudDatabaseApi['rpc'] | null> {
  const c = await getCloudClient();
  return c?.database?.rpc?.bind(c.database) || null;
}

/** 取 database 模块本体（from() 直表查询用）。未登录/SDK 缺失返回 null。 */
export async function getCloudDatabase(): Promise<CloudDatabaseApi | null> {
  const c = await getCloudClient();
  return c?.database || null;
}

/** LLM 模型的公开字段（llm/code-generation.md：稀疏字段，缺失≠false） */
export interface LlmModel {
  id: string;
  name?: string;
  disabled?: boolean;
}

/** 一条 chat 消息。系统提示必须由应用提供且位于 messages[0]（SDK 不插默认值）。 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** create() 入参（本应用用到的面；只支持 stream:true） */
export interface LlmCreateInput {
  model: string;
  messages: LlmMessage[];
  stream: true;
  conversationId?: string;
  temperature?: number;
  top_p?: number;
  signal?: AbortSignal;
}

/** SSE chunk（OpenAI 兼容形状） */
export interface LlmChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; refusal?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { total_tokens?: number };
}

interface CloudLlmApi {
  models?: { list(): Promise<LlmModel[]> };
  chat: { completions: { create(input: LlmCreateInput): Promise<AsyncIterable<LlmChunk>> } };
}

/** 供 dataSource 层取 LLM 调用面（OpenAI 兼容 completions）。未登录/SDK 缺失返回 null。 */
export async function getCloudLlm(): Promise<CloudLlmApi | null> {
  const c = await getCloudClient();
  return c?.llm || null;
}

/** 当前登录用户的稳定 id（H5 = 平台 auth 会话里的 user.id）。
 *
 *  ⚠️ **不得**用它去顶替微信 OPENID，也不要把身份当参数传给云函数。
 *  平台文档（cloud-service / references/database/code-generation.md）原文要求：
 *  「Identity is automatic: after the user logs in via `cloud.auth`, the shared request layer
 *   attaches the current session to each database request. **Never pass a token, user id, or
 *   owner id by hand.**」
 *  正确做法：服务端在**应用数据库的 PostgreSQL 函数**里用 `auth.uid()` 取身份
 *  （表的 owner 列同理用 `DEFAULT auth.uid()` + RLS，客户端不传 owner_id）。
 *
 *  另注：`cloud.database.rpc()` 调的是**应用数据库里的 PostgreSQL 函数**，不是
 *  `cloudfunctions/` 下的微信云函数（后者跑在微信云开发里，只认 `getWXContext().OPENID`）。
 *  应用数据库现状（2026-10-24 核实）：已有 user_kv / llm_events / client_errors /
 *  feedback 四表与 kv_clear / kv_set_many / log_client_error 三个 PG 函数（同步键、
 *  用量记账、崩溃上报在用；feedback 由客户端直插，RLS insert-own）。业务函数
 *  （getUsage / shopping / createOrder 等）的 PG 版尚未注册，对应功能仍走本地降级。
 *
 *  未登录返回 null。 */
export async function getCloudUserId(): Promise<string | null> {
  try {
    const s = await getSession();
    return s?.user?.id || null;
  } catch {
    return null;
  }
}

const NOOP_UPDATE_USER = {
  updateUser: async (): Promise<AuthResp<CloudSession>> => ({
    data: {} as CloudSession,
    error: { kind: 'backend-unavailable', message: 'cloud sdk unavailable' }
  })
};

export function requestPasswordReset(
  email: string
): Promise<AuthResp<{ updateUser(input: { nonce: string; password: string }): Promise<AuthResp<CloudSession>> }>> {
  return safeAuth((c) => c.auth.resetPasswordForEmail(email), NOOP_UPDATE_USER);
}

/* ============================================================
 * 手机号找回密码（2026-10-29）
 * ------------------------------------------------------------
 * 背景：SDK 只封装了 resetPasswordForEmail，于是「手机号忘记密码」长期被当成做不到 ——
 * 登录页甚至在手机号 tab 下写了「没有忘记密码，请用短信登录」。
 *
 * 但**服务端是支持的**，直接把接口探出来了（2026-10-29 实测，均以 publishable key 作
 * `x-wb-webapp-access-key`，与 SDK 内部完全同一套鉴权）：
 *   · POST /.cloud/auth/v1/verification  { phone_number:"+86 13000000000",
 *                                          usage:"PASSWORD_RESET", target:"USER" }
 *       → 400 FAILED_PRECONDITION「账号不存在」，与邮箱形态**逐字相同**：
 *         说明 usage/target 组合对手机号有效，且做了同样的账号存在性校验。
 *   · POST /.cloud/auth/v1/reset { phone_number, new_password, verification_token }
 *       → 与邮箱形态返回**完全相同**的错误（Username or password incorrect.），
 *         说明 `phone_number` 与 `email` 一样被当作标识符接受。
 *   · 手机号格式有强校验：`^\+[1-9][0-9]{0,3}\s[0-9]{4,20}$` —— 国家码后**必须有空格**。
 *
 * 所以这里按 SDK 邮箱流程的同一套协议补一份手机号实现。仍走裸 fetch 而不是 SDK：
 * SDK 的 resetPasswordForEmail 把 email/usage 写死在函数体里，没有可复用的注入点。
 * 一旦官方 SDK 补上这个能力，这里的三个请求整体换成 SDK 调用即可（协议不变）。
 * ============================================================ */

/** 手机号 → 服务端要求的 `+CC 号码` 形态。口径与 SDK 内部 normalizePhone 一致：
 *  只认大陆号（/^1\d{10}$/，剥掉 0086/86 前缀）；不符合就原样回传，让服务端报错，
 *  而不是在前端猜一个格式（猜错会把「号码写错了」显示成「网络错误」）。 */
function toApiPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  let n = digits;
  if (n.startsWith('0086')) n = n.slice(4);
  else if (n.startsWith('86') && n.length === 13) n = n.slice(2);
  return /^1\d{10}$/.test(n) ? `+86 ${n}` : String(raw || '').trim();
}

/** 裸调云端 auth 接口。**绝不 reject**（与 safeAuth 同一纪律：抛出去会让调用方的
 *  setBusy(false) 永远执行不到，按钮就永久卡死）。 */
async function cloudAuthPost<T>(
  path: string,
  body: unknown,
  timeoutMs = 8000
): Promise<AuthResp<T>> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${CLOUD_ENDPOINT}/.cloud/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-wb-webapp-access-key': CLOUD_PUBLISHABLE_KEY
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    });
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    if (res.ok) return { data: (parsed || {}) as T, error: null };
    const msg =
      (parsed && (parsed.error_description as string)) ||
      (parsed && (parsed.message as string)) ||
      `HTTP ${res.status}`;
    const kind =
      res.status === 400 ? 'invalid-request'
        : res.status === 401 ? 'unauthenticated'
          : res.status === 403 ? 'permission-denied'
            : res.status === 404 ? 'not-found'
              : res.status === 429 ? 'rate-limited'
                : res.status >= 500 ? 'backend-unavailable' : 'unknown';
    // 账号不存在是「expected 的业务拒绝」，但**不能**把它说成网络错误 —— 服务端原话
    // 「账号不存在」比前端统一的「出了点问题」有用得多，原样透出。
    return { data: null as unknown as T, error: { kind, message: msg } };
  } catch (e) {
    return {
      data: null as unknown as T,
      error: { kind: 'network', message: e instanceof Error ? e.message : String(e) }
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 手机号找回密码：发短信验证码 → 用验证码换 verification_token → 提交新密码 → 自动登录。
 *  返回形状与 requestPasswordReset 一致（updateUser({nonce,password})），登录页两条通道共用同一段 UI。 */
export async function requestPasswordResetByPhone(
  phone: string
): Promise<AuthResp<{ updateUser(input: { nonce: string; password: string }): Promise<AuthResp<CloudSession>> }>> {
  if (!H5) return { data: NOOP_UPDATE_USER, error: null };
  const id = toApiPhone(phone);
  const sent = await cloudAuthPost<{ verification_id?: string }>('/v1/verification', {
    phone_number: id,
    usage: 'PASSWORD_RESET',
    target: 'USER'
  });
  if (sent.error) return { data: NOOP_UPDATE_USER, error: sent.error };
  const verificationId = sent.data && sent.data.verification_id;
  if (!verificationId) {
    return { data: NOOP_UPDATE_USER, error: { kind: 'unknown', message: '服务端未返回 verification_id' } };
  }
  return {
    data: {
      updateUser: async ({ nonce, password }) => {
        const verified = await cloudAuthPost<{ verification_token?: string }>('/v1/verification/verify', {
          verification_id: verificationId,
          verification_code: nonce
        });
        if (verified.error) return { data: null as unknown as CloudSession, error: verified.error };
        const token = verified.data && verified.data.verification_token;
        if (!token) {
          return { data: null as unknown as CloudSession, error: { kind: 'unknown', message: '服务端未返回 verification_token' } };
        }
        const reset = await cloudAuthPost<unknown>('/v1/reset', {
          phone_number: id,
          new_password: password,
          verification_token: token
        });
        if (reset.error) return { data: null as unknown as CloudSession, error: reset.error };
        // 与 SDK 的邮箱流程一致：重置成功后直接建立会话（SDK 内部也是 signInWithPassword）
        return signInWithPassword({ phone: id }, password);
      }
    },
    error: null
  };
}

export async function signOut(): Promise<void> {
  const c = await getCloudClient();
  if (!c) return;
  try {
    await c.auth.signOut();
  } catch {
    /* 登出失败不阻塞：调用方会重新走门禁 */
  }
}

/** 订阅登录态变化；返回取消订阅函数（调用方在卸载时清理） */
export function onAuthStateChange(cb: (session: CloudSession | null) => void): () => void {
  let unsub: (() => void) | null = null;
  let cancelled = false;
  getCloudClient().then((c) => {
    if (!c || cancelled) return;
    unsub = c.auth.onAuthStateChange((_event, session) => cb(session));
  });
  return () => {
    cancelled = true;
    if (unsub) unsub();
  };
}
