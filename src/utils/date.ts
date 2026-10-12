import dayjs from 'dayjs';

/** 晨报问候语：按小时返回 */
export function getGreeting(hour: number): string {
  if (hour < 6) return '夜深了，先看看明天的安排';
  if (hour < 11) return '早上好，新的一天从晨报开始';
  if (hour < 14) return '中午好，下午的日程在这';
  if (hour < 18) return '下午好，别忘了待办清单';
  return '晚上好，为明天做好准备';
}

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
