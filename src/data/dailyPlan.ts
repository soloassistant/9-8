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