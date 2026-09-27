/**
 * 排班建议与方案（S-01~S-04）
 *
 * 职责边界：
 * - 本模块只做**纯逻辑**（候选生成 / 排序 / 冲突检测 / 方案组装），不碰 Storage、不发请求。
 * - 前端「最小可用类型」定义在 `src/services/api.ts`（T00 批次交付），本文件在其基础上
 *   扩展出 UI 所需的富字段（busyness / reason / score / conflict …），**不重复定义**，避免双份类型漂移。
 * - 旧的 `suggestSlots()` 作为兼容导出保留（`src/pages/inbox` 与 `detectConflicts` 在用）。
 */
import dayjs from 'dayjs';
import type { ScheduleEvent } from '@/types';
import type {
  PlanApplyEvent,
  PlanProposal as PlanProposalBase,
  PlanProposalItem as PlanProposalItemBase,
  SlotCandidate as SlotCandidateBase
} from '@/services/api';

// 重新导出：UI 组件（PlanProposalCard / inbox / AiAssistant）统一从本模块取类型，
// 避免各处再单独 import @/services/api 造成契约面分散。
export type { PlanApplyEvent, PlanApplyPayload, PlanApplyResult } from '@/services/api';

/* ------------------------------------------------------------------ */
/* 常量（禁止魔法数字，全部导出）                                        */
/* ------------------------------------------------------------------ */

/** 候选时段返回条数（PRD S-03：前 3 个） */
export const PLAN_CANDIDATE_LIMIT = 3;
/** 旧 `suggestSlots()` 的返回条数，保持向后兼容 */
export const LEGACY_SUGGEST_LIMIT = 2;
/** 常规扫描窗口起止小时 */
export const SLOT_SCAN_START_HOUR = 9;
export const SLOT_SCAN_END_HOUR = 18;
/** 扩窗后的起止小时（PRD S-04：08:00–21:00） */
export const EXTENDED_SCAN_START_HOUR = 8;
export const EXTENDED_SCAN_END_HOUR = 21;
/** 缺省时长（分钟）：未给 endTime 时按 90 分钟 */
export const DEFAULT_DURATION_MINUTES = 90;
/** 时长下限（分钟） */
export const MIN_DURATION_MINUTES = 30;
/** 当日已有日程数达到该值即标记 crowded（PRD S-03「当日已有 N 个日程」） */
export const CROWDED_DAY_EVENT_COUNT = 3;
/** S-04 次日兜底最多向后扫的天数 */
export const NEXT_DAY_SCAN_MAX_DAYS = 7;
/** 留白计分上限（分钟）：超过按上限算 */
export const MAX_BUFFER_MINUTES = 240;
/** 单侧无日程时的留白计分（分钟）：按 0 计——无参照就不宣称留白，理由自然落到「最早可用」 */
export const DEFAULT_EDGE_BUFFER_MINUTES = 0;
/** 系统产出时间与相邻事件的最小间隙（分钟）：提案槽位 / 一键重排的新时段须与前后相邻事件各留 ≥ 该值（P1-F）。
 *  注意：只约束**系统产出**的新时段；isOverlap 语义不变（严格重叠才算冲突），日历冲突条口径不动。 */
export const SCHED_GAP_BUFFER_MINUTES = 10;
/** 方案条目标题最大长度 */
export const PLAN_ITEM_TITLE_MAX = 30;

/** 排序基准分：空闲 / 拥挤 / 冲突 */
export const SCORE_BASE_FREE = 100;
export const SCORE_BASE_CROWDED = 55;
export const SCORE_BASE_CLASH = 10;
/** 命中常用时段的加分 */
export const SCORE_HABIT_BONUS = 25;
/** 留白加分上限 */
export const SCORE_MAX_BUFFER_BONUS = 30;
/** 「最早可用」加分上限 */
export const SCORE_MAX_EARLIEST_BONUS = 20;
/** 「最早可用」每往后 1 小时衰减的分数 */
export const SCORE_EARLIEST_DECAY_PER_HOUR = 2;
/** 上午/下午分界小时（含） */
export const NOON_HOUR = 12;
/** `suggestSlotCandidates` 传该值表示不做截断，返回全部扫描结果 */
export const SCAN_NO_LIMIT = -1;

/* ------------------------------------------------------------------ */
/* 类型（在 api.ts 最小集上扩展）                                        */
/* ------------------------------------------------------------------ */

/** 忙闲标记（PRD S-03） */
export type Busyness = 'free' | 'clash' | 'crowded';

/** 排序理由（三选一，PRD S-03） */
export type SlotReason = 'earliest' | 'habit' | 'buffer';

/** 常用时段画像 */
export type HabitPeriod = 'am' | 'pm';

/** 候选时段：在 api.ts 最小集（startTime/endTime）上补齐展示所需字段 */
export interface SlotCandidate extends SlotCandidateBase {
  busyness: Busyness;
  /** busyness='clash' 时：冲突日程标题 */
  clashTitle?: string;
  /** busyness='crowded' 时：当日已有日程数 */
  dayCount?: number;
  reason: SlotReason;
  /** 排序分值（越大越靠前） */
  score: number;
  /** 前后留白总分钟数（用于 buffer 理由与分值） */
  bufferMinutes: number;
  /** reason='habit' 时命中 am / pm */
  habitPeriod?: HabitPeriod;
}

/** 冲突标记（UI 上 ⚠️ / ✅） */
export interface ConflictMark {
  clashTitle: string;
  clashTime: string;
}

/** 方案条目：在 api.ts 最小集上补齐 key / 冲突 / 勾选态 / 候选面板态 */
export interface PlanProposalItem extends PlanProposalItemBase {
  /** React key 与就地改时段时的定位键 */
  key: string;
  /** 原时间（UI 删除线）；新建日程时为 '' */
  fromTime: string;
  /** 新时间（UI 高亮） */
  toTime: string;
  conflict: ConflictMark | null;
  /** 默认 true（PRD S-01 默认全选） */
  checked: boolean;
  candidates: SlotCandidate[];
  /** 候选面板是否就地展开 */
  candidatesOpen: boolean;
  /** true = 该条已走 S-04 次日兜底 */
  dayShifted: boolean;
  /** P1-F：true = 该条时段在找不到「与相邻事件 ≥ SCHED_GAP_BUFFER_MINUTES 间隙」的候选时，回退为无缓冲候选（提案 UI 据此标注） */
  noBufferFallback?: boolean;
}

/** 排班方案：AI 只提议，勾选后才由 apiApplyPlan 落库 */
export interface PlanProposal extends PlanProposalBase {
  id: string;
  items: PlanProposalItem[];
  /** true = 走了 08:00–21:00 扩窗或次日兜底（PRD S-04） */
  extended: boolean;
  /** P1-F：true = 任一条目回退为无缓冲候选（提案 UI 据此标注） */
  noBufferFallback: boolean;
  createdAt: string;
}

/** chat 云函数 action='plan' 返回的原始条目 */
export interface PlanProposalRaw {
  title: string;
  fromTime?: string;
  toTime: string;
  endTime?: string;
  eventId?: string;
  /** P1-F：调用方（如日历一键重排）已标注该 toTime 为无缓冲回退时段 */
  noBufferFallback?: boolean;
}

export interface SuggestOptions {
  /** 返回候选条数，默认 3（PRD S-03）；传 SCAN_NO_LIMIT 表示不截断 */
  limit?: number;
  /** 扩窗：默认 false = 09:00–18:00；true = 08:00–21:00（PRD S-04） */
  extended?: boolean;
  /** 用户常用时段画像（habit 理由用） */
  habitPeriod?: HabitPeriod | null;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

let planSeq = 0;

/** 生成单调递增的本地 id（React key / 方案 id） */
function nextId(prefix: string): string {
  planSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${planSeq}`;
}

/** `${day} HH:00` 形式的时间戳 */
function slotLabel(day: string, hour: number): string {
  return `${day} ${String(hour).padStart(2, '0')}:00`;
}

/** 把 'YYYY-MM-DD HH:mm' 整体平移若干天（S-04 次日兜底用） */
function shiftDays(time: string, days: number): string {
  if (!time || days === 0) return time;
  const d = dayjs(time);
  return d.isValid() ? d.add(days, 'day').format('YYYY-MM-DD HH:mm') : time;
}

/** 事件结束时间：缺省按开始 + 90 分钟 */
function eventEnd(startTime: string, endTime?: string): number {
  const fallback = dayjs(startTime).add(DEFAULT_DURATION_MINUTES, 'minute').format('YYYY-MM-DD HH:mm');
  return dayjs(endTime && dayjs(endTime).isValid() ? endTime : fallback).valueOf();
}

/** 当日已有日程数 */
function countDayEvents(day: string, existing: ScheduleEvent[]): number {
  return existing.filter((ex) => !!ex && !!ex.startTime && dayjs(ex.startTime).format('YYYY-MM-DD') === day).length;
}

/**
 * 前后留白：与前一日程结束的间隔 + 与后一日程开始的间隔（分钟）。
 * 单侧无日程时按 DEFAULT_EDGE_BUFFER_MINUTES 计；总时长封顶 MAX_BUFFER_MINUTES。
 */
function computeBufferMinutes(startTime: string, endTime: string, existing: ScheduleEvent[]): number {
  const startMs = dayjs(startTime).valueOf();
  const endMs = dayjs(endTime).valueOf();
  let prevGap = DEFAULT_EDGE_BUFFER_MINUTES;
  let nextGap = DEFAULT_EDGE_BUFFER_MINUTES;
  existing.forEach((ex) => {
    if (!ex || !ex.startTime) return;
    const exStart = dayjs(ex.startTime).valueOf();
    const exEnd = eventEnd(ex.startTime, ex.endTime);
    if (exEnd <= startMs) {
      prevGap = Math.min(prevGap, (startMs - exEnd) / 60000);
    } else if (exStart >= endMs) {
      nextGap = Math.min(nextGap, (exStart - endMs) / 60000);
    }
  });
  const total = Math.max(0, prevGap) + Math.max(0, nextGap);
  return Math.round(Math.min(total, MAX_BUFFER_MINUTES));
}

interface ScoreBreakdown {
  score: number;
  reason: SlotReason;
  habitMatched: boolean;
}

/**
 * 单条候选打分：基准分（忙闲）+ 留白 + 最早可用 + 常用时段。
 * 理由取贡献最大的一项，同分时优先级 habit > buffer > earliest。
 */
function scoreSlot(
  hour: number,
  scanStartHour: number,
  busyness: Busyness,
  bufferMinutes: number,
  habit: HabitPeriod | null
): ScoreBreakdown {
  const base =
    busyness === 'free' ? SCORE_BASE_FREE : busyness === 'crowded' ? SCORE_BASE_CROWDED : SCORE_BASE_CLASH;
  const clampedBuffer = Math.min(Math.max(bufferMinutes, 0), MAX_BUFFER_MINUTES);
  const bufferScore = Math.round((clampedBuffer / MAX_BUFFER_MINUTES) * SCORE_MAX_BUFFER_BONUS);
  const hourOffset = Math.max(0, hour - scanStartHour);
  const earliestScore = Math.max(0, SCORE_MAX_EARLIEST_BONUS - hourOffset * SCORE_EARLIEST_DECAY_PER_HOUR);
  const habitMatched = !!habit && (habit === 'am' ? hour < NOON_HOUR : hour >= NOON_HOUR);
  const habitScore = habitMatched ? SCORE_HABIT_BONUS : 0;
  const reason: SlotReason = habitMatched ? 'habit' : bufferScore > earliestScore ? 'buffer' : 'earliest';
  return { score: base + bufferScore + earliestScore + habitScore, reason, habitMatched };
}

/** 按分值降序、同分按时间升序稳定排序 */
function rankSlots(list: SlotCandidate[]): SlotCandidate[] {
  return list.slice().sort((a, b) => b.score - a.score || (a.startTime < b.startTime ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* 对外：冲突检测与候选生成                                             */
/* ------------------------------------------------------------------ */

/** 排班冲突信息 */
export interface ConflictInfo {
  /** 对应待确认条目的 key */
  draftKey: string;
  title: string;
  startTime: string;
  endTime: string;
  /** 与之冲突的现有日程 */
  clashTitle: string;
  clashTime: string;
  /** 建议的空闲时段（'YYYY-MM-DD HH:mm'） */
  suggestions: string[];
}

/** 判断两个时间区间是否重叠（缺省 endTime 按开始时间 + 90 分钟） */
export function isOverlap(
  aStart: string,
  aEnd: string | undefined,
  bStart: string,
  bEnd: string | undefined
): boolean {
  const as = dayjs(aStart).valueOf();
  const ae = eventEnd(aStart, aEnd);
  const bs = dayjs(bStart).valueOf();
  const be = eventEnd(bStart, bEnd);
  return as < be && bs < ae;
}

/**
 * P1-F：候选时段是否与所有事件保持 ≥ gapMinutes 分钟间隙（不背靠背）。
 * - 与某事件重叠（isOverlap 语义）视为不满足（调用方本就应先排除 clash）；
 * - 前后无事件的一侧视为满足（无边可贴）；
 * - gapMinutes ≤ 0 时恒为 true（等价于仅不重叠）。
 */
export function hasGapBuffer(
  startTime: string,
  endTime: string | undefined,
  events: Array<{ startTime: string; endTime?: string }>,
  gapMinutes: number = SCHED_GAP_BUFFER_MINUTES
): boolean {
  if (gapMinutes <= 0) return true;
  const startMs = dayjs(startTime).valueOf();
  if (!Number.isFinite(startMs)) return true;
  const endMs = eventEnd(startTime, endTime);
  const minGapMs = gapMinutes * 60000;
  const list = Array.isArray(events) ? events : [];
  return list.every((ex) => {
    if (!ex || !ex.startTime) return true;
    const exStart = dayjs(ex.startTime).valueOf();
    const exEnd = eventEnd(ex.startTime, ex.endTime);
    if (exEnd <= startMs) return startMs - exEnd >= minGapMs;
    if (exStart >= endMs) return exStart - endMs >= minGapMs;
    return false; // 重叠
  });
}

/** 与现有日程做冲突检测，返回冲突列表 */
export function detectConflicts(
  candidates: Array<{ key: string; title: string; startTime: string; endTime?: string }>,
  existing: ScheduleEvent[]
): ConflictInfo[] {
  const list = Array.isArray(existing) ? existing : [];
  const conflicts: ConflictInfo[] = [];
  (Array.isArray(candidates) ? candidates : []).forEach((c) => {
    if (!c || !c.startTime) return;
    const endDayjs = c.endTime ? dayjs(c.endTime) : null;
    const endTime =
      endDayjs && endDayjs.isValid()
        ? endDayjs.format('YYYY-MM-DD HH:mm')
        : dayjs(c.startTime).add(DEFAULT_DURATION_MINUTES, 'minute').format('YYYY-MM-DD HH:mm');
    list.forEach((ex) => {
      if (!ex || !isOverlap(c.startTime, c.endTime, ex.startTime, ex.endTime)) return;
      conflicts.push({
        draftKey: c.key,
        title: c.title,
        startTime: c.startTime,
        endTime,
        clashTitle: ex.title,
        clashTime: `${dayjs(ex.startTime).format('MM-DD HH:mm')}${
          ex.endTime ? `-${dayjs(ex.endTime).format('HH:mm')}` : ''
        }`,
        suggestions: suggestSlots(c.startTime, c.endTime, list)
      });
    });
  });
  return conflicts;
}

/**
 * 生成 ranked 候选：按事件时长在扫描窗口内逐格推进，
 * 每条带忙闲标记、排序理由与分值，返回前 `limit` 个。
 */
export function suggestSlotCandidates(
  startTime: string,
  endTime: string | undefined,
  existing: ScheduleEvent[],
  options: SuggestOptions = {}
): SlotCandidate[] {
  const limit = typeof options.limit === 'number' ? options.limit : PLAN_CANDIDATE_LIMIT;
  const start = dayjs(startTime);
  if (!start.isValid()) return [];
  const endDayjs = endTime ? dayjs(endTime) : null;
  const endMs =
    endDayjs && endDayjs.isValid()
      ? endDayjs.valueOf()
      : start.add(DEFAULT_DURATION_MINUTES, 'minute').valueOf();
  const duration = Math.max(MIN_DURATION_MINUTES, Math.round((endMs - start.valueOf()) / 60000) || DEFAULT_DURATION_MINUTES);
  const list = Array.isArray(existing) ? existing.filter((ex) => !!ex && !!ex.startTime) : [];
  const scanStart = options.extended ? EXTENDED_SCAN_START_HOUR : SLOT_SCAN_START_HOUR;
  const scanEnd = options.extended ? EXTENDED_SCAN_END_HOUR : SLOT_SCAN_END_HOUR;
  const day = start.format('YYYY-MM-DD');
  const dayCount = countDayEvents(day, list);
  const habit = options.habitPeriod || null;

  const scanned: SlotCandidate[] = [];
  for (let hour = scanStart; hour <= scanEnd; hour += 1) {
    const slotStart = slotLabel(day, hour);
    const slotEnd = dayjs(slotStart).add(duration, 'minute').format('YYYY-MM-DD HH:mm');
    const clash = list.find((ex) => isOverlap(slotStart, slotEnd, ex.startTime, ex.endTime));
    const busyness: Busyness = clash ? 'clash' : dayCount >= CROWDED_DAY_EVENT_COUNT ? 'crowded' : 'free';
    const bufferMinutes = computeBufferMinutes(slotStart, slotEnd, list);
    const breakdown = scoreSlot(hour, scanStart, busyness, bufferMinutes, habit);
    scanned.push({
      startTime: slotStart,
      endTime: slotEnd,
      busyness,
      clashTitle: clash ? clash.title : undefined,
      dayCount: busyness === 'crowded' ? dayCount : undefined,
      reason: breakdown.reason,
      score: breakdown.score,
      bufferMinutes,
      habitPeriod: breakdown.habitMatched && habit ? habit : undefined
    });
  }

  const ranked = rankSlots(scanned);
  return limit === SCAN_NO_LIMIT ? ranked : ranked.slice(0, Math.max(0, limit));
}

/**
 * 兼容旧调用：只返回时间字符串数组（内部转调 suggestSlotCandidates）。
 * 与原实现保持一致：最多 2 条、且只返回不冲突的时段。
 */
export function suggestSlots(
  startTime: string,
  endTime: string | undefined,
  existing: ScheduleEvent[]
): string[] {
  return suggestSlotCandidates(startTime, endTime, existing, { limit: LEGACY_SUGGEST_LIMIT })
    .filter((c) => c.busyness !== 'clash')
    .map((c) => c.startTime);
}

/** 由已有日程推断常用时段（上午 / 下午）；无法区分时返回 null */
export function inferHabitPeriod(existing: ScheduleEvent[]): HabitPeriod | null {
  const list = (Array.isArray(existing) ? existing : []).filter((ex) => !!ex && !!ex.startTime);
  if (list.length === 0) return null;
  let am = 0;
  let pm = 0;
  list.forEach((ex) => {
    if (dayjs(ex.startTime).hour() < NOON_HOUR) am += 1;
    else pm += 1;
  });
  if (am === pm) return null;
  return am > pm ? 'am' : 'pm';
}

/* ------------------------------------------------------------------ */
/* S-04 兜底：常规窗口 → 扩窗 → 次日                                     */
/* ------------------------------------------------------------------ */

interface PickResult {
  candidates: SlotCandidate[];
  /** 走了扩窗或次日兜底 */
  extended: boolean;
  /** 已延到次日 */
  dayShifted: boolean;
  /** P1-F：true = 本层无「≥间隙」候选，已回退为无缓冲候选 */
  noBufferFallback: boolean;
}

/**
 * 三级兜底选候选：
 * ① 09:00–18:00 常规窗口
 * ② 08:00–21:00 扩窗重试一次（PRD S-04）
 * ③ 次日（最多向后 NEXT_DAY_SCAN_MAX_DAYS 天）最早 3 个
 * 非冲突候选取满 limit 后，若仍有空位则用冲突候选补齐（S-03 忙闲对比），**不会静默返回空**。
 * P1-F：优先取「与相邻事件各留 ≥ SCHED_GAP_BUFFER_MINUTES」的候选；该层完全没有时回退为
 * 无缓冲候选并置 noBufferFallback 标记（不允许直接失败）。打分体系不变——buffer 只影响候选能否入选，不重新打分。
 */
function pickCandidates(
  startTime: string,
  endTime: string | undefined,
  existing: ScheduleEvent[],
  habit: HabitPeriod | null,
  limit: number
): PickResult {
  const tiers: Array<{ extended: boolean; dayOffset: number }> = [
    { extended: false, dayOffset: 0 },
    { extended: true, dayOffset: 0 }
  ];
  for (let dayOffset = 1; dayOffset <= NEXT_DAY_SCAN_MAX_DAYS; dayOffset += 1) {
    tiers.push({ extended: true, dayOffset });
  }

  let lastScanned: SlotCandidate[] = [];
  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    const scanned = suggestSlotCandidates(
      shiftDays(startTime, tier.dayOffset),
      endTime ? shiftDays(endTime, tier.dayOffset) : undefined,
      existing,
      { limit: SCAN_NO_LIMIT, extended: tier.extended, habitPeriod: habit }
    );
    lastScanned = scanned;
    if (scanned.length === 0) continue;
    const usable = scanned.filter((c) => c.busyness !== 'clash');
    if (usable.length === 0) continue;
    // P1-F：先取带间隙的候选；一个都没有才回退无缓冲并标注
    const buffered = usable.filter((c) => hasGapBuffer(c.startTime, c.endTime, existing));
    const noBufferFallback = buffered.length === 0;
    const picked = noBufferFallback ? usable : buffered;
    // 可用项优先；不足 limit 时用冲突项补齐，保留忙闲对比
    const merged = picked.slice(0, limit).concat(
      rankSlots(scanned.filter((c) => c.busyness === 'clash')).slice(0, Math.max(0, limit - Math.min(picked.length, limit)))
    );
    return {
      candidates: rankSlots(merged).slice(0, limit),
      extended: tier.extended || tier.dayOffset > 0,
      dayShifted: tier.dayOffset > 0,
      noBufferFallback
    };
  }

  // 兜底：扫描窗口必然产出时段，理论上不可达；仍保险返回一批（含冲突项）而非空数组
  return { candidates: rankSlots(lastScanned).slice(0, limit), extended: true, dayShifted: false, noBufferFallback: false };
}

/* ------------------------------------------------------------------ */
/* 方案组装 / 刷新 / 批准                                               */
/* ------------------------------------------------------------------ */

/** 单条时间是否与现有日程冲突，返回 ConflictMark */
function findConflict(
  title: string,
  startTime: string,
  endTime: string | undefined,
  existing: ScheduleEvent[]
): ConflictMark | null {
  if (!startTime) return null;
  const found = detectConflicts([{ key: 'probe', title, startTime, endTime }], existing);
  if (found.length === 0) return null;
  return { clashTitle: found[0].clashTitle, clashTime: found[0].clashTime };
}

/**
 * 由云函数原始提案构建完整方案：补候选、跑冲突检测、默认全选、写 extended 标记。
 * 每个条目：AI 给的 toTime 若不冲突且与相邻事件留有 ≥ SCHED_GAP_BUFFER_MINUTES 间隙则沿用，
 * 否则自动落到排名第一的可用候选（P1-F 优先带间隙候选，全无则回退无缓冲并标注）。
 */
export function buildPlanProposal(
  raw: PlanProposalRaw[],
  existing: ScheduleEvent[]
): PlanProposal {
  const list = Array.isArray(existing) ? existing.filter((ex) => !!ex && !!ex.startTime) : [];
  const habit = inferHabitPeriod(list);
  const rawList = Array.isArray(raw) ? raw : [];
  const extendedFlags: boolean[] = [];

  const items: PlanProposalItem[] = rawList.map((r, _index) => {
    const title = String((r && r.title) || '').slice(0, PLAN_ITEM_TITLE_MAX);
    const preferred = String((r && r.toTime) || '');
    const fromTime = String((r && r.fromTime) || '');
    const endTime = r && r.endTime ? String(r.endTime) : undefined;
    const picked = preferred
      ? pickCandidates(preferred, endTime, list, habit, PLAN_CANDIDATE_LIMIT)
      : { candidates: [] as SlotCandidate[], extended: false, dayShifted: false, noBufferFallback: false };
    extendedFlags.push(picked.extended);

    const preferredFree = preferred ? findConflict(title, preferred, endTime, list) === null : false;
    // P1-F：无冲突但与相邻事件贴边（< SCHED_GAP_BUFFER_MINUTES）的原时段不直接沿用，优先落到带间隙的候选
    const preferredGapOk = preferred ? hasGapBuffer(preferred, endTime, list) : true;
    const preferredOk = preferredFree && preferredGapOk;
    const toTime = preferredOk || picked.candidates.length === 0 ? preferred : picked.candidates[0].startTime;

    return {
      key: nextId('planItem'),
      title,
      fromTime,
      toTime,
      endTime,
      eventId: r && r.eventId ? String(r.eventId) : undefined,
      conflict: findConflict(title, toTime, endTime, list),
      checked: true,
      candidates: picked.candidates,
      candidatesOpen: false,
      dayShifted: picked.dayShifted,
      // P1-F：pickCandidates 回退无缓冲，或沿用调用方已标注的无缓冲 toTime（仅当 toTime 未被替换时）
      noBufferFallback: picked.noBufferFallback || (!!r && r.noBufferFallback === true && toTime === preferred) || undefined
    };
  });

  return {
    id: nextId('plan'),
    title: '',
    items,
    extended: extendedFlags.some(Boolean),
    noBufferFallback: items.some((it) => !!it.noBufferFallback),
    createdAt: dayjs().format('YYYY-MM-DD HH:mm')
  };
}

/** 勾选变化或改时段后重跑冲突检测，返回新对象（不可变） */
export function refreshProposalConflicts(
  proposal: PlanProposal,
  existing: ScheduleEvent[]
): PlanProposal {
  const list = Array.isArray(existing) ? existing.filter((ex) => !!ex && !!ex.startTime) : [];
  const items = (proposal && Array.isArray(proposal.items) ? proposal.items : []).map((item) => ({
    ...item,
    conflict: findConflict(item.title, item.toTime, item.endTime, list)
  }));
  return { ...proposal, items };
}

/** 勾选 / 取消勾选某条（不传 checked 时取反），返回新对象 */
export function toggleItemChecked(
  proposal: PlanProposal,
  key: string,
  checked?: boolean
): PlanProposal {
  const items = (proposal && Array.isArray(proposal.items) ? proposal.items : []).map((item) =>
    item.key === key ? { ...item, checked: typeof checked === 'boolean' ? checked : !item.checked } : item
  );
  return { ...proposal, items };
}

/** 全选 / 全不选 */
export function setAllChecked(proposal: PlanProposal, checked: boolean): PlanProposal {
  const items = (proposal && Array.isArray(proposal.items) ? proposal.items : []).map((item) => ({
    ...item,
    checked
  }));
  return { ...proposal, items };
}

/** 展开 / 收起某条的候选面板（不传 open 时取反），返回新对象 */
export function toggleCandidatesOpen(
  proposal: PlanProposal,
  key: string,
  open?: boolean
): PlanProposal {
  const items = (proposal && Array.isArray(proposal.items) ? proposal.items : []).map((item) => {
    if (item.key !== key) return item;
    return {
      ...item,
      candidatesOpen: typeof open === 'boolean' ? open : !item.candidatesOpen
    };
  });
  return { ...proposal, items };
}

/** 点选候选：就地写入该条时间并刷新冲突标记，同时折叠面板（PRD S-02：无需二次确认） */
export function selectCandidate(
  proposal: PlanProposal,
  key: string,
  candidate: SlotCandidate,
  existing: ScheduleEvent[]
): PlanProposal {
  const updated = {
    ...proposal,
    items: (proposal && Array.isArray(proposal.items) ? proposal.items : []).map((item) =>
      item.key === key
        ? {
            ...item,
            toTime: candidate.startTime,
            endTime: candidate.endTime,
            candidatesOpen: false
          }
        : item
    )
  };
  return refreshProposalConflicts(updated, existing);
}

/** 批准：只输出选中项，未选中项不进 payload（可直接透传 apiApplyPlan） */
export function applyProposal(proposal: PlanProposal): { events: PlanApplyEvent[]; count: number } {
  const items = proposal && Array.isArray(proposal.items) ? proposal.items : [];
  const events: PlanApplyEvent[] = [];
  items.forEach((item) => {
    if (!item || !item.checked || !item.toTime) return;
    events.push({
      eventId: item.eventId,
      title: item.title,
      startTime: item.toTime,
      endTime: item.endTime
    });
  });
  return { events, count: events.length };
}

/** 是否可批准（全部取消勾选时置灰，PRD S-02） */
export function canApprove(proposal: PlanProposal): boolean {
  const items = proposal && Array.isArray(proposal.items) ? proposal.items : [];
  return items.some((item) => !!item && item.checked && !!item.toTime);
}

/** 已勾选条数（按钮文案「仅批准选中项 (N)」用） */
export function checkedCount(proposal: PlanProposal): number {
  const items = proposal && Array.isArray(proposal.items) ? proposal.items : [];
  return items.filter((item) => !!item && item.checked && !!item.toTime).length;
}
