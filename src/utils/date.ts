import dayjs from 'dayjs';

/**
 * 原先的 `getGreeting(hour)` 已删除（2026-10-24）。
 *
 * 删除原因（两条，都实测过）：
 * 1. **文案谎报**：12–14 点固定返回「中午好，下午的日程在这」、14–18 点返回
 *    「下午好，别忘了待办清单」—— 当天根本没有日程/待办时，用户第一眼看到的就是
 *    一句不成立的事实（视觉巡检截图：首屏只有情报，问候语却说日程在这）。
 * 2. **假 i18n**：返回值是硬编码中文，英文界面（lang='en'）同样显示中文。
 *
 * 现在问候语由 `pages/briefing` 的 `headerGreeting` 组合：时间基调来自 `greet.*`
 * i18n 键（中英各一份），事实部分来自真实数据（接下来哪条日程 / 今天无安排 / 剩余待办数）。
 * 这样「头部说的每句话」都有数据依据，且跟随语言切换。
 */

/** 格式化事件时间显示：今天/明天/X月X日 HH:mm */
export function formatEventTime(time: string): string {
  const d = dayjs(time);
  if (!d.isValid()) return time;
  const today = dayjs().startOf('day');
  const diff = d.diff(today, 'day');
  const hm = d.format('HH:mm');
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  return d.format('M月D日 HH:mm');
}

/**
 * 是否同一自然日（本地时区）。
 *
 * 实现口径：两个时刻各自 `format('YYYY-MM-DD')` 后字符串比较 —— 这是 habit.ts 原本
 * 在用的语义（`utils/habit.ts:353`，被 `isLowRiskCandidate` 调用），保留它、不要在用的
 * 那个语义先动；原 `dayjs(a).isSame(dayjs(b),'day')` 版本全仓无人调用，已删除死实现。
 *
 * ⚠️ 与 `isSame('day')` 的差异仅在**非法输入**：两个都非法时 format 比较返回 true
 * （'Invalid Date' === 'Invalid Date'），而 isSame 返回 false。在用方传的都是合法时间串，
 * 故采用 format 口径不改变既有行为。
 */
export function isSameDay(a: string | Date, b: string | Date): boolean {
  return dayjs(a).format('YYYY-MM-DD') === dayjs(b).format('YYYY-MM-DD');
}

/**
 * 当前自然月 'YYYY-MM'（本地时区，两位月）。
 * 统一 learn / usage / subscription 三处散落的当月串拼装，输出格式不变。
 */
export function currentMonth(now?: Date): string {
  return dayjs(now).format('YYYY-MM');
}

/** 相对时间显示：收藏列表用 */
export function fromNow(time: string): string {
  const d = dayjs(time);
  if (!d.isValid()) return time;
  const diffMinutes = dayjs().diff(d, 'minute');
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = dayjs().diff(d, 'hour');
  if (diffHours < 24) return `${diffHours} 小时前`;
  const diffDays = dayjs().diff(d, 'day');
  if (diffDays < 30) return `${diffDays} 天前`;
  return d.format('YYYY-MM-DD');
}

/* ------------------------------------------------------------------ *
 * 自然日工具（2026-10-24 新增，供「功能记账」与「续费管理」共用）
 *
 * 为什么不用 toISOString().slice(0,10)：那是 **UTC** 日期。北京时间 10-24 07:00
 * 之前（UTC 还是 10-23）记账会落到前一天；到期提醒同样会把"今天到期"算成"已过期"。
 * ------------------------------------------------------------------ */

/** 本地时区的 'YYYY-MM-DD' */
export function dayKey(now: number | Date = Date.now()): string {
  return dayjs(now).format('YYYY-MM-DD');
}

/**
 * 把 'YYYY-MM-DD' 映射成"自 1970-01-01 起的第几天"（整数），用于做日历日差。
 * 用 `Date.UTC(y, m-1, d)` 而不是本地时间相减：夏令时切换那天只有 23 小时，
 * 直接相减会得到 0.958 天 → 四舍五入后偶尔差 1 天。
 * 严格校验：'2026-02-31' 会被 dayjs 顺延成 3-03，所以回写比对一次，不一致就当非法输入。
 */
export function dayIndex(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = dayjs(day);
  if (!dt.isValid() || dt.format('YYYY-MM-DD') !== day) return null;
  return Math.round(Date.UTC(y, mo - 1, d) / 86400000);
}

/** 自然日加减（delta 可为负）；非法输入原样返回，不抛错 */
export function shiftDay(day: string, delta: number): string {
  const idx = dayIndex(day);
  if (idx === null) return day;
  // ⚠️ 这里必须走 getUTC*：day index 是按 UTC 整数天定义的，
  // 用本地 getFullYear 的话在 UTC-5 时区会整体退一天（1970-01-01T00:00Z = 1969-12-31 本地）。
  const d = new Date((idx + Math.trunc(delta)) * 86400000);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** toDay - fromDay（整数天）；任一非法返回 null（调用方必须显式处理 null，不能当 0） */
export function daysBetween(fromDay: string, toDay: string): number | null {
  const a = dayIndex(fromDay);
  const b = dayIndex(toDay);
  if (a === null || b === null) return null;
  return b - a;
}
