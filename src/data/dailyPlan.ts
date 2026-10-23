/** mock: dailyPlan —— 待办与日程的统一持久化存储（本地，真实数据不造演示 seed） */
import Taro from '@tarojs/taro';
import type { ScheduleEvent, TodoItem } from '../types';

const PLAN_KEY = 'dailyPlanStore';

export interface DailyPlan {
  events: ScheduleEvent[];
  todos: TodoItem[];
}

/** 生成唯一 id */
export function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function tryParse(raw: unknown): DailyPlan {
  try {
    const obj = raw as Partial<DailyPlan>;
    return {
      events: Array.isArray(obj?.events) ? obj.events : [],
      todos: Array.isArray(obj?.todos) ? obj.todos : []
    };
  } catch {
    return { events: [], todos: [] };
  }
}

export function readPlan(): DailyPlan {
  try {
    const raw = Taro.getStorageSync(PLAN_KEY);
    return tryParse(raw);
  } catch (err) {
    console.warn('[mock:dailyPlan] read failed:', err);
    return { events: [], todos: [] };
  }
}

export function writePlan(plan: DailyPlan) {
  try {
    Taro.setStorageSync(PLAN_KEY, plan);
  } catch (err) {
    console.warn('[mock:dailyPlan] write failed:', err);
  }
}

/**
 * 确定性写入单条待办状态，并**回读校验**是否真的落盘。
 *
 * 为什么必须回读：`writePlan` 刻意吞掉 storage 异常（其他调用方依赖它不抛错），
 * 所以「写成功」和「写失败」的返回值一模一样 —— 不回读就还是静默失败。
 * 页面据此决定是否更新 UI：返回 ok:false 时不改勾选态，避免「假完成」。
 */
export function setTodoStatus(id: string, status: 'done' | 'confirmed'): { ok: boolean; reason?: string } {
  const plan = readPlan();
  const hit = plan.todos.find((td) => td.id === id);
  if (!hit) return { ok: false, reason: 'not_found' };
  // 幂等：已是目标状态不重复写
  if (hit.status === status) return { ok: true };

  hit.status = status;
  writePlan(plan);

  const check = readPlan().todos.find((td) => td.id === id);
  if (!check || check.status !== status) return { ok: false, reason: 'not_persisted' };
  return { ok: true };
}
