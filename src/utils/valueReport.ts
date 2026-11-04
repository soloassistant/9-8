// ============================================
// 价值周报（2026-10-31）：把「省了多少时间 / 做了多少事」变成用户看得见的账。
// 订阅价值主张的落地件（docs/产品评估与改进方案-2026-10-31.md §7.2 A）：
// 付费动机 ①「时间账算得清」——只汇总**真实发生**的数据，缺的数据宁可不显示，
// 绝不编一个数字出来（诚实性纪律同 8.1）。
// 纯函数、零运行时依赖（Taro 触不到这里）：存储读取在调用页完成。
// ============================================
import { computeWeeklyReview } from './weeklyReview';
import type { ScheduleEvent, TodoItem } from '../types';

export interface ValueReportInput {
  /** 全量日程/待办（窗口过滤交给 computeWeeklyReview，口径与其一致：近 7 天含今天） */
  events?: ScheduleEvent[];
  todos?: TodoItem[];
  /** 记账窗口合计（页面用 ledgerAggregate 算好后传入；null = 本周无记账数据，报告里不显示该行） */
  ledger?: { income: number; expense: number; count: number } | null;
  /** 近 7 天习惯打卡次数（无数据传 0/undefined = 不显示） */
  habitCheckins?: number;
  /** 当前连续阅读天数（readStreak.getReadStreak()） */
  readStreak?: number;
  /** 近 7 天 AI 功能调用次数（usageLog 汇总） */
  aiCalls7d?: number;
  /** 近 7 天打开晨报的天数（存档器记录；未接存档前传 undefined = 不显示） */
  briefingOpenDays?: number;
}

export interface ValueReport {
  /** 复用本周复盘的待办/日程口径（todosDone / eventCount / keywords） */
  todosDone: number;
  eventCount: number;
  keywords: string[];
  /** 本周记账结余（income - expense）；ledger 缺省为 null */
  ledgerBalance: number | null;
  ledgerCount: number | null;
  habitCheckins: number | null;
  readStreak: number | null;
  aiCalls7d: number | null;
  briefingOpenDays: number | null;
}

function positiveOr(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 汇总近 7 天（含今天）的价值报告。
 * 待办/日程/关键词口径 = computeWeeklyReview（单一事实源，勿在此重算第二份）；
 * 其余各项「有数据才显示」：传 undefined / null 的行在报告里就是不存在，而不是 0。
 */
export function computeValueReport(input: ValueReportInput, now = new Date()): ValueReport {
  const review = computeWeeklyReview(input.events || [], input.todos || [], now);
  const ledger = input.ledger && Number.isFinite(input.ledger.income) && Number.isFinite(input.ledger.expense)
    ? input.ledger
    : null;
  return {
    todosDone: review.todosDone,
    eventCount: review.eventCount,
    keywords: review.keywords,
    ledgerBalance: ledger ? Number((ledger.income - ledger.expense).toFixed(2)) : null,
    ledgerCount: ledger && ledger.count > 0 ? ledger.count : null,
    habitCheckins: positiveOr(input.habitCheckins),
    readStreak: positiveOr(input.readStreak),
    aiCalls7d: positiveOr(input.aiCalls7d),
    briefingOpenDays: positiveOr(input.briefingOpenDays),
  };
}
