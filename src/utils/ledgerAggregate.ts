/**
 * 记账聚合（纯函数，零 I/O）—— 晨报卡片与记账页共用。
 *
 * 为什么要单独抽出来：不抽的话求和逻辑会散落在两个页面里，
 * 迟早出现「记账页算 ¥120、晨报卡片显示 ¥100」这种对不上的情况
 * （本项目有过教训：购物清单的「真实本地数据 vs 演示数据」口径矛盾，
 * 见 services/cloud.ts:31-37 的注释）。
 *
 * 所有函数**只做计算，不读 storage、不改数据** —— 便于用 harness 直接测
 * （.tools/verify-ledger-aggregate.mjs）。
 */
import type { LedgerBudget, LedgerCategory, LedgerEntry, LedgerSummary } from '../types';

/** 今天的 'YYYY-MM-DD'。口径与 utils/date.ts / getBriefing.ts 的 date 一致。 */
export function todayStr(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 当前自然月 'YYYY-MM'。 */
export function currentMonthStr(now: Date = new Date()): string {
  return todayStr(now).slice(0, 7);
}

/**
 * 按日期区间筛条目。区间是**闭区间**（含起含止），因为 date 本身就是 'YYYY-MM-DD'，
 * 字符串比较即可 —— 不要引 dayjs 做「同一天」判断，既慢又容易在时区上翻车
 * （utils/date.ts:24-33 记录过为什么删掉过一个 isSame 实现）。
 */
export function filterByRange(entries: LedgerEntry[], from: string, to: string): LedgerEntry[] {
  if (!from || !to || from > to) return [];
  return entries.filter((e) => e.date >= from && e.date <= to);
}

/** 今日条目 */
export function todayEntries(entries: LedgerEntry[], now: Date = new Date()): LedgerEntry[] {
  return filterByRange(entries, todayStr(now), todayStr(now));
}

/** 本月条目 */
export function monthEntries(entries: LedgerEntry[], now: Date = new Date()): LedgerEntry[] {
  const d = todayStr(now);
  return filterByRange(entries, `${d.slice(0, 7)}-01`, d);
}

/** 上一自然月的 'YYYY-MM'。跨年边界（1月 → 上一年12月）必须正确。 */
export function prevMonthStr(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * 核心聚合：支出/收入/分类分布/超支判定。
 *
 * 关于金额：全用**分为单位先累加、最后除100**，避免 0.1+0.2 类浮点误差
 * 在多笔累加后变成 ¥35.99999999999999 这类显示事故。
 * 浮点不可完全消除，故最后统一 round 到分。
 *
 * byCategory 只统计**支出**（收入按分类拆没有「哪个来源花钱多」的意义），
 * 且按金额降序、金额为 0 的不入榜 —— 晨报卡片只显示 Top N，空项没有展示价值。
 */
export function summarize(entries: LedgerEntry[], budget?: LedgerBudget): LedgerSummary {
  let expenseCents = 0;
  let incomeCents = 0;
  let expenseCount = 0;
  const catMap = new Map<string, { amount: number; count: number }>();

  for (const e of entries) {
    if (!e || typeof e.amount !== 'number' || !Number.isFinite(e.amount) || e.amount <= 0) continue;
    const cents = Math.round(e.amount * 100);
    if (cents <= 0) continue; // 四舍五入到分后变 0（记 0.001 元）视为无效
    if (e.kind === 'income') {
      incomeCents += cents;
      continue;
    }
    expenseCents += cents;
    expenseCount += 1;
    const cur = catMap.get(e.categoryId) || { amount: 0, count: 0 };
    catMap.set(e.categoryId, { amount: cur.amount + cents, count: cur.count + 1 });
  }

  const byCategory = Array.from(catMap.entries())
    .map(([categoryId, v]) => ({ categoryId, amount: v.amount / 100, count: v.count }))
    .filter((x) => x.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.categoryId.localeCompare(b.categoryId));

  const expense = expenseCents / 100;
  const income = incomeCents / 100;
  return {
    expense,
    income,
    expenseCount,
    byCategory,
    // 预算未设 = 不限制；已设且支出严格大于上限才算超（等于上限不算超）
    overDaily: !!(budget && budget.daily !== undefined && expense > budget.daily),
    overMonthly: !!(budget && budget.monthly !== undefined && expense > budget.monthly)
  };
}

/**
 * 晨报用的「今日账单」摘要：今日支出 + 昨日对比 + 分类 Top3。
 *
 * 刻意只给**对比**不给绝对值排行 —— 晨报是「今天要知道的」，
 * 「昨天比今天多花多少」比完整流水有用得多。
 * 昨日为 0 时 delta 为 null（不是 0），调用方据此隐藏「较昨日」那行，
 * 免得显示成「+100%」这种误导性的百分比。
 */
export interface TodayBrief {
  expense: number;
  income: number;
  count: number;
  /** 较昨日的支出变化（元）。昨日无支出时为 null。 */
  deltaFromYesterday: number | null;
  topCategories: Array<{ categoryId: string; amount: number; count: number }>;
  overDaily: boolean;
  hasBudget: boolean;
  dailyBudget?: number;
}

/** 昨日日期（跨月/跨年边界靠 Date 算，别手写字符串减法） */
export function yesterdayStr(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - 1);
  return todayStr(d);
}

export function buildTodayBrief(
  entries: LedgerEntry[],
  budget: LedgerBudget,
  now: Date = new Date()
): TodayBrief {
  const today = todayStr(now);
  const todaySum = summarize(filterByRange(entries, today, today), budget);
  const y = yesterdayStr(now);
  const ySum = summarize(filterByRange(entries, y, y), {});
  // 昨日支出为 0 时不报 delta：除零/百分比失真，且「昨日 0 元」本身不是可比基准
  const deltaFromYesterday = ySum.expense > 0 ? Math.round((todaySum.expense - ySum.expense) * 100) / 100 : null;
  return {
    expense: todaySum.expense,
    income: todaySum.income,
    count: todaySum.expenseCount,
    deltaFromYesterday,
    topCategories: todaySum.byCategory.slice(0, 3),
    overDaily: todaySum.overDaily,
    hasBudget: budget.daily !== undefined,
    ...(budget.daily !== undefined ? { dailyBudget: budget.daily } : {})
  };
}

/** 分类 id → 分类对象。**故意对未知 id 返回占位分类**而不是 undefined ——
 * 分类被删/云同步未到达时，流水仍要能显示成「未分类 · ¥30」，
 * 静默渲染空白会让用户以为钱丢了。 */
export function resolveCategory(
  categories: LedgerCategory[],
  categoryId: string
): { id: string; name: string; icon: string; kind: 'expense' | 'income' } {
  const found = categories.find((c) => c.id === categoryId);
  if (found) return { id: found.id, name: found.name, icon: found.icon, kind: found.kind };
  return { id: categoryId, name: '未分类', icon: '❓', kind: 'expense' };
}