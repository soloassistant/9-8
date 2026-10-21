/**
 * H5 云端 LLM 对话（cloud.llm）—— 替代原先只能本机跑的 .tools/llm-proxy.mjs。
 *
 * 为什么需要它（2026-10-13 H5 迁移）：H5 此前的「AI 对话」在生产环境必然落到本地规则 mock
 * （llm-proxy 只在开发机的 localhost:8138 上，线上没有）—— 功能从未真正上线过。
 * 现在改走云服务自带的 LLM 模块（keyless，OpenAI 兼容 chat.completions），
 * 前端直连 SDK，**不建 BFF / Node 代理**（平台明令禁止）。
 *
 * 硬约束（llm/code-generation.md）：
 *   · 只支持 `stream: true`；非流式入参会在发请求前被 SDK 拒（request_stream_required）。
 *   · **每次调用必须自带 system 消息且位于 messages[0]**（SDK 不插默认值）。
 *     本模块用 `system` 参数结构上保证这一点，调用方无法绕过。
 *   · `conversationId` 由应用自持（本模块负责生成/持久化），仅用于路由与计量关联，
 *     **不是服务端历史存储** —— 多轮上下文要由应用自己放进 messages。
 *   · 模型从 `models.list()` 选（第一个非 disabled）；**空列表/取不到就明确失败**，
 *     绝不硬编码 model id 兜底（目录里没有的模型发了也白搭）。
 *
 * 系统提示与 chat 云函数**同口径移植**（BASE + 排班契约 + 购物纪律 + 记忆契约），
 * 保证 H5 与小程序两侧人设、JSON 输出契约一致；上下文（日程/待办/记忆）按云函数同款
 * `我的数据：…\n我的指令：…` 形状拼接，数据源换成本地 dailyPlanStore。
 */

import Taro from '@tarojs/taro';
import { getCloudLlm } from './cloudAuth';
import type { LlmMessage } from './cloudAuth';
import { llmEventInsert } from './cloudDb';
import { readPlan } from '../data/dailyPlan';
import type { ExtractResult } from '../types';

/* ---------------- 系统提示（与 cloudfunctions/chat 同口径） ---------------- */

const MAX_PLAN_ITEMS = 8;

const SHOPPING_REFUSE_REPLY =
  '我可以帮你查价、比价和汇总优惠，但下单付款需要你本人在购物平台完成，我不会代替你操作。';
const SHOPPING_DISCLAIMER = '我只帮你查价和汇总信息，不会替你下单或付款。';
const SHOPPING_DISCLAIMER_SOURCE = '以下价格来自公开渠道，仅供参考，请以商品页面实际价格为准。';
const SHOPPING_PRICE_GUARD =
  '价保提示：部分平台支持下单后 7 天内价保，建议在下单前确认该商品的价保规则。';

const MEMORY_RECALL_PROMPT =
  '【用户长期记忆】上下文中的 memories 字段是用户的长期记忆偏好，安排日程、回答问题时必须遵守（如偏好的会议时段、作息习惯），不得与之冲突。';

const BASE_SYSTEM_PROMPT =
  '你是私人晨报助理。基于用户当前日程数据及对话执行指令。输出 JSON：{"reply": "给用户的中文回复(120字内)", "action": "reschedule|done|query|schedule|batch|shopping|chat", "targetId": "事件或待办id或null", "newTime": "YYYY-MM-DD HH:mm或null", "newEvents": null}。改期指令且能定位目标时 action=reschedule；完成指令且能定位时 action=done；询问安排时 action=query；闲聊 action=chat。排班（如「帮我安排周五下午开会」）：对照已有日程找空闲时段，给 1 个建议时段和理由，action=schedule 且 newTime=建议时段，不要写库，等用户回复「确认」后再 reschedule。建议时段须与用户既有日程前后各留 ≥10 分钟间隔（缓冲），不要紧贴相邻日程起止时间（P1-F，与客户端 schedule.ts 的 SCHED_GAP_BUFFER_MINUTES=10 同一口径）。批量/周期排班（如「把周会固定到每周二上午」「下周一站会、周三下午评审、周五复盘」）时 action=batch：newEvents=[{"title":"会议名","startTime":"YYYY-MM-DD HH:mm"}]，周期会议给未来 4 次具体日期，单次批量最多 5 条，直接排入无需确认；reply 里逐条列出排入时间。当识别到购物意图（买、对比、哪个划算、值不值、求推荐商品、想买东西、预算内选什么）时，action=shopping：输出一份选购分析——拆解需求与预算、列出 2-4 个主流平台/方案的关键差异（价格、售后、物流、口碑要点）、给出明确结论和下一步。实时价格、热点资讯、产品对比等时效性问题会基于联网检索作答并标注来源；检索不可用时基于常识回答并明确标注"价格为参考，以平台实时为准"，绝不谎称是实时联网数据。';

const PLAN_CONTRACT_PROMPT =
  '【排班先提议后执行】识别到排班/调整意图时遵守以下分流：① 纯新建且不超过 5 条 —— 用 action="batch"，newEvents=[{"title":"会议名","startTime":"YYYY-MM-DD HH:mm","endTime":"YYYY-MM-DD HH:mm"}]，直接排入。② 涉及改期/挪动已有日程，或用户要求先看方案再定 —— 用 action="plan"，proposals=[{"title":"会议名","fromTime":"原时间 YYYY-MM-DD HH:mm","toTime":"建议新时间 YYYY-MM-DD HH:mm","endTime":"结束时间","eventId":"已有日程 id（新建时省略）"}]，并在 reply 里说明你把它们挪到了哪些时段。**action="plan" 严禁写库**，只输出方案，等用户在卡片上勾选批准后再由客户端调用 action="applyPlan" 落库。proposals 最多 ' +
  MAX_PLAN_ITEMS +
  ' 条。';

const SHOPPING_DISCIPLINE_PROMPT =
  '【购物文案纪律，违反即为严重错误】① 购物类回复只允许做三类动作：查价、汇总、价保提示，不得承诺或暗示代为操作。② 当回复或用户指令中出现「下单」「购买」「付款」「代付」等意图词时，回复必须包含免责句：「' +
  SHOPPING_DISCLAIMER +
  '」或「' +
  SHOPPING_REFUSE_REPLY +
  '」。③ 严禁出现「已为你下单」「已帮你购买」「已锁定库存」「已付款」「代你支付」等表述，一旦出现会被服务端拦截改写。④ 价格须标注「' +
  SHOPPING_DISCLAIMER_SOURCE +
  '」，涉及已购/待购商品时另附「' +
  SHOPPING_PRICE_GUARD +
  '」。';

const MEMORY_CONTRACT_PROMPT =
  '【记忆抽取】当用户表达了**稳定的个人偏好、习惯或长期事实**（如「我一般上午开会」「我不喝咖啡」「我住在杭州」「叫我老王」）时，在输出 JSON 中额外加一个字段 memories，值为字符串数组，每条形如「偏好在上午开会」「不喝咖啡」，每条不超过 20 字。只抽取跨对话仍然成立的信息，**不要**抽取一次性任务、临时安排或当次对话的琐事（如「明天三点开会」不抽取）。没有值得记住的内容时省略该字段或置为空数组。';

const DEFAULT_SYSTEM_PROMPT =
  BASE_SYSTEM_PROMPT + PLAN_CONTRACT_PROMPT + SHOPPING_DISCIPLINE_PROMPT + MEMORY_CONTRACT_PROMPT;

/** 工作助手模式提示词（mode=work 时按 workAction 选择） */
export const WORK_SYSTEM_PROMPTS: Record<string, string> = {
  summary:
    '你是用户的工作助手。对用户提供的内容做总结：先一句结论，再分点列出核心内容，最后一行给一个行动建议。输出 JSON：{"reply": "总结(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。',
  points:
    '你是用户的工作助手。从用户提供的内容中提取 3-6 条关键要点，每条一行、尽量短；末尾附一行「关键数据」（没有就写「无明显数据」）。输出 JSON：{"reply": "要点(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。',
  advice:
    '你是用户的工作助手。基于用户提供的内容给出 3 条具体可执行的建议，每条说明「做什么、为什么」，不空洞打气。输出 JSON：{"reply": "建议(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。'
};

/** 深度思考模式提示词（deep=true） */
export const DEEP_SYSTEM_PROMPT =
  '你是用户的深度思考伙伴。用户抛出纠结或问题时，帮其拆解：1) 关键矛盾是什么 2) 各选项的利弊 3) 给出一个可执行的下一步。语气克制友好，不空洞打气。输出 JSON：{"reply": "给用户的中文回复(500字内，可分行)", "action": "chat", "targetId": null, "newTime": null}。';

/** 按模式选系统提示（与 chat 云函数分流同口径）；有长期记忆时追加记忆回灌契约 */
export function pickSystemPrompt(opts: {
  work?: { action: string };
  deep?: boolean;
  memories?: string[];
}): string {
  let system: string;
  if (opts.work) system = WORK_SYSTEM_PROMPTS[opts.work.action] || WORK_SYSTEM_PROMPTS.summary;
  else if (opts.deep) system = DEEP_SYSTEM_PROMPT;
  else system = DEFAULT_SYSTEM_PROMPT;
  if (opts.memories && opts.memories.length > 0) system += MEMORY_RECALL_PROMPT;
  return system;
}

/* ---------------- 会话上下文（本地日程/待办 + 记忆） ---------------- */

/** 与 chat 云函数同款的 `我的数据：…\n我的指令：…` 拼接；数据源为本地 dailyPlanStore */
export function buildUserContent(message: string, memories?: string[]): string {
  const plan = readPlan();
  const now = new Date();
  const events = plan.events
    .filter((e) => e && e.status === 'confirmed' && e.title)
    .sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')))
    .slice(0, 5)
    .map((e) => ({ id: e.id, title: e.title, startTime: e.startTime }));
  const todos = plan.todos
    .filter((t) => t && t.status === 'confirmed' && t.title)
    .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))
    .slice(0, 5)
    .map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate }));
  const contextData: Record<string, unknown> = {
    now: `${now.toLocaleDateString('sv-SE')} ${now.toTimeString().slice(0, 5)}`,
    events,
    todos
  };
  if (memories && memories.length > 0) contextData.memories = memories;
  return `我的数据：${JSON.stringify(contextData)}\n我的指令：${message}`;
}

/* ---------------- conversationId（应用自持） ---------------- */

const CONV_KEY = 'llm-conversation-id';

/** 取（没有则生成并持久）本设备的会话路由 id。
 *  刻意**不进** cloudSync 的 SYNC_KEYS：它是路由/计量用的本地 id，不是用户数据，
 *  跨设备同步它会把两台设备的会话混成一个。 */
export function getConversationId(): string {
  try {
    const existing = Taro.getStorageSync(CONV_KEY);
    if (typeof existing === 'string' && existing.length >= 8) return existing;
  } catch {
    /* 存储不可用时退化成内存 id（见下方） */
  }
  const id = 'cv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  try {
    Taro.setStorageSync(CONV_KEY, id);
  } catch {
    /* 持久化失败不阻断对话：id 仍可本地使用 */
  }
  return id;
}

/* ---------------- 模型选择 ---------------- */

let cachedModel: string | null = null;

/** 选一个可用模型：目录里第一个非 disabled 的。
 *  取不到目录 / 目录为空 / 全部 disabled → 返回 null（调用方明确降级），**不硬编码 model id**。
 *  只缓存成功结果：失败与空列表下次照样重试（可能是暂时的）。 */
export async function pickModel(): Promise<string | null> {
  if (cachedModel) return cachedModel;
  const llm = await getCloudLlm();
  if (!llm || typeof llm.models?.list !== 'function') return null;
  try {
    const models = await llm.models.list();
    if (!Array.isArray(models) || models.length === 0) return null;
    const model = models.find((m) => m && typeof m.id === 'string' && m.disabled !== true);
    if (!model) return null;
    cachedModel = model.id;
    return cachedModel;
  } catch (err) {
    console.warn('[cloudLlm] models.list failed:', err);
    return null;
  }
}

/* ---------------- 流式对话 ---------------- */

/** 单次流式调用的整体超时。
 *
 *  2026-10-20 实测（晨报会话接真 cloud.llm）：hy4-preview 是推理模型，
 *  正常 20~25s 出完（reasoning_content 先跑、content 最后到）。但偶发
 *  **流不终止**：SSE 无 [DONE]、无 error、SDK 迭代器 pending ——
 *  `await it.next()` 永远挂着，调用方（askAssistant）无限等待，
 *  用户零反馈、零兜底、零错误日志（静默挂死，实测 75s+ 无任何反应）。
 *
 *  60s = 观测到的正常最慢（25s）× 2.4 余量。超时后由调用方既有兜底链处理
 *  （callChatOrExtract → 本地代理 → mock + markDegraded），**不在这里静默**。 */
const CLOUD_LLM_TIMEOUT_MS = 60_000;

/** 熔断时长：一次超时/断流后，这段时间内直接返 null、不再打云端。
 *
 *  为什么需要：askAssistant 的降级路径是 apiChatStream(null) → apiChat →
 *  callChatOrExtract → chatViaCloudLlm，会**二次调用**本函数。若服务端正在
 *  卡死，二次调用同样超时 → 用户要等 2×60s。熔断让第二次立即失败，
 *  把总等待压回一次超时。 */
const CLOUD_LLM_COOLDOWN_MS = 30_000;
let cloudLlmCooldownUntil = 0;

export interface CloudLlmChatOpts {
  /** 系统提示（调用方用 pickSystemPrompt 选；空值直接拒绝 —— system 必须在 messages[0]） */
  system: string;
  /** 用户消息全文（buildUserContent 的产物） */
  userContent: string;
  /** 追加的历史消息（应用自持的多轮上下文；本产品当前为单轮，留作扩展） */
  history?: LlmMessage[];
  signal?: AbortSignal;
}

/**
 * 流式调用 cloud.llm 并把完整回复收集回来。
 *
 * 关于「打字机」：模型输出是 JSON（reply/action/… 契约），**不能**把原始 JSON 流
 * 直接灌进气泡。因此这里先把整条流收完、解析出 reply，再由调用方按 onDelta 契约
 * 做客户端打字机（apiChatStream 内部完成）—— 视觉效果与真流式一致，且绝不露出 JSON。
 * 已收到部分内容时若流中断，保留已渲染文本由调用方提示「重新生成」（SDK 抛 gateway_stream_interrupted）。
 *
 * 返回完整文本；任何失败返回 null（内部已 warn，调用方降级）。
 */
export async function cloudLlmChat(opts: CloudLlmChatOpts): Promise<string | null> {
  const system = (opts.system || '').trim();
  if (!system) {
    // 结构上不可能发生（调用方都用 pickSystemPrompt），但这是硬契约：宁可拒绝也不发无 system 的请求
    console.error('[cloudLlm] refused: empty system prompt');
    return null;
  }
  if (Date.now() < cloudLlmCooldownUntil) {
    // 熔断期内：不重复打一个刚卡死过的服务端。兜底链照常走，用户侧有降级提示。
    console.warn('[cloudLlm] cooldown after recent failure, skip cloud call');
    return null;
  }
  const llm = await getCloudLlm();
  if (!llm) return null;
  const model = await pickModel();
  if (!model) {
    console.warn('[cloudLlm] no selectable model (empty or all-disabled directory)');
    return null;
  }
  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    ...(opts.history || []),
    { role: 'user', content: opts.userContent }
  ];
  // 超时用「race + signal」双保险：race 是客户端硬保证（SDK 可能根本不响应 signal）；
  // signal 尽量让底层连接也被中断，避免超时后 SDK 仍在后台收流。
  const timeoutSignal = AbortSignal.timeout(CLOUD_LLM_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  const collect = async (): Promise<string> => {
    let text = '';
    const stream = await llm.chat.completions.create({
      model,
      messages,
      stream: true,
      conversationId: getConversationId(),
      signal
    });
    // 手动驱动异步迭代器而不用 for await：不依赖 regenerator/构建目标对 ES2018 的支持，
    // 且能对「流已开始但中途断」保留已收到内容（SDK 抛 gateway_stream_interrupted）。
    const it = stream[Symbol.asyncIterator]();
    for (;;) {
      const step = await it.next();
      if (step.done) break;
      const chunk = step.value;
      const choice = chunk.choices && chunk.choices[0] ? chunk.choices[0] : undefined;
      const delta = choice ? choice.delta : undefined;
      // content 正常累积；reasoning_content 是思考过程，与可见回复分开，不混入 text
      if (delta && typeof delta.content === 'string' && delta.content) text += delta.content;
    }
    return text;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      collect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`cloud.llm stream timeout after ${CLOUD_LLM_TIMEOUT_MS}ms`)), CLOUD_LLM_TIMEOUT_MS);
      })
    ]);
    if (!text) return null;
    // 记账只计**成功完成**的调用：失败attempt不耗用户免费额度（网络抖动不该扣配额）
    void llmEventInsert('chat').catch(() => {});
    return text;
  } catch (err) {
    console.warn('[cloudLlm] stream failed:', err);
    // 超时与断流都进熔断：二者都意味着「这次云端调用不可靠」，短期内重试大概率同样失败
    cloudLlmCooldownUntil = Date.now() + CLOUD_LLM_COOLDOWN_MS;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 解析 LLM 的 JSON 回复契约（与 chat 云函数 safeParse 同口径：失败返回 null） */
export function safeParseReply<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** chat 云函数返回契约里本模块会透传的字段 */
export interface CloudChatResult {
  reply: string;
  action: string;
  proposals?: unknown[];
  memories?: string[];
}

/**
 * H5 对话主路径（2026-10-13）：cloud.llm 直连，替代「本地 llm-proxy → 规则 mock」链。
 * 入参与 apiChat 一致；任何一步失败返回 null，由调用方按既有链降级
 * （本地代理 → mock），并在降级登记表里留痕。
 */
export async function chatViaCloudLlm(data?: {
  message?: string;
  deep?: boolean;
  mode?: string;
  workAction?: string;
  memories?: string[];
}): Promise<CloudChatResult | null> {
  const message = String((data && data.message) || '');
  if (!message.trim()) return null;
  const memories = data && Array.isArray(data.memories) ? data.memories : [];
  const system = pickSystemPrompt({
    work: data && data.mode === 'work' && data.workAction ? { action: data.workAction } : undefined,
    deep: !!(data && data.deep),
    memories
  });
  const raw = await cloudLlmChat({ system, userContent: buildUserContent(message, memories) });
  if (!raw) return null;
  const parsed = safeParseReply<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) return null;
  const out: CloudChatResult = {
    reply: parsed.reply,
    action: typeof parsed.action === 'string' && parsed.action ? parsed.action : 'chat'
  };
  if (Array.isArray(parsed.proposals)) out.proposals = parsed.proposals;
  if (Array.isArray(parsed.memories)) out.memories = parsed.memories.filter((m): m is string => typeof m === 'string');
  return out;
}

/** 客户端打字机：把定稿文本按小分片回调，视觉上与真流式一致（不造假数据，只复刻动效） */
export function typewriter(
  text: string,
  onDelta: (chunk: string) => void,
  opts: { chunkSize?: number; intervalMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const chunkSize = opts.chunkSize || 2;
  const intervalMs = opts.intervalMs || 24;
  return new Promise((resolve) => {
    let i = 0;
    const timer = setInterval(() => {
      if (opts.signal?.aborted || i >= text.length) {
        clearInterval(timer);
        resolve();
        return;
      }
      onDelta(text.slice(i, i + chunkSize));
      i += chunkSize;
    }, intervalMs);
  });
}

/* ---------------- 收件箱提取（extract）---------------- */

type CollectionItemSourceType = 'article' | 'message' | 'link';

/**
 * extract 的系统提示。
 *
 * 契约与 ExtractResult（src/types/index.ts:117）严格对齐，**不用类型断言蒙混** ——
 * 下游 inbox/index.tsx 会直接读 result.events[].title / startTime，字段缺失会在渲染时炸。
 * 时间一律要求 'YYYY-MM-DD HH:mm'：日程页与 formatEventTime 都按这个形状解析。
 *
 * ⚠️ 为什么只处理文字、不声称能看图：cloud.llm 的 LlmMessage.content 是 **string**
 *   （cloudAuth.ts:290），SDK 这条通道**不支持多模态**。截图（base64）传不过去。
 *   所以截图场景必须**明说做不到**，绝不能让模型编一个「从截图识别到的时间」——
 *   那是本产品反复强调的不诚实（见 src/data/chat.ts 里删掉硬编码价格的那次修复）。
 */
const EXTRACT_SYSTEM_PROMPT =
  '你是私人晨报助理的文本信息提取器。用户会给你一段杂乱文本（可能来自聊天转发、邮件、通知、备忘录）。' +
  '从这段文本里提取结构化条目，**只提取文本里真实存在的信息，绝不编造**：\n' +
  '① events（日程）：有明确时间与动作的安排。title 用原文措辞（去掉「提醒我」之类前缀）；' +
  'startTime/endTime 为 "YYYY-MM-DD HH:mm"；只有日期没有具体时刻时，该时刻留空字符串 ""，' +
  '**不要臆造一个时间点**。\n' +
  '② todos（待办）：需要去做的事，没有截止时间时 dueDate 留空字符串 ""。\n' +
  '③ collection（收藏）：值得留存的链接/文章/长文摘要，此时给出 summary 与 tags（1-3 个短标签）。\n' +
  '④ note：文本里**无法归类**的有用信息原文；没有就省略该字段。\n' +
  '每条的 source 填原文前 50 字。文本里没有任何可提取内容时，三个数组都返回空数组。\n' +
  '输出 JSON（不要 markdown 代码块、不要任何解释文字）：' +
  '{"events":[{"title":"","startTime":"","endTime":"","location":"","source":""}],' +
  '"todos":[{"title":"","dueDate":"","source":""}],' +
  '"collection":{"title":"","summary":"","tags":[],"url":"","sourceType":"article|message|link"},' +
  '"note":""}';

/** 提取结果的原始形状（字段都还没过校验） */
interface RawExtract {
  events?: unknown;
  todos?: unknown;
  collection?: unknown;
  note?: unknown;
}

/** 时间字符串：只接受 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DDTHH:mm'（后者换空格）。非法 → ''。 */
function normalizeTime(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return '';
  const [, y, mo, d, h, mi] = m;
  // 越界值直接丢弃：把 2026-13-45 交给日历页只会渲染出一个不存在的日期
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  if (Number(h) > 23 || Number(mi) > 59) return '';
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** 短文本：非字符串→''，超长截断（标题类字段被模型塞进整段原文是常见失败模式）。 */
function shortText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 把模型返回的 JSON 逐字段校成 ExtractResult。
 *
 * 为什么必须逐字段校验而不是 `as ExtractResult`：
 *   模型输出不可信（可能缺字段、类型错、时间格式乱、塞 HTML）。一个 `as` 断言等于
 *   把所有风险推迟到渲染期炸掉，而收件箱是核心链路。这里宁可**丢掉一条坏条目**，
 *   也不能让整页崩 —— 单条无效就跳过，全部无效返回 null（交给上层降级）。
 */
function coerceExtract(parsed: RawExtract): ExtractResult | null {
  const events: ExtractResult['events'] = [];
  if (Array.isArray(parsed.events)) {
    for (const it of parsed.events) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const title = shortText(o.title, 60);
      if (!title) continue; // 没标题的日程没有意义
      const endTime = normalizeTime(o.endTime);
      const location = shortText(o.location, 40);
      const source = shortText(o.source, 50);
      // startTime 缺失也保留：用户粘贴的常是「周四下午跟客户吃饭」这种，
      // 丢掉是信息损失，留给用户手动补时间。
      events.push({
        title,
        startTime: normalizeTime(o.startTime),
        ...(endTime ? { endTime } : {}),
        ...(location ? { location } : {}),
        ...(source ? { source } : {})
      });
    }
  }

  const todos: ExtractResult['todos'] = [];
  if (Array.isArray(parsed.todos)) {
    for (const it of parsed.todos) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, unknown>;
      const title = shortText(o.title, 60);
      if (!title) continue;
      const dueDate = normalizeTime(o.dueDate);
      const source = shortText(o.source, 50);
      todos.push({ title, ...(dueDate ? { dueDate } : {}), ...(source ? { source } : {}) });
    }
  }

  let collection: ExtractResult['collection'];
  if (parsed.collection && typeof parsed.collection === 'object' && !Array.isArray(parsed.collection)) {
    const o = parsed.collection as Record<string, unknown>;
    const title = shortText(o.title, 60);
    const summary = shortText(o.summary, 500);
    if (title && summary) {
      const tags = (Array.isArray(o.tags) ? o.tags : []).map((t) => shortText(t, 12)).filter(Boolean).slice(0, 3);
      const rawType = shortText(o.sourceType, 20);
      const sourceType: CollectionItemSourceType =
        rawType === 'article' || rawType === 'link' || rawType === 'message' ? rawType : 'message';
      const url = shortText(o.url, 300);
      collection = { title, summary, tags, ...(url ? { url } : {}), sourceType };
    }
  }

  const note = shortText(parsed.note, 200);
  // 三者全空且无备注 → 视为「模型没提取到东西」，返回 null 让上层降级，
  // 而不是给用户一个空结果页让他以为「确实没有可提取的内容」。
  if (events.length === 0 && todos.length === 0 && !collection && !note) return null;

  return { events, todos, ...(collection ? { collection } : {}), ...(note ? { note } : {}) };
}

/**
 * H5 提取主路径（2026-10-15）：收件箱文本 → cloud.llm → 结构化日程/待办/收藏。
 *
 * 修复的正是 2026-10-14 测试报告 P1-02：`callChatOrExtract` 只对 name==='chat'
 * 走云端，`extract` 直接打 `localhost:8138`（线上不可达）→ 回退 `src/data/extract.ts`
 * 的固定示例（恒返回「产品评审会 / 评审前更新演示文稿」）。于是 H5 生产环境的
 * 「AI 提取」**一直是假数据**，且因 UI 零宽此前连按钮都点不到。
 *
 * 与 chat 的差别：
 *   · 不带 `我的数据：…` 上下文 —— 提取是从原文抽结构，不是回答问题，带上下文反而干扰。
 *   · **图片不参与**：LlmMessage.content 是 string，这条通道不支持多模态。
 *     带图且无字时返回 null（上层降级到本地 mock 的视觉识别），**不假装看懂了图**。
 *   · 记账复用 cloudLlmChat 内部的 `llmEventInsert('chat')`，不新增 kind
 *     （cloudDb 的 LlmEventKind 只允许 'chat' | 'voice'，服务端按此计费）。
 */
export async function extractViaCloudLlm(data?: {
  content?: string;
  images?: string[];
}): Promise<ExtractResult | null> {
  const content = String((data && data.content) || '').trim();
  const imageCount = data && Array.isArray(data.images) ? data.images.length : 0;
  if (!content && imageCount === 0) return null;
  if (!content) {
    console.warn('[cloudLlm] extract: only images given — cloud.llm channel has no multimodal support, skip');
    return null;
  }
  // 相对日期（明天下午/下周五）需要基准，模型自己不知道今天几号
  const now = new Date();
  const today = now.toLocaleDateString('sv-SE'); // YYYY-MM-DD，不受 locale 影响
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const userContent =
    `现在的日期时间：${today} ${hm}\n` +
    '请以该时间为基准推算原文里的相对日期（如「明天下午」「下周五」）。\n' +
    '待提取原文：\n"""\n' +
    content.slice(0, 6000) +
    '\n"""';
  const raw = await cloudLlmChat({ system: EXTRACT_SYSTEM_PROMPT, userContent });
  if (!raw) return null;
  const parsed = safeParseReply<RawExtract>(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  return coerceExtract(parsed);
}