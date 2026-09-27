import Taro from '@tarojs/taro';
import { callFunction, chatLocalStream } from './cloud';
/** 仅取类型：schedule.ts 反向依赖 api.ts，用 import type 避免运行时循环依赖 */
import type { PlanProposalRaw } from '@/utils/schedule';
import type {
  Briefing,
  CollectionItem,
  ExtractResult,
  HotspotNews,
  PayOrder,
  Usage,
  UserProfile
} from '../types';

/** 登录（静默获取 openid + 用户档案） */
export function apiLogin(): Promise<UserProfile> {
  return callFunction<UserProfile>('login');
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

/** 获取今日晨报 */
export function apiGetBriefing(): Promise<Briefing> {
  return callFunction<Briefing>('getBriefing');
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
 * H5 AI 流式对话（F-03）：onDelta 打字机增量回调，返回最终 reply/action；
 * 返回 null = 流式不可用（weapp / 代理未启动 / 读取失败），调用方降级 apiChat 整段。
 * weapp 端受云函数非流式限制维持整段返回。
 * memories 为记忆回灌：随请求透传给 llm-proxy 注入 system 提示。
 */
export function apiChatStream(
  message: string,
  deep: boolean,
  onDelta: (chunk: string) => void,
  memories?: string[]
): Promise<{ reply: string; action: string } | null> {
  return chatLocalStream(message, deep, onDelta, memories);
}

/** 收藏列表 */
export function apiGetLibrary(): Promise<CollectionItem[]> {
  return callFunction<CollectionItem[]>('getLibrary');
}

/** 今日热点资讯（v2.0，来源强制标注；云函数就绪前双端走本地 mock） */
export function apiGetHotspot(): Promise<HotspotNews[]> {
  return callFunction<HotspotNews[]>('getHotspot');
}

/** 全网资讯搜索（F29）：真机走 webSearch 云函数（Bing News RSS）；H5 返回 null，由页面本地过滤兜底 */
export async function apiNewsSearch(keyword: string): Promise<HotspotNews[] | null> {
  const kw = keyword.trim();
  if (!kw) return [];
  if (process.env.TARO_ENV !== 'weapp') return null;
  try {
    const res = await Taro.cloud.callFunction({
      name: 'webSearch',
      data: { action: 'searchNews', keyword: kw.slice(0, 30) }
    });
    const payload = res.result as { code: number; data: HotspotNews[] | null; message?: string };
    if (payload && payload.code === 0 && Array.isArray(payload.data)) return payload.data;
    console.warn('[api] newsSearch bad payload:', payload && payload.message);
    return null;
  } catch (err) {
    console.warn('[api] newsSearch failed:', err);
    return null;
  }
}

/** 资讯反馈（F22）：记录 👍/👎，驱动内容瘦身；本地持久化 + 真机走云函数 */
export function apiNewsFeedback(id: string, feedback: 'up' | 'down'): Promise<{ id: string; feedback: 'up' | 'down' }> {
  // 本地持久化（双端即时生效）
  try {
    const raw = Taro.getStorageSync('newsFeedback') || {};
    raw[id] = feedback;
    Taro.setStorageSync('newsFeedback', raw);
  } catch (err) {
    console.warn('[api] newsFeedback persist failed:', err);
  }
  // H5 预览无 webSearch 云通道（callFunction 会路由到不存在的 mock），反馈留本地
  if (process.env.TARO_ENV !== 'weapp') {
    return Promise.resolve({ id, feedback });
  }
  // 真机落库 newsFeedback 集合；失败不阻塞本地标记
  return Taro.cloud
    .callFunction({ name: 'webSearch', data: { action: 'feedback', id, feedback } })
    .then(() => ({ id, feedback }))
    .catch((err) => {
      console.warn('[api] newsFeedback cloud sync failed:', err);
      return { id, feedback };
    });
}

/** 更新习惯设置 */
export function apiUpdateSettings(payload: Partial<Pick<UserProfile, 'nickname' | 'briefingTime' | 'preferences'>>): Promise<UserProfile> {
  return callFunction<UserProfile>('updateSettings', payload);
}

/** 用量查询 */
export function apiGetUsage(): Promise<Usage> {
  return callFunction<Usage>('getUsage');
}

/** 创建订阅订单 */
export function apiCreateOrder(planId: PayOrder['planId']): Promise<PayOrder> {
  return callFunction<PayOrder>('createOrder', { planId });
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
