/**
 * AI 动作执行器（2026-10-31）—— 让「AI 说已经做了」真的等于「已经写进库」。
 *
 * 背景（用户实测「我的 → AI 助理 有反馈但不会做事」）：
 *  - 模型侧契约早就定义了 `batch / schedule / reschedule / done / shopping` 等动作，
 *    但客户端只处理了 `action === 'plan'`（渲染方案卡），其余动作的载荷**整段丢弃**；
 *  - 而 `plan` 的落库入口 `apiApplyPlan` 走的是 `callFunction('chat')`（微信云函数），
 *    H5 没有这条通道 ⇒ 连方案批准也写不进去。
 *
 * 所以 H5 缺的不是「多认几个动作」，而是一条**本地写入通道**。好在这条通道本来就存在：
 * 日历页的「手动添加」用 `apiConfirmItem` → `writePlan()` → 晨报/日历读同一份存储
 * （`src/data/dailyPlan.ts`，`REAL_LOCAL_ACTIONS` 里明确列为真落库）。
 * 本模块只做一件事：把模型给的动作翻译成这几个已有 API 的调用，不再自造写库路径。
 *
 * 分寸：
 *  - `schedule`（排班建议）**不写库** —— 提示词要求「先给建议，等用户确认」，这里保持；
 *  - `shopping` 是分析文本，没有可写的实体；
 *  - 写失败一律如实返回 ok:false，调用方不得据此宣称成功（与 todoStatus 同口径）。
 */
import { readPlan, writePlan } from '../data/dailyPlan';
import { apiConfirmItem, apiTodoSetStatus } from './api';

export interface AiActionPayload {
  action?: string;
  targetId?: string | null;
  newTime?: string | null;
  newEvents?: unknown[];
}

export interface AiActionOutcome {
  /** 给用户看的一句话（成功/失败都要能说清） */
  kind: 'batch' | 'done' | 'reschedule';
  ok: boolean;
  saved: number;
  /** 失败原因（成功时为空） */
  reason?: string;
}

/** `YYYY-MM-DD HH:mm` / `YYYY-MM-DDTHH:mm` —— 只有能被 dayjs 稳定解析的形状才进库 */
const TIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/;

export interface NormalizedEvent {
  title: string;
  startTime: string;
  endTime?: string;
  source: string;
}

/** 把模型给的 newEvents 归一成可写入的形状；任何一条不合格就丢掉那一条（不整体失败，
 *  也不伪造时间）—— 与其写进一个「0000-00-00」的假条目，不如少写一条。 */
export function normalizeNewEvents(raw: unknown[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title.trim().slice(0, 60) : '';
    const startTime = typeof obj.startTime === 'string' ? obj.startTime.trim() : '';
    if (!title || !TIME_RE.test(startTime)) continue;
    const ev: NormalizedEvent = { title, startTime, source: 'AI 排入' };
    const endTime = typeof obj.endTime === 'string' ? obj.endTime.trim() : '';
    if (TIME_RE.test(endTime)) ev.endTime = endTime;
    out.push(ev);
  }
  return out;
}

/**
 * 执行一次 AI 动作。返回 null 表示「这个动作不该由客户端执行」（schedule / shopping / chat / plan）。
 * **不要**在这里抛错：调用方在对话流里，抛错会中断回复展示。
 */
export async function runAiAction(payload: AiActionPayload): Promise<AiActionOutcome | null> {
  const action = String(payload.action || '');
  try {
    if (action === 'batch') {
      const events = normalizeNewEvents(Array.isArray(payload.newEvents) ? payload.newEvents : []);
      if (events.length === 0) {
        return { kind: 'batch', ok: false, saved: 0, reason: 'no_valid_events' };
      }
      // 走日历「手动添加」同一条本地落库通道，不另造一套写库实现
      const res = await apiConfirmItem({ events, todos: [] });
      const saved = res && typeof res.saved === 'number' ? res.saved : 0;
      return { kind: 'batch', ok: saved > 0, saved };
    }

    if (action === 'done') {
      const id = typeof payload.targetId === 'string' ? payload.targetId : '';
      if (!id) return { kind: 'done', ok: false, saved: 0, reason: 'no_target' };
      const res = await apiTodoSetStatus({ id, status: 'done' });
      return { kind: 'done', ok: res.ok === true, saved: res.ok ? 1 : 0, reason: res.reason };
    }

    if (action === 'reschedule') {
      const id = typeof payload.targetId === 'string' ? payload.targetId : '';
      const newTime = typeof payload.newTime === 'string' ? payload.newTime.trim() : '';
      if (!id) return { kind: 'reschedule', ok: false, saved: 0, reason: 'no_target' };
      if (!TIME_RE.test(newTime)) return { kind: 'reschedule', ok: false, saved: 0, reason: 'bad_time' };
      const plan = readPlan();
      const idx = (plan.events || []).findIndex((e) => e && e.id === id);
      if (idx < 0) return { kind: 'reschedule', ok: false, saved: 0, reason: 'not_found' };
      plan.events[idx] = { ...plan.events[idx], startTime: newTime };
      writePlan(plan);
      return { kind: 'reschedule', ok: true, saved: 1 };
    }
  } catch (err) {
    console.error('[aiAction] execute failed:', err);
    const kind = (action === 'done' ? 'done' : action === 'reschedule' ? 'reschedule' : 'batch') as AiActionOutcome['kind'];
    return { kind, ok: false, saved: 0, reason: 'exception' };
  }
  return null;
}
