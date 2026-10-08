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
  signOut(): Promise<AuthResp<null>>;
  onAuthStateChange(cb: (event: string, session: CloudSession | null) => void): () => void;
}

/** 云函数调用面（PostgREST 风格）：H5 走它，小程序走 Taro.cloud —— 契约相同，见 services/dataSource */
interface CloudDatabaseApi {
  rpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<T>;
  from(table: string): unknown;
}

interface CloudClient {
  auth: CloudAuthApi;
  /** 2026-10-05 实测 SDK 内部结构：WorkBuddyCloudClient 同时挂 auth / database / storage / llm。
   *  database 复用 auth 的 access token，因此必须在登录之后调用。 */
  database?: CloudDatabaseApi;
  /** OpenAI 兼容的 chat.completions，替代原先只能本地跑的 .tools/llm-proxy.mjs */
  llm?: { chat: { completions: { create(input: Record<string, unknown>): Promise<unknown> } } };
  storage?: unknown;
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

/** 供 dataSource 层取已登录的云函数调用面。**未登录返回 null** —— 调用方据此决定降级。 */
export async function getCloudRpc(): Promise<CloudDatabaseApi['rpc'] | null> {
  const c = await getCloudClient();
  return c?.database?.rpc?.bind(c.database) || null;
}

/** 供 dataSource 层取 LLM 调用面（OpenAI 兼容 completions）。未登录/SDK 缺失返回 null。 */
export async function getCloudLlm(): Promise<NonNullable<CloudClient['llm']> | null> {
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
 *  本应用数据库当前未建表，H5 的云端数据通路尚未接通。
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
