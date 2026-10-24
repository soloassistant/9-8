import Taro from '@tarojs/taro';
import type { LedgerBudget, LedgerCategory, LedgerEntry } from '@/types';
import {
  addCategory as ledgerAddCategory,
  addEntry as ledgerAddEntry,
  ensureCategories as ledgerEnsureCategories,
  exportLedgerData as ledgerExportData,
  loadBudget as ledgerLoadBudget,
  loadCategories as ledgerLoadCategories,
  loadEntries as ledgerLoadEntries,
  removeCategory as ledgerRemoveCategory,
  removeEntry as ledgerRemoveEntry,
  saveBudget as ledgerSaveBudget,
  updateEntry as ledgerUpdateEntry
} from '@/data/ledger';
/** 导出结果四态（H5 真下载 / weapp 剪贴板降级 / 空数据 / 失败），
 *  双端能力差异的依据见 data/ledger.ts 的导出段注释 */
import type { LedgerExportResult } from '@/data/ledger';
/** 仅取类型：schedule.ts 反向依赖 api.ts，用 import type 避免运行时循环依赖 */
import type { PlanProposalRaw } from '@/utils/schedule';
import { setTodoStatus } from '@/data/dailyPlan';
import { normalizeVideoItems } from '@/utils/videoNews';
import type { VideoNewsItem } from '@/utils/videoNews';
import { recordUsage } from '@/utils/usageLog';
import { callFunction, chatCloudStream } from './cloud';
import type { ChatStreamHooks, ChatStreamResult } from './cloud';
import { invoke, isWeapp } from './dataSource';
import { getSession } from './cloudAuth';
import { buildProfileFromSession, writeProfileSettings } from './localProfile';
import type {
  Briefing,
  CollectionItem,
  ExtractResult,
  HotspotNews,
  CreateOrderResult,
  PayChannel,
  PayOrder,
  Usage,
  UserProfile
} from '../types';

/** 用户档案 —— **两端来源不同**。
 *
 *  · 小程序：`login` 云函数，身份由微信提供（openid 真实，档案在服务端）。
 *  · H5：该云函数不在 dataSource 的 RPC 白名单内（H5 取不到 getWXContext().OPENID），
 *    走它必然落到 src/data/login.ts 的 mock，昵称恒为「晨友」且与登录身份无关。
 *    故 H5 改为「真会话 + 本地可同步设置」，见 services/localProfile 的说明。
 *
 * 取不到会话时**抛错**（不返回假档案）：store 会提示初始化失败，
 * 这比静默给一个「看起来登录好了」的假档案诚实。 */
export async function apiLogin(): Promise<UserProfile> {
  if (isWeapp) return callFunction<UserProfile>('login');
  return buildProfileFromSession(await getSession());
}

/** AI 提取转发内容/截图 → 日程/待办/收藏（images 为 base64 数组，不含 dataURL 前缀） */
export function apiExtract(payload: { content?: string; images?: string[] }): Promise<ExtractResult> {
  return callFunction<ExtractResult>('extract', payload);
}

/** 确认提取结果入库 */
export function apiConfirmItem(payload: {
  events: ExtractResult['events'];
  todos: ExtractResult['todos'];
  collection?: ExtractResult['collection'];
}): Promise<{ saved: number }> {
  return callFunction<{ saved: number }>('confirmItem', payload);
}

/** 待办状态确定性写入（不经过 LLM 对话通道）。
 *  H5 直写本地 plan 并回读校验；weapp 调 todoStatus 云函数（服务端按 _id + openid 收敛）。
 *  失败一律返回 ok:false，调用方**不得**据此更新 UI —— 先改 UI 再写库就是「假完成」。 */
export async function apiTodoSetStatus(input: {
  id: string;
  status: 'done' | 'confirmed';
}): Promise<{ ok: boolean; reason?: string }> {
  if (!isWeapp) return setTodoStatus(input.id, input.status);
  try {
    const res = await callFunction<{ ok?: boolean; reason?: string }>('todoStatus', input);
    // 云函数契约是裸业务体 { ok, reason }：形状不对按调用失败处理，不能把 undefined 当成功
    if (!res || typeof res.ok !== 'boolean') return { ok: false, reason: 'call_failed' };
    return { ok: res.ok, reason: res.reason };
  } catch (err) {
    console.warn('[API] todoStatus call failed:', err);
    return { ok: false, reason: 'call_failed' };
  }
}

/** 获取今日晨报 */
export function apiGetBriefing(): Promise<Briefing> {
  return callFunction<Briefing>('getBriefing');
}

/** 视频新闻（B站热榜第 1 条，公开内容免登录）。
 *  失败（云函数不可达/超时）抛错由调用方降级为「不渲染该卡片」——
 *  不提供本地 mock：视频新闻无法诚实地伪造，宁缺毋假。 */
export async function apiGetVideoNews(): Promise<VideoNewsItem[]> {
  const raw = await callFunction<unknown>('webSearch', { action: 'videoNews' });
  return normalizeVideoItems(raw);
}

/** 工作助手动作 */
export type WorkAction = 'summary' | 'points' | 'advice';

/** 语音/文字对话（deep=true 深度思考；work 传入时进入工作助手模式：总结/要点/建议；image 为 AI 附带图片）
 *  action='plan' 时附带 proposals（排班方案原文，云侧不写库）；
 *  memories 为 AI 抽取的长期偏好（M-03，由 utils/memory.ts 落库）；
 *  memories 入参为记忆回灌：发消息时带上用户长期记忆，服务端注入上下文供模型遵守 */
export function apiChat(
  message: string,
  type: 'text' | 'voice' = 'text',
  deep = false,
  work?: { action: WorkAction },
  memories?: string[]
): Promise<{
  reply: string;
  action: string;
  image?: string;
  proposals?: PlanProposalRaw[];
  memories?: string[];
}> {
  return callFunction<{
    reply: string;
    action: string;
    image?: string;
    proposals?: PlanProposalRaw[];
    memories?: string[];
  }>('chat', {
    message,
    type,
    deep,
    mode: work ? 'work' : undefined,
    workAction: work ? work.action : undefined,
    memories
  });
}

/**
 * H5 AI 流式对话（F-03）：cloud.llm 流式收集 + 客户端打字机增量回调，返回最终 reply/action；
 * 返回 null = 云端 LLM 不可用（未登录 / 无可用模型 / 流失败），调用方降级 apiChat 整段。
 * weapp 端受云函数非流式限制维持整段返回。
 * memories 为记忆回灌：随请求进入 system 契约与用户上下文。
 * 2026-10-24：返回类型由内联 `{reply, action}` 升级为 ChatStreamResult —— 上游
 * chatCloudStream 已透传 proposals（排班候选）/memories（记忆条目），包装层注解
 * 没同步，导致调用方读 streamed.proposals 编译不过（TS2339 ×7）。
 */
export function apiChatStream(
  message: string,
  deep: boolean,
  onDelta: (chunk: string) => void,
  memories?: string[],
  hooks?: ChatStreamHooks
): Promise<ChatStreamResult | null> {
  return chatCloudStream(message, deep, onDelta, memories, hooks);
}

/** 收藏列表 */
export function apiGetLibrary(): Promise<CollectionItem[]> {
  return callFunction<CollectionItem[]>('getLibrary');
}

/** 今日热点资讯（v2.0，来源强制标注；云函数就绪前双端走本地 mock） */
export function apiGetHotspot(): Promise<HotspotNews[]> {
  return callFunction<HotspotNews[]>('getHotspot');
}

/** 全网资讯搜索（F29）：走 webSearch 云函数（Bing News RSS）。
 *  2026-10-05 起 H5 也走真后端 —— 经 dataSource 转到云服务 database.rpc，
 *  此前这里直接 `return null`，等于 H5 的全网搜索从来没真正工作过。 */
export async function apiNewsSearch(keyword: string): Promise<HotspotNews[] | null> {
  const kw = keyword.trim();
  if (!kw) return [];
  try {
    const payload = (await invoke('webSearch', { action: 'searchNews', keyword: kw.slice(0, 30) })) as {
      code: number;
      data: HotspotNews[] | null;
      message?: string;
    };
    if (payload && payload.code === 0 && Array.isArray(payload.data)) {
      // 功能记账：`code===0` 且是数组才算"真拿到结果"；下面两条失败分支都不记。
      recordUsage('search');
      return payload.data;
    }
    console.warn('[api] newsSearch bad payload:', payload && payload.message);
    return null;
  } catch (err) {
    console.warn('[api] newsSearch failed:', err);
    return null;
  }
}

/** 资讯反馈（F22）：记录 👍/👎，驱动内容瘦身；本地持久化 + 云端落库 */
export function apiNewsFeedback(id: string, feedback: 'up' | 'down'): Promise<{ id: string; feedback: 'up' | 'down' }> {
  // 本地持久化（双端即时生效）
  try {
    const raw = Taro.getStorageSync('newsFeedback') || {};
    raw[id] = feedback;
    Taro.setStorageSync('newsFeedback', raw);
  } catch (err) {
    console.warn('[api] newsFeedback persist failed:', err);
  }
  // 云端落库；失败不阻塞本地标记（双端都会尝试，登录态/网络不通时静默降级为纯本地）
  return invoke('webSearch', { action: 'feedback', id, feedback })
    .then(() => ({ id, feedback }))
    .catch((err) => {
      console.warn('[api] newsFeedback cloud sync failed:', err);
      return { id, feedback };
    });
}

/**
 * 用户主动反馈（2026-10-24 新增）—— 补齐「有问题怎么办」的主动通道。
 *
 * 通道矩阵（与 dataSource 的白名单口径一致）：
 *   · weapp：调 feedback 云函数落 feedback 集合（含 openid 归属、类型白名单、长度上限）；
 *   · H5：**没有** feedback 的 RPC 通道 —— 应用库未注册对应 PG 函数，白名单也不放行
 *     （放行只会得到 rpc-not-allowed 或 404）。这里直接返回 false，
 *     由 UI 转为「复制内容 + 邮件 support@morningbrief.cn」的诚实降级路径。
 *
 * 返回值语义：true = 已落库；false = 未落库（调用方必须让用户看见，不能显示"提交成功"）。
 */
export async function apiSubmitFeedback(input: {
  type: 'suggestion' | 'data' | 'account' | 'other';
  content: string;
  contact?: string;
  page?: string;
}): Promise<boolean> {
  if (!isWeapp) return false;
  try {
    const res = (await invoke('feedback', {
      type: input.type,
      content: input.content,
      contact: input.contact || '',
      page: input.page || ''
    })) as { ok?: boolean } | null;
    return Boolean(res && res.ok === true);
  } catch (err) {
    // 生产构建会剔除 console.warn，故失败路径同时由返回值告诉 UI（不依赖日志）
    console.warn('[api] submitFeedback failed:', err);
    return false;
  }
}

/** 更新习惯设置。
 *
 * H5 同样不走云函数（原因同 apiLogin）：`updateSettings` 也不在白名单内，
 * mock 版只 `console.info` 不落盘 → 用户改了昵称/推送时间/偏好，刷新即丢。
 * H5 改为写 `user-settings`（已在 cloudSync 同步表内，写入即跨设备生效），
 * 再用真会话重建档案返回，保证返回值与下次 init 读到的一致。 */
export async function apiUpdateSettings(
  payload: Partial<Pick<UserProfile, 'nickname' | 'briefingTime' | 'preferences'>>
): Promise<UserProfile> {
  if (!isWeapp) {
    // 先确认会话再落盘：反过来的话，会话已失效时设置已经写进本地却返回失败，
    // 用户会看到「保存失败」但值其实变了 —— 下次登录又会读到那个"失败"的值。
    // ⚠️ 只判"有没有会话"，**不判 `user.id` 是否为空** —— 后者是 SDK 允许的合法状态
    //   （userFromSessionPayload: `id: typeof r.sub === 'string' ? r.sub : ''`），
    //   据此拒绝会让登录用户改不了设置。
    const session = await getSession();
    if (!session) throw new Error('no-cloud-session');
    writeProfileSettings(payload);
    // buildProfileFromSession 内部会重读刚写入的设置，返回值即刷新后的档案
    return buildProfileFromSession(session);
  }
  return callFunction<UserProfile>('updateSettings', payload);
}

/** 用量查询 */
export function apiGetUsage(): Promise<Usage> {
  return callFunction<Usage>('getUsage');
}

/** 创建订阅订单（三通道路由） */
export interface CreateOrderPayload {
  planId: PayOrder['planId'];
  channel: PayChannel;
  /** alipay 通道：buyerId（2088 开头 userId） */
  buyerId?: string;
  /** douyin 通道：openid（服务端 code2Session 换得） */
  openid?: string;
  /** callFunction 的 Record<string, unknown> 索引签名要求 */
  [key: string]: unknown;
}
export function apiCreateOrder(payload: CreateOrderPayload): Promise<CreateOrderResult> {
  return callFunction<CreateOrderResult>('createOrder', payload as unknown as Record<string, unknown>);
}

/** 注销账号并删除全部数据（F18） */
export function apiDeleteAccount(): Promise<{ deleted: boolean }> {
  return callFunction<{ deleted: boolean }>('deleteAccount');
}

/* ------------------------------------------------------------------ */
/* 排班「先提议后执行」（S-01）                                          */
/*                                                                      */
/* 约定：这里只放「落库所需的最小可用类型」。B1 批次的 src/utils/         */
/* schedule.ts 会 import 下面这些类型并在其基础上扩展（busyness / reason */
/* / score / conflict 等字段），本文件不再重复定义富类型，避免冲突。       */
/* ------------------------------------------------------------------ */

/** 候选时段（最小集：只保留起止时间，'YYYY-MM-DD HH:mm'） */
export interface SlotCandidate {
  startTime: string;
  endTime: string;
}

/** 排班方案条目（最小集） */
export interface PlanProposalItem {
  key?: string;
  title: string;
  /** 原时间（改期场景；新建时为空） */
  fromTime?: string;
  /** 新时间 */
  toTime?: string;
  endTime?: string;
  /** 改期场景为现有日程 id；新建场景为空 */
  eventId?: string;
  /** 默认全选（PRD S-01） */
  checked?: boolean;
  candidates?: SlotCandidate[];
}

/** 排班方案（AI 只提议，勾选后才由 apiApplyPlan 落库） */
export interface PlanProposal {
  id?: string;
  /** 卡片头部标题 */
  title?: string;
  /** 是否走了扩窗 / 次日兜底 */
  extended?: boolean;
  createdAt?: string;
  items: PlanProposalItem[];
}

/** 落库单条日程 */
export interface PlanApplyEvent {
  /** 有值 = 改期（update）；无值 = 新建（add） */
  eventId?: string;
  title: string;
  /** 'YYYY-MM-DD HH:mm' */
  startTime: string;
  endTime?: string;
}

/** apiApplyPlan 入参（兼容 schedule.ts 的 applyProposal() 返回值直接透传） */
export interface PlanApplyPayload {
  events: PlanApplyEvent[];
  /** 来源方案 id，便于云函数侧溯源 */
  proposalId?: string;
  /** schedule.ts applyProposal() 的 count，透传时忽略 */
  count?: number;
}

/** apiApplyPlan 出参 */
export interface PlanApplyResult {
  /** 实际写入条数 */
  saved: number;
  /** 写入 / 更新的日程 id 列表（云函数未返回时为空数组） */
  ids: string[];
  /** false = 落库失败（云函数未就绪等），调用方据此决定是否提示 */
  ok: boolean;
}

/**
 * 排班方案落库（S-01）：eventId 存在走 update，否则 add。
 * 走 chat 云函数的 action='applyPlan' 契约（本轮不新增云函数）；
 * 任何失败 console.warn 后降级返回 ok=false，不抛错阻断对话。
 */
export async function apiApplyPlan(payload: PlanApplyPayload): Promise<PlanApplyResult> {
  const raw = Array.isArray(payload.events) ? payload.events : [];
  const events = raw.filter((e) => e && e.title && e.startTime);
  if (events.length === 0) {
    // ⚠️ 必须区分两种"空"：
    //  · 调用方**根本没传**条目 → 合法的 no-op，返回 ok:true；
    //  · 调用方传了条目、但**全部**因缺 title/startTime 被过滤掉 → 这是失败。
    //    若此处返回 ok:true，调用方会据此宣称「已落库」——例如把习惯守护记录标记为
    //    「已撤销」并销毁重试入口，而远端**一个字都没写**，用户既没还原也失去重试能力。
    if (raw.length > 0) {
      console.warn('[api] applyPlan: all events malformed (missing title/startTime), nothing written');
      return { saved: 0, ids: [], ok: false };
    }
    return { saved: 0, ids: [], ok: true };
  }
  try {
    const res = await callFunction<Partial<PlanApplyResult> | null>('chat', {
      action: 'applyPlan',
      proposalId: payload.proposalId,
      events
    });
    const saved = res && typeof res.saved === 'number' ? res.saved : events.length;
    const ids = res && Array.isArray(res.ids) ? res.ids : [];
    return { saved, ids, ok: true };
  } catch (err) {
    console.warn('[api] applyPlan failed:', err);
    return { saved: 0, ids: [], ok: false };
  }
}

/** 购物清单：list/add/toggleBought/remove/addPrice（真机用云函数按 openid 隔离；H5 走本地 mock） */
export interface ShoppingPrice {
  platform: string;
  price: number;
}
export interface ShoppingItem {
  id: string;
  name: string;
  targetPrice?: number;
  link?: string;
  bought: boolean;
  createdAt: string;
  prices: ShoppingPrice[];
  /** 上次已提醒的价格（P-01 降价提醒去重，由 utils/price.ts 维护） */
  lastNotifiedPrice?: number;
}
export function apiShoppingList(): Promise<ShoppingItem[]> {
  return callFunction<ShoppingItem[]>('shopping', { action: 'list' });
}
export function apiShoppingAdd(payload: { name: string; targetPrice?: number }): Promise<ShoppingItem | null> {
  return callFunction<ShoppingItem | null>('shopping', { action: 'add', ...payload });
}
export function apiShoppingToggleBought(id: string): Promise<{ id: string; bought: boolean } | null> {
  return callFunction<{ id: string; bought: boolean } | null>('shopping', { action: 'toggleBought', id });
}
export function apiShoppingRemove(id: string): Promise<{ id: string } | null> {
  return callFunction<{ id: string } | null>('shopping', { action: 'remove', id });
}
export function apiShoppingAddPrice(
  id: string,
  platform: string,
  price: number
): Promise<{ id: string; prices: ShoppingPrice[] } | null> {
  return callFunction<{ id: string; prices: ShoppingPrice[] } | null>('shopping', {
    action: 'addPrice',
    id,
    platform,
    price
  });
}

/** 设置心理价位（P-01 降价提醒阈值） */
export function apiShoppingSetTargetPrice(
  id: string,
  price: number
): Promise<{ id: string; targetPrice: number } | null> {
  return callFunction<{ id: string; targetPrice: number } | null>('shopping', {
    action: 'setTargetPrice',
    id,
    price
  });
}

/** 清除心理价位（P-01） */
export function apiShoppingClearTargetPrice(id: string): Promise<{ id: string } | null> {
  return callFunction<{ id: string } | null>('shopping', { action: 'clearTargetPrice', id });
}

/* ---------------- 记账（v2.0 F23）----------------
 * 形态与购物清单一致：H5 走 src/data/ledger.ts 的本地实现（callFunction 会先试
 * invoke，而 ledger 不在 RPC 白名单，必然失败后落到本地）。
 * 记账是**用户真实本地数据**，故已在 services/cloud.ts 的 REAL_LOCAL_ACTIONS
 * 语义内处理 —— 不登记降级，UI 不会误标成「演示数据」。 */
export type { LedgerBudget, LedgerCategory, LedgerEntry, LedgerKind, LedgerSummary } from '@/types';
/* ⚠️ `export type { … } from` **不会**把类型引入本模块作用域，
   下面的函数签名要用它们，必须另写一条import —— 否则 tsc 报
   "Cannot find name 'LedgerEntry'"（2026-10-15 踩到）。 */

export interface LedgerAddPayload {
  amount: number;
  kind: 'expense' | 'income';
  categoryId: string;
  note?: string;
  date?: string;
}

export function apiLedgerInit(): void {
  ledgerEnsureCategories();
}
export function apiLedgerEntries(): Promise<LedgerEntry[]> {
  return Promise.resolve(ledgerLoadEntries());
}
export function apiLedgerCategories(): Promise<LedgerCategory[]> {
  return Promise.resolve(ledgerLoadCategories());
}
export function apiLedgerBudget(): Promise<LedgerBudget> {
  return Promise.resolve(ledgerLoadBudget());
}
export function apiLedgerAdd(payload: LedgerAddPayload): Promise<LedgerEntry | null> {
  return Promise.resolve(ledgerAddEntry(payload));
}
export function apiLedgerUpdate(
  id: string,
  patch: Partial<Pick<LedgerEntry, 'amount' | 'categoryId' | 'note' | 'date'>>
): Promise<LedgerEntry | null> {
  return Promise.resolve(ledgerUpdateEntry(id, patch));
}
export function apiLedgerRemove(id: string): Promise<boolean> {
  return Promise.resolve(ledgerRemoveEntry(id));
}
export function apiLedgerSaveBudget(budget: LedgerBudget): Promise<LedgerBudget> {
  return Promise.resolve(ledgerSaveBudget(budget));
}
export function apiLedgerAddCategory(
  name: string,
  kind: 'expense' | 'income',
  icon?: string
): Promise<LedgerCategory | null> {
  return Promise.resolve(ledgerAddCategory(name, kind, icon));
}
export function apiLedgerRemoveCategory(id: string): Promise<boolean> {
  return Promise.resolve(ledgerRemoveCategory(id));
}
/** 导出记账数据（CSV/JSON）。四态语义与双端能力差异见 data/ledger.ts。 */
export function apiLedgerExport(format: 'csv' | 'json'): Promise<LedgerExportResult> {
  return ledgerExportData(format);
}
