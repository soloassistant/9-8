/**
 * 崩溃 / 未捕获异常上报（H5 + 微信小程序）。
 *
 * 为什么单独一个模块（2026-10-23）：
 *   1. 原实现只在 `Taro.cloud?.callFunction` 分支里上报 —— H5 上 `Taro.cloud` 是 undefined，
 *      于是**公开入口崩了完全无人知晓**。H5 走的是 WorkBuddy 云库，需要另一条通道。
 *   2. H5 的 `Taro.onError` 会把事件**压扁成字符串**再回调（`res.stack || res.message || res`，
 *      见 taro-h5 errorListener），`err instanceof Error` 恒 false → 整段堆栈被塞进 message、
 *      stack 恒空、filename/lineno 全丢。所以 H5 侧必须直挂 `window.addEventListener('error')`
 *      拿原始 ErrorEvent，不能用 Taro 的封装。
 *   3. 崩溃路径上**任何二次抛错都会把主流程一起带走**，因此本模块：
 *      零 import、永不抛、有重入保护、有去重与次数预算。
 *
 * 本模块刻意**不 import 任何东西**（不 import Taro / cloudDb / i18n）：
 *   · 崩溃可能发生在 SDK 初始化之前，依赖越少存活率越高；
 *   · 也让 `.tools/verify-crash-report.js` 能单独编译真实源码做行为验证，不必伪造整条依赖链。
 *   真实发送通道由调用方（`src/app.tsx`）以 transport 形式注入。
 *
 * 隐私边界（硬约束）：上报内容一律过 `sanitizeText` ——
 *   邮箱 / 手机号 / URL 里的 token 类参数 / Bearer 凭据全部打码。
 *   崩溃日志是给开发者看的，不是收集用户信息的通道。
 */

/** 一条上报内容的最终形状（字段名与云库函数 `log_client_error` 入参对齐） */
export interface CrashPayload {
  message: string;
  stack: string;
  page: string;
  channel: string;
  ua: string;
}

/** 发送通道：true = 已送达。**实现方自己吞异常**，但这里仍然会兜一层。 */
export type CrashTransport = (payload: CrashPayload) => Promise<boolean>;

/** 单次页面加载最多上报几条：崩溃风暴时既不刷爆云端，也不拖慢主线程 */
const MAX_REPORTS_PER_SESSION = 8;

const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 4000;
const MAX_PAGE_LEN = 200;
const MAX_UA_LEN = 300;

/** 已上报过的签名（同一条错误只报一次，避免渲染循环里刷屏） */
const reportedSignatures = new Set<string>();
let sentCount = 0;
/** 重入保护：transport 自身出错时不再触发新一轮上报 */
let reporting = false;

/**
 * 打码：崩溃日志里绝不能出现可识别个人的内容。
 * 顺序有讲究 —— 先把 `token=...` 这类参数整体吃掉，再做邮箱/手机号替换，
 * 否则参数值里的邮箱会被替换成 `[email]` 后仍留下半截 `token=`。
 */
export function sanitizeText(input: string): string {
  let out = String(input == null ? '' : input);

  // 1) 凭据类参数：token/access_token/refresh_token/code/key/apikey/password/secret
  //    ⚠️ 不能只匹配 `?k=` / `&k=` —— 错误文案里更常见的是空格/引号分隔的裸 `token=xxx`
  //    （2026-10-23 端到端实测：`new Error('... token=abc123secret')` 上报后明文落库，
  //      单测只覆盖了 URL 形态所以没抓到）。这里允许 行首 / 空白 / 引号 / 括号 作为前导。
  out = out.replace(
    /(^|[\s?&"'(])((?:token|access_token|refresh_token|id_token|code|key|apikey|api_key|password|passwd|secret)=)[^&#\s"'<>]*/gi,
    '$1$2[redacted]'
  );
  // 2) Authorization 头形态
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [redacted]');
  // 3) 邮箱
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  // 4) 中国大陆手机号（不用 lookbehind，避免老内核 SyntaxError 把上报路径本身搞挂）
  out = out.replace(/(^|\D)(1[3-9]\d{9})(?!\d)/g, '$1[phone]');

  return out;
}

/**
 * 把任意形态的异常归一成 { message, stack }。
 *
 * 必须覆盖的形态（都真实存在）：
 *   · Error / 子类
 *   · ErrorEvent（H5 window.onerror 原生事件，带 filename/lineno/colno）
 *   · PromiseRejectionEvent（unhandledrejection，真正的错误在 `.reason`）
 *   · 字符串（Taro H5 的 onError 回调只给字符串）
 *   · 抛出的非 Error 值（reject('oops') / throw {}）
 */
export function normalizeError(raw: unknown): { message: string; stack: string } {
  if (raw == null) return { message: 'Unknown error', stack: '' };

  if (typeof raw === 'string') {
    // Taro H5 会把整个堆栈塞进字符串，这里拆开还原：首行是消息，其余是堆栈
    const text = raw.trim();
    // 空白字符串没有任何诊断价值；回空串让 reportCrash 直接跳过（别伪造成 "Unknown error"）
    if (text === '') return { message: '', stack: '' };
    const nl = text.indexOf('\n');
    if (nl > 0 && /^\s*at\s|@\S+:\d+/.test(text.slice(nl + 1))) {
      return { message: text.slice(0, nl).trim(), stack: text.slice(nl + 1).trim() };
    }
    return { message: text, stack: '' };
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;

    // PromiseRejectionEvent：真正的错误在 reason 里
    if ('reason' in obj && ('promise' in obj || obj.type === 'unhandledrejection')) {
      return normalizeError(obj.reason);
    }

    // ErrorEvent：优先用 error（含 stack），否则用 message + 位置信息拼一条
    const err = obj.error;
    if (err) {
      const inner = normalizeError(err);
      if (inner.message && inner.message !== 'Unknown error') return inner;
    }

    const message = typeof obj.message === 'string' ? obj.message.trim() : '';
    let stack = typeof obj.stack === 'string' ? obj.stack.trim() : '';
    if (!stack) {
      const file = typeof obj.filename === 'string' ? obj.filename : '';
      const line = typeof obj.lineno === 'number' ? obj.lineno : 0;
      const col = typeof obj.colno === 'number' ? obj.colno : 0;
      if (file) stack = `at ${file}:${line}:${col}`;
    }
    if ('message' in obj) {
      // 事件形态：有 message 字段就用它（可能是空），不再往下兜底成 "Unknown error"，
      // 否则纯噪声（message 为空白、又无位置信息）会被当成一条真实崩溃上报。
      return { message, stack };
    }
  }

  try {
    const text = String(raw);
    return { message: text === '[object Object]' ? 'Unknown error (non-Error thrown)' : text, stack: '' };
  } catch {
    return { message: 'Unknown error', stack: '' };
  }
}

/** 从 H5 路由取一个粗粒度页面标识（去掉 query，避免把参数带进日志） */
export function currentPage(): string {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    const hash = String(window.location.hash || '');
    const route = (hash.replace(/^#\/?/, '').split('?')[0] || '').slice(0, MAX_PAGE_LEN);
    return route;
  } catch {
    return '';
  }
}

function currentUa(): string {
  try {
    if (typeof navigator === 'undefined' || !navigator.userAgent) return '';
    return String(navigator.userAgent).slice(0, MAX_UA_LEN);
  } catch {
    return '';
  }
}

/** 归一 + 打码 + 截断，产出可直接发送的载荷 */
export function buildPayload(
  raw: unknown,
  opts: { channel: string; page?: string; ua?: string }
): CrashPayload {
  const { message, stack } = normalizeError(raw);
  return {
    message: sanitizeText(message).slice(0, MAX_MESSAGE_LEN),
    stack: sanitizeText(stack).slice(0, MAX_STACK_LEN),
    page: opts.page !== undefined ? opts.page.slice(0, MAX_PAGE_LEN) : currentPage(),
    channel: opts.channel,
    ua: (opts.ua !== undefined ? opts.ua : currentUa()).slice(0, MAX_UA_LEN)
  };
}

/** 去重签名：同一条错误在同一页面重复出现时只报一次 */
function signatureOf(payload: CrashPayload): string {
  return `${payload.channel}|${payload.page}|${payload.message.slice(0, 160)}`;
}

/**
 * 上报一条崩溃。**永不抛出、永不返回 Promise**（调用方不需要 await）。
 *
 * 跳过条件（任一命中即静默返回）：
 *   · 重入（transport 自己出错引发的上报）
 *   · 消息为空
 *   · 本次会话已报过同一签名
 *   · 本次会话已达条数上限
 */
export function reportCrash(
  raw: unknown,
  opts: { transport: CrashTransport; channel: string; page?: string; ua?: string }
): void {
  if (reporting) return;
  const payload = buildPayload(raw, opts);
  // 既没有消息也没有位置信息 = 纯噪声，不值得占一条额度
  if (!payload.message && !payload.stack) return;

  const sig = signatureOf(payload);
  if (reportedSignatures.has(sig)) return;
  if (sentCount >= MAX_REPORTS_PER_SESSION) return;

  reportedSignatures.add(sig);
  sentCount += 1;

  reporting = true;
  try {
    const p = opts.transport(payload);
    // ★ 只吞掉 rejection，**不要**挂在 then 上释放重入标记：
    // 标记必须在同一个 tick 内释放，否则「同步连发的一批错误」会被全部挡掉 ——
    // 而崩溃风暴时恰恰最需要日志。真正的重入（transport 内部同步再调 reportCrash）
    // 发生在 transport 调用期间，仍会被标记挡住。
    if (p && typeof p.then === 'function') p.then(() => undefined, () => undefined);
  } catch {
    /* transport 同步抛错：崩溃上报失败绝不能反过来影响主流程 */
  } finally {
    reporting = false;
  }
}

/**
 * H5 侧挂原生监听（微信小程序端请用 `Taro.onError`，别走这里）。
 *
 * 为什么不复用 `Taro.onError`：见文件头的第 2 条 —— Taro H5 会丢掉 stack 与位置信息。
 * 资源加载失败（<img>/<script> 404）触发的是普通 Event，没有 message，这里用
 * `instanceof ErrorEvent` 过滤掉，否则会上报一堆无意义的 "Script error."。
 */
export function installH5CrashHandlers(transport: CrashTransport, channel = 'h5'): void {
  try {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    window.addEventListener('error', (event: ErrorEvent) => {
      // 资源加载错误不是 ErrorEvent 的语义，跳过
      if (typeof ErrorEvent !== 'undefined' && !(event instanceof ErrorEvent)) return;
      reportCrash(event, { transport, channel });
    });

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      reportCrash(event, { transport, channel });
    });
  } catch {
    /* 注册失败不能影响启动 */
  }
}

/** 仅供 `.tools/verify-crash-report.js` 使用：清空去重表与计数器 */
export function __resetCrashState(): void {
  reportedSignatures.clear();
  sentCount = 0;
  reporting = false;
}
