/**
 * 习惯自动守护（增量 3，借鉴 Reclaim.ai 的「自动腾挪」思路）。
 *
 * 职责边界（纯逻辑层，可单测）：
 * - 习惯数据（`Habit`）与守护记录（`HabitGuardRecord`）用**独立 storage** 存放
 *   （`habitStore`），**不改冻结的 `src/types/index.ts`**，也不改 `ScheduleEvent`；
 *   习惯与日程用 `eventId` 弱关联。
 * - 候选时段不重写算法，直接复用 `utils/schedule.ts` 的 `suggestSlotCandidates`；
 *   本模块只补一个「候选是否落在习惯时间窗口内」的纯函数 `isSlotInWindow`。
 * - 触发方式：**进页面惰性结算**（与 `readStreak.settleReadStreakOnOpen` 同构），
 *   不新增云端定时任务。
 *
 * 核心安全语义（务必准确）：
 * 1. `habit.autoGuard` **默认 false**，关闭时守护逻辑**完全不生效**（零副作用）。
 * 2. 风险分层：
 *    - 低风险 = 候选 `busyness==='free'` 且落在习惯窗口内 且不跨天 → **规划为自动挪动**；
 *    - 高风险 = 其余全部情况（候选全 clash/crowded、需扩窗、需跨天）→ **绝不自动挪**，
 *      改为返回提案原文，交调用方用既有 `PlanProposalCard` + `apiApplyPlan` 确认链路。
 * 3. **规划与提交分离**：`guardHabitsOnOpen` 只规划、不落盘；调用方必须在**远端写库成功后**
 *    再调 `commitHabitGuards()` 登记本地记录与站内信。这样写库失败时不会留下「已守护」记录
 *    去误导用户（用户会以为日程已改，实际没有）。
 * 4. 所有 storage 读写 try/catch，失败只 `console.warn`，**绝不 throw**、绝不阻断主流程。
 */
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import { isOverlap, suggestSlotCandidates, SCAN_NO_LIMIT } from './schedule';
import type { SlotCandidate, PlanProposalRaw } from './schedule';
import type { ScheduleEvent } from '@/types';
import type { LangKey } from '../store/language';

/* ------------------------------------------------------------------ */
/* 常量（禁止魔法数字，全部导出）                                        */
/* ------------------------------------------------------------------ */

/** 习惯数据 + 守护记录的 storage key（独立于日程/价格/阅读 streak） */
export const HABIT_STORE_KEY = 'habitStore';
/** 习惯站内信的独立 storage key（刻意不复用价格通知的 mb_price_notices，避免污染价格语义） */
export const HABIT_NOTICE_KEY = 'mb_habit_notices';
/** 守护记录保留上限（超出丢最旧） */
export const HABIT_RECORD_MAX = 50;
/** 站内信保留上限 */
export const HABIT_NOTICE_MAX = 30;
/** 撤销窗口（小时）：自动挪动后 24h 内可还原 */
export const HABIT_UNDO_WINDOW_HOURS = 24;
/** 首次自动、后续同类触发降级为提议（降低「被多次自动修改」的惊扰感） */
export const HABIT_AUTO_FIRST_ONLY = true;
/** 缺省时长（分钟） */
export const DEFAULT_HABIT_DURATION_MINUTES = 60;
/** 时长下限（分钟）：与 schedule 口径一致 */
export const MIN_HABIT_DURATION_MINUTES = 30;
/** 允许自动挪动的默认时段窗口（08:00–21:00，与 schedule 扩窗口径一致） */
export const HABIT_WINDOW_START_HOUR = 8;
export const HABIT_WINDOW_END_HOUR = 21;
/**
 * 'HH:mm' 时间格式校验。
 * 必须同时校验**形状与取值范围**：仅用 `/^\d{2}:\d{2}$/` 会放过 `'99:99'`，
 * 而它会让 `dayjs('YYYY-MM-DD 99:99')` 变成 Invalid Date —— 结果是该习惯的守护
 * **静默失效**（既不报错也不挪动），用户却以为自己已经开启了守护。
 * 收紧后非法值统一降级为默认 '09:00'，守护仍能正常工作。
 */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 'YYYY-MM-DD' 日期格式校验 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 习惯允许自动挪动的时段窗口（小时粒度）。 */
export interface HabitWindow {
  /** 窗口起始小时（含） */
  startHour: number;
  /** 窗口结束小时（含，候选结束需 ≤ 该小时） */
  endHour: number;
}

/** 习惯定义（独立于 `ScheduleEvent`，用 `eventId` 弱关联）。 */
export interface Habit {
  id: string;
  title: string;
  /** 期望开始时间（分钟粒度，'HH:mm'） */
  preferredStart: string;
  /** 期望时长（分钟） */
  durationMinutes: number;
  /** 允许自动挪动的时段窗口 */
  window: HabitWindow;
  /** 是否允许跨天顺延（仅影响高风险提议，自动挪动永不跨天） */
  allowDayShift: boolean;
  /** 守护开关：**默认 false**，用户显式开启后才生效 */
  autoGuard: boolean;
  /** 关联的日程事件 id（弱关联，用于识别「用户已手动改过时段」与撤销还原） */
  eventId?: string;
  createdAt: string;
}

/** 守护动作记录（自动挪动 / 曾提议），含撤销栈与 `undoUntil`。 */
export interface HabitGuardRecord {
  id: string;
  habitId: string;
  /** 习惯标题快照（撤销/历史展示无需再查 habits） */
  title: string;
  /** 'YYYY-MM-DD'（幂等键之一） */
  date: string;
  /** 原时段 'YYYY-MM-DD HH:mm' */
  fromTime: string;
  /** 自动挪到的时段 'YYYY-MM-DD HH:mm' */
  toTime: string;
  /** 侵占者（冲突日程标题） */
  blockedBy: string;
  /** true = 自动挪动产生；false = 提议产生（预留） */
  auto: boolean;
  /** 是否已撤销（还原） */
  undone: boolean;
  /** 关联日程 id（撤销还原用） */
  eventId?: string;
  /** 可撤销时限至（ISO，默认挪动后 24h） */
  undoUntil: string;
  /** 记录创建时间（ISO） */
  createdAt: string;
}

/** 持久化结构。 */
export interface HabitStore {
  habits: Habit[];
  /** 守护历史（最新在前，含撤销栈） */
  records: HabitGuardRecord[];
  /** 记录上限（常量 HABIT_RECORD_MAX） */
  maxRecords: number;
}

/** 守护结果：自动挪了哪些 / 哪些转成提案 / 是否发生状态变化。 */
export interface HabitGuardOutcome {
  /** 本次自动挪动的记录（低风险） */
  autoMoved: HabitGuardRecord[];
  /** 本次需确认的提案原文（高风险，交 buildPlanProposal 渲染 PlanProposalCard） */
  proposals: PlanProposalRaw[];
  /** 本次是否**规划出**自动挪动（仅生成提案不算）。真正落盘状态见 `commitHabitGuards` */
  changed: boolean;
}

/** 撤销结果。 */
export interface HabitUndoResult {
  ok: boolean;
  /** 命中的记录（无论成功与否，便于调用方取 fromTime 还原） */
  record: HabitGuardRecord | null;
}

/** 站内信（独立类型，不复用价格专用 PriceChangeNotice）。 */
export interface HabitNotice {
  id: string;
  /** 标题 i18n key（utils 层禁止硬编码中文） */
  titleKey: LangKey;
  /** 正文 i18n key */
  bodyKey: LangKey;
  /** 正文插值参数：`{ title, date, time }` */
  params: Record<string, string | number>;
  habitId: string;
  recordId: string;
  read: boolean;
  /** 入站时间 'YYYY-MM-DD' */
  createdAt: string;
}

/** 创建习惯入参（id / createdAt 由模块生成）。 */
export interface HabitInput {
  title: string;
  preferredStart: string;
  durationMinutes?: number;
  window?: HabitWindow;
  allowDayShift?: boolean;
  autoGuard?: boolean;
  eventId?: string;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

let habitSeq = 0;
/** 生成单调递增的本地 id（记录 / 习惯 / 站内信） */
function nextId(prefix: string): string {
  habitSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${habitSeq}`;
}

/** 小时值钳制到合法区间 [0, 24] */
function clampHour(h: number): number {
  if (!isFinite(h)) return HABIT_WINDOW_START_HOUR;
  return Math.min(24, Math.max(0, Math.round(h)));
}

/** 归一化窗口：缺字段 / 脏数据降级为默认窗口，绝不抛错 */
function normalizeWindow(raw: unknown): HabitWindow {
  if (raw && typeof raw === 'object') {
    const w = raw as Record<string, unknown>;
    const startHour = clampHour(typeof w.startHour === 'number' ? w.startHour : HABIT_WINDOW_START_HOUR);
    const endHour = clampHour(typeof w.endHour === 'number' ? w.endHour : HABIT_WINDOW_END_HOUR);
    // 结束不得早于开始，否则回退默认，避免判定区间恒空
    if (endHour < startHour) return { startHour: HABIT_WINDOW_START_HOUR, endHour: HABIT_WINDOW_END_HOUR };
    return { startHour, endHour };
  }
  return { startHour: HABIT_WINDOW_START_HOUR, endHour: HABIT_WINDOW_END_HOUR };
}

/** 归一化单条习惯：关键字段缺失则丢弃（返回 null） */
function normalizeHabit(raw: unknown): Habit | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const preferredStart = typeof r.preferredStart === 'string' && HHMM_RE.test(r.preferredStart) ? r.preferredStart : '09:00';
  const duration =
    typeof r.durationMinutes === 'number' && r.durationMinutes >= MIN_HABIT_DURATION_MINUTES
      ? Math.round(r.durationMinutes)
      : DEFAULT_HABIT_DURATION_MINUTES;
  return {
    id: r.id,
    title: typeof r.title === 'string' ? r.title : '',
    preferredStart,
    durationMinutes: duration,
    window: normalizeWindow(r.window),
    allowDayShift: r.allowDayShift === true,
    // ⚠️ 关键安全语义：只有显式 true 才算开启，任何其它值（含缺失）一律 false
    autoGuard: r.autoGuard === true,
    eventId: typeof r.eventId === 'string' && r.eventId ? r.eventId : undefined,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : dayjs().toISOString()
  };
}

/** 归一化单条守护记录：关键字段缺失则丢弃（返回 null） */
function normalizeRecord(raw: unknown): HabitGuardRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.habitId !== 'string' || !r.habitId) return null;
  return {
    id: r.id,
    habitId: r.habitId,
    title: typeof r.title === 'string' ? r.title : '',
    date: typeof r.date === 'string' && DATE_RE.test(r.date) ? r.date : '',
    fromTime: typeof r.fromTime === 'string' ? r.fromTime : '',
    toTime: typeof r.toTime === 'string' ? r.toTime : '',
    blockedBy: typeof r.blockedBy === 'string' ? r.blockedBy : '',
    auto: r.auto === true,
    undone: r.undone === true,
    eventId: typeof r.eventId === 'string' ? r.eventId : undefined,
    undoUntil: typeof r.undoUntil === 'string' ? r.undoUntil : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : ''
  };
}

/** 空 store 工厂：所有降级分支统一构造，避免字面量漂移 */
function emptyStore(): HabitStore {
  return { habits: [], records: [], maxRecords: HABIT_RECORD_MAX };
}

/* ------------------------------------------------------------------ */
/* store 读写                                                          */
/* ------------------------------------------------------------------ */

/**
 * 读取并归一化 store。
 * 向后兼容：结构缺失 / 非数组 / 缺字段一律降级为安全默认值，绝不抛错。
 */
export function readHabitStore(): HabitStore {
  try {
    const raw = Taro.getStorageSync(HABIT_STORE_KEY);
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const habits = Array.isArray(r.habits)
        ? (r.habits.map(normalizeHabit).filter((h): h is Habit => h !== null))
        : [];
      const records = Array.isArray(r.records)
        ? (r.records.map(normalizeRecord).filter((rec): rec is HabitGuardRecord => rec !== null))
        : [];
      const maxRecords = typeof r.maxRecords === 'number' && r.maxRecords > 0 ? r.maxRecords : HABIT_RECORD_MAX;
      return { habits, records, maxRecords };
    }
  } catch (err) {
    console.warn('[habit] read store failed:', err);
  }
  return emptyStore();
}

/** 写盘：失败只 warn，绝不阻断主流程 */
function writeHabitStore(store: HabitStore): void {
  try {
    Taro.setStorageSync(HABIT_STORE_KEY, store);
  } catch (err) {
    console.warn('[habit] write store failed:', err);
  }
}

/** 添加一条记录（最新在前，超上限丢最旧） */
function appendRecord(store: HabitStore, record: HabitGuardRecord): void {
  const limit = store.maxRecords > 0 ? store.maxRecords : HABIT_RECORD_MAX;
  store.records = [record, ...store.records].slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 习惯 CRUD                                                           */
/* ------------------------------------------------------------------ */

/** 全部习惯（读失败返回空数组） */
export function listHabits(): Habit[] {
  return readHabitStore().habits;
}

/** 创建习惯并落库（autoGuard 缺省 false） */
export function createHabit(input: HabitInput): Habit {
  const habit: Habit = {
    id: nextId('habit'),
    title: String(input.title || '').trim(),
    preferredStart: typeof input.preferredStart === 'string' && HHMM_RE.test(input.preferredStart) ? input.preferredStart : '09:00',
    durationMinutes:
      typeof input.durationMinutes === 'number' && input.durationMinutes >= MIN_HABIT_DURATION_MINUTES
        ? Math.round(input.durationMinutes)
        : DEFAULT_HABIT_DURATION_MINUTES,
    window: normalizeWindow(input.window ?? { startHour: HABIT_WINDOW_START_HOUR, endHour: HABIT_WINDOW_END_HOUR }),
    allowDayShift: input.allowDayShift === true,
    // 关键：调用方未显式开启时一律 false
    autoGuard: input.autoGuard === true,
    eventId: typeof input.eventId === 'string' && input.eventId ? input.eventId : undefined,
    createdAt: dayjs().toISOString()
  };
  const store = readHabitStore();
  store.habits = [...store.habits, habit];
  writeHabitStore(store);
  return habit;
}

/** 切换某习惯的自动守护开关；找不到返回 null */
export function setHabitAutoGuard(id: string, on: boolean): Habit | null {
  const store = readHabitStore();
  const target = store.habits.find((h) => h.id === id);
  if (!target) return null;
  const next: Habit = { ...target, autoGuard: on === true };
  store.habits = store.habits.map((h) => (h.id === id ? next : h));
  writeHabitStore(store);
  return next;
}

/** 删除习惯（保留历史记录，便于回看） */
export function removeHabit(id: string): void {
  const store = readHabitStore();
  store.habits = store.habits.filter((h) => h.id !== id);
  writeHabitStore(store);
}

/* ------------------------------------------------------------------ */
/* 候选窗口判定（纯函数）                                               */
/* ------------------------------------------------------------------ */

/** 两个 'YYYY-MM-DD HH:mm' 是否同一自然日 */
export function isSameDay(time: string, ref: string): boolean {
  return dayjs(time).format('YYYY-MM-DD') === dayjs(ref).format('YYYY-MM-DD');
}

/**
 * 候选是否落在习惯允许的时段窗口内（分钟精度）。
 * 判据：候选开始 ≥ window.startHour:00 且 候选结束 ≤ window.endHour:00。
 */
export function isSlotInWindow(candidate: SlotCandidate, window: HabitWindow): boolean {
  if (!candidate || !candidate.startTime) return false;
  const start = dayjs(candidate.startTime);
  if (!start.isValid()) return false;
  const startMinutes = start.hour() * 60 + start.minute();
  const end = candidate.endTime ? dayjs(candidate.endTime) : start;
  const endMinutes = end.hour() * 60 + end.minute();
  return startMinutes >= window.startHour * 60 && endMinutes <= window.endHour * 60;
}

/**
 * 风险分层判定（供自动挪动用）：
 * 低风险 = 候选 free 且落在习惯窗口内 且不跨天。任一不满足即高风险。
 */
export function isLowRiskCandidate(
  candidate: SlotCandidate,
  window: HabitWindow,
  habitStart: string
): boolean {
  return (
    !!candidate &&
    candidate.busyness === 'free' &&
    isSlotInWindow(candidate, window) &&
    isSameDay(candidate.startTime, habitStart)
  );
}

/* ------------------------------------------------------------------ */
/* 惰性结算：guardHabitsOnOpen                                          */
/* ------------------------------------------------------------------ */

/** 由习惯 + 冲突信息构造一条自动挪动记录 */
function buildRecord(
  habit: Habit,
  date: string,
  fromTime: string,
  toTime: string,
  blockedBy: string,
  eventId: string | undefined,
  now: number
): HabitGuardRecord {
  return {
    id: nextId('hg'),
    habitId: habit.id,
    title: habit.title,
    date,
    fromTime,
    toTime,
    blockedBy,
    auto: true,
    undone: false,
    eventId,
    undoUntil: dayjs(now).add(HABIT_UNDO_WINDOW_HOURS, 'hour').toISOString(),
    createdAt: dayjs(now).toISOString()
  };
}

/**
 * 进页面惰性结算（同构 settleReadStreakOnOpen）。
 *
 * **本函数是纯规划器：不写盘、不发站内信、不改任何持久化状态。**
 * 它只回答「哪些习惯该挪、挪到哪、哪些需要用户确认」。真正的落盘必须在
 * **远端写库成功后**由调用方调 `commitHabitGuards()` 完成 —— 否则一旦写库失败，
 * 本地已留下「已守护」记录与站内信，用户会以为日程已经改好，**实际却没有**，
 * 等于向用户谎报他自己日程的状态。
 *
 * 对每个 `autoGuard === true` 的习惯：
 * - 若其关联日程已被用户手动改到别的时段 → 视为用户接管，跳过；
 * - 若时段被其它日程侵占 → 用 `suggestSlotCandidates` 找候选并**按风险分层**：
 *   · 低风险（free + 窗口内 + 不跨天，且满足首次自动策略）→ 返回**待提交**记录；
 *   · 高风险 → 返回提案原文，**绝不自动挪**。
 *
 * 幂等：以 `habitId + date` 为键比对**已提交**的记录，同一习惯同一天只自动挪一次。
 * 若上次因写库失败而未提交，本次会重新规划 —— 这等价于重试，是预期行为。
 * 关闭 autoGuard 的习惯**完全不参与**，零副作用。
 */
export function guardHabitsOnOpen(existing: ScheduleEvent[], now: number = Date.now()): HabitGuardOutcome {
  const outcome: HabitGuardOutcome = { autoMoved: [], proposals: [], changed: false };
  const store = readHabitStore();
  if (store.habits.length === 0) return outcome;

  const events = Array.isArray(existing) ? existing.filter((e) => !!e && !!e.startTime) : [];
  const today = dayjs(now).format('YYYY-MM-DD');
  // 幂等键集合：已**提交**的自动挪动 (habitId, date)
  const guardedKeys = new Set(store.records.filter((r) => r.auto).map((r) => `${r.habitId}|${r.date}`));
  // 首次自动策略：已有已提交自动挪动的习惯，后续降级为提议
  const autoHabits = new Set(store.records.filter((r) => r.auto).map((r) => r.habitId));

  store.habits.forEach((habit) => {
    if (!habit.autoGuard) return; // 关闭 → 零副作用

    const habitStart = `${today} ${habit.preferredStart}`;
    const habitEnd = dayjs(habitStart).add(habit.durationMinutes, 'minute').format('YYYY-MM-DD HH:mm');

    // ① 用户手动接管检测：关联日程已不在期望时段 → 跳过（不打扰用户的主动调整）
    const own = habit.eventId ? events.find((e) => e.id === habit.eventId) : undefined;
    if (own && dayjs(own.startTime).format('HH:mm') !== habit.preferredStart) return;

    // ② 侵占检测：排除自身日程后，是否与其它日程重叠
    const others = habit.eventId ? events.filter((e) => e.id !== habit.eventId) : events;
    const clash = others.find((e) => isOverlap(habitStart, habitEnd, e.startTime, e.endTime));
    if (!clash) return; // 未被侵占 → 不动

    // ③ 幂等：同习惯同日已自动挪动 → 跳过
    const key = `${habit.id}|${today}`;
    if (guardedKeys.has(key)) return;

    // ④ 找候选（排除自身），按风险分层
    const scanned = suggestSlotCandidates(habitStart, habitEnd, others, { limit: SCAN_NO_LIMIT, extended: false });
    if (scanned.length === 0) return; // 无候选 → 跳过，不报错

    const lowRisk = scanned.find((c) => isLowRiskCandidate(c, habit.window, habitStart));
    const autoAllowed =
      !!lowRisk && (!HABIT_AUTO_FIRST_ONLY || !autoHabits.has(habit.id));

    if (autoAllowed && lowRisk) {
      // 低风险 → 生成**待提交**的自动挪动记录（真正落盘见 commitHabitGuards）
      const record = buildRecord(habit, today, habitStart, lowRisk.startTime, clash.title, own?.id ?? habit.eventId, now);
      outcome.autoMoved.push(record);
    } else {
      // 高风险 → 绝不自动挪，交调用方走确认链路
      const best = scanned.find((c) => c.busyness !== 'clash') ?? scanned[0];
      const toTime = best ? best.startTime : habitStart;
      outcome.proposals.push({
        title: habit.title,
        fromTime: habitStart,
        toTime,
        endTime: dayjs(toTime).add(habit.durationMinutes, 'minute').format('YYYY-MM-DD HH:mm'),
        eventId: habit.eventId
      });
    }
  });

  outcome.changed = outcome.autoMoved.length > 0;
  return outcome;
}

/**
 * 提交守护结果 —— **必须在远端写库成功后调用**（「先确认、再声称」）。
 *
 * 为什么把提交从规划里拆出来：若 `guardHabitsOnOpen` 顺手把记录与站内信写进本地，
 * 而随后的远端写库失败，用户会看到「已守护」并收到站内信、以为日程已经改好 —— 实际没有。
 * 拆分后，失败路径下**不留记录、不发通知、不弹成功提示**，用户下次进页面会自动重试。
 *
 * 幂等：同 id 已存在则跳过（重复提交不会产生重复记录或重复站内信）。
 *
 * @param records 待提交记录（来自 `guardHabitsOnOpen` 返回的 `autoMoved`）
 * @returns 实际提交条数
 */
export function commitHabitGuards(records: HabitGuardRecord[]): number {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const store = readHabitStore();
  let committed = 0;
  records.forEach((record) => {
    if (!record || !record.id) return;
    if (store.records.some((r) => r.id === record.id)) return; // 幂等：已提交过
    appendRecord(store, record);
    pushHabitNotice(record);
    committed += 1;
  });
  if (committed > 0) writeHabitStore(store);
  return committed;
}

/* ------------------------------------------------------------------ */
/* 记录查询与撤销                                                       */
/* ------------------------------------------------------------------ */

/** 仍可撤销的记录（auto 且未撤销 且未过 undoUntil） */
export function listRestorableRecords(now: number = Date.now()): HabitGuardRecord[] {
  return readHabitStore().records.filter(
    (r) => r.auto && !r.undone && !!r.undoUntil && dayjs(now).valueOf() <= dayjs(r.undoUntil).valueOf()
  );
}

/**
 * 撤销一次自动挪动：标记记录为已撤销，并返回可用的还原信息（fromTime）。
 * - 限定 `auto` 记录：提议（auto=false）无挪动可撤；
 * - 已撤销 / 找不到 返回 ok=false；
 * - 超过 `undoUntil` 返回 ok=false（过期不能撤销）。
 * 实际把日程改回 fromTime 由调用方经既有 apiApplyPlan 通道完成。
 */
export function undoHabitGuard(recordId: string, now: number = Date.now()): HabitUndoResult {
  const store = readHabitStore();
  const record = store.records.find((r) => r.id === recordId) ?? null;
  if (!record || !record.auto || record.undone) return { ok: false, record };
  if (!record.undoUntil || dayjs(now).valueOf() > dayjs(record.undoUntil).valueOf()) {
    return { ok: false, record };
  }
  const next: HabitGuardRecord = { ...record, undone: true };
  store.records = store.records.map((r) => (r.id === recordId ? next : r));
  writeHabitStore(store);
  return { ok: true, record: next };
}

/* ------------------------------------------------------------------ */
/* 站内信（独立 key mb_habit_notices + 独立类型）                        */
/* ------------------------------------------------------------------ */

/** 写一条习惯站内信（最新在前；超上限丢最旧的已读条目，无已读则截断） */
export function pushHabitNotice(record: HabitGuardRecord): void {
  const notice: HabitNotice = {
    id: nextId('hn'),
    titleKey: 'habit.noticeTitle',
    bodyKey: 'habit.noticeBody',
    params: { title: record.title, date: record.date, time: dayjs(record.toTime).format('HH:mm') },
    habitId: record.habitId,
    recordId: record.id,
    read: false,
    createdAt: dayjs(record.createdAt).format('YYYY-MM-DD')
  };
  const list = listHabitNotices();
  let next = [notice, ...list];
  if (next.length > HABIT_NOTICE_MAX) {
    const readIdx = [...next].reverse().findIndex((n) => n.read);
    if (readIdx >= 0) {
      const dropId = [...next].reverse()[readIdx].id;
      next = next.filter((n) => n.id !== dropId);
    } else {
      next = next.slice(0, HABIT_NOTICE_MAX);
    }
  }
  try {
    Taro.setStorageSync(HABIT_NOTICE_KEY, next);
  } catch (err) {
    console.warn('[habit] push notice failed:', err);
  }
}

/** 站内信列表（最新在前；读失败返回空数组，脏数据过滤） */
export function listHabitNotices(): HabitNotice[] {
  try {
    const raw = Taro.getStorageSync(HABIT_NOTICE_KEY);
    if (Array.isArray(raw)) {
      return raw.filter(
        (n): n is HabitNotice => !!n && typeof (n as HabitNotice).id === 'string' && typeof (n as HabitNotice).recordId === 'string'
      );
    }
  } catch (err) {
    console.warn('[habit] read notices failed:', err);
  }
  return [];
}

/** 标记单条站内信已读 */
export function markHabitNoticeRead(id: string): void {
  const next = listHabitNotices().map((n) => (n.id === id ? { ...n, read: true } : n));
  try {
    Taro.setStorageSync(HABIT_NOTICE_KEY, next);
  } catch (err) {
    console.warn('[habit] mark notice read failed:', err);
  }
}

