// ============================================
// 日历 .ics 导出（2026-10-31）：把晨报/日历里的日程与待办导出成标准 iCalendar 文本。
// 产品评估 §7.2 C ——「读系统日历」微信平台没有 API，此前只有「单向写入」（addPhoneCalendar，
// 仅 weapp）；.ics 导出让 H5 用户也能把日程带进系统日历/谷歌日历（导入一次即可）。
// 为何不做「订阅链接」：H5 是纯静态托管，没有能按用户出私有小日历文件的服务端，
// 做成 URL 等于把私人日程公开挂在网上 —— 因此 v1 只做**一次性文件导出**，这是诚实边界。
//
// 纯函数、零运行时依赖。RFC 5545 要点：
//   · 文本转义：反斜杠 / 分号 / 逗号 / 换行（漏一个，Outlook 整行解析错）
//   · 浮动本地时间（无 Z 后缀的 DATE-TIME）：导入端按本地时区解释，符合「日程本来就是本地时间」
//   · 行长不折行：主流解析器均接受长行，折行实现错反而更糟
// ============================================
import type { ScheduleEvent, TodoItem } from '../types';

/** RFC 5545 §3.3.11 TEXT 转义：反斜杠 → 分号 → 逗号 → 换行（顺序无关紧要，覆盖全即可） */
export function escapeIcsText(s: string): string {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * 'YYYY-MM-DD HH:mm'（或 'YYYY-MM-DDTHH:mm' / 带秒）→ 'YYYYMMDDTHHMMSS'（浮动本地时间）。
 * 解析不了返回 null（调用方跳过该条 —— 导出一个非法 VEVENT 会污染整个日历文件）。
 * 兼容 iOS JS 引擎：空格分隔先归一为 'T'（与 weeklyReview.inWindow 同款处理）。
 */
export function toIcsLocalStamp(dateStr: string | undefined): string | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(dateStr).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  // 月/日/时/分合法性挡一道（13 月、25 点这类脏数据直接跳过，别导出去）
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +(s || 0) > 59) return null;
  return `${y}${mo}${d}T${h}${mi}${s || '00'}`;
}

export interface IcsEventItem {
  title?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  notes?: string;
}

export interface IcsTodoItem {
  title?: string;
  dueDate?: string;
  status?: string;
}

export interface BuildIcsInput {
  events?: IcsEventItem[];
  todos?: IcsTodoItem[];
  /** 生成时刻（测试注入用）；缺省 new Date() */
  now?: Date;
}

/**
 * 构造 .ics 文本。日程缺 startTime / 待办缺 dueDate 的条目**跳过**（宁少一条不错一条）；
 * events/todos 全空时也返回合法的空日历（调用方可据此提示「无可导出内容」）。
 * VTODO 的 DUE 用 dueDate 的 23:59（用户记的是「这天前要做」，不是某个精确分钟）。
 */
export function buildIcs(input: BuildIcsInput): string {
  const now = input.now || new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Morning Brief//Calendar Export//CN',
    'CALSCALE:GREGORIAN',
  ];
  let seq = 0;
  for (const e of input.events || []) {
    const start = toIcsLocalStamp(e && e.startTime);
    const title = (e && e.title || '').trim();
    if (!start || !title) continue;
    const end = toIcsLocalStamp(e && e.endTime);
    seq += 1;
    lines.push(
      'BEGIN:VEVENT',
      `UID:mb-ev-${stamp}-${seq}@morningbrief`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`
    );
    if (end) lines.push(`DTEND:${end}`);
    lines.push(`SUMMARY:${escapeIcsText(title)}`);
    if (e.location && e.location.trim()) lines.push(`LOCATION:${escapeIcsText(e.location.trim())}`);
    if (e.notes && e.notes.trim()) lines.push(`DESCRIPTION:${escapeIcsText(e.notes.trim())}`);
    lines.push('END:VEVENT');
  }
  for (const t of input.todos || []) {
    const dueDate = String((t && t.dueDate) || '').trim();
    const title = (t && t.title || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !title) continue;
    const done = (t && t.status) === 'done';
    seq += 1;
    lines.push(
      'BEGIN:VTODO',
      `UID:mb-todo-${stamp}-${seq}@morningbrief`,
      `DTSTAMP:${stamp}`,
      `DUE:${dueDate.replace(/-/g, '')}T235900`,
      `SUMMARY:${escapeIcsText(title)}`,
      `STATUS:${done ? 'COMPLETED' : 'NEEDS-ACTION'}`,
      'END:VTODO'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
