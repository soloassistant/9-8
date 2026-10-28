/**
 * 站内通知日志（设计稿 p17）。
 *
 * ★ 这个模块只做一件事：把**应用里真实发生过的事件**按时间记下来，供「通知」页展示。
 *   绝不允许在某处"造"一条通知来把页面填满 —— 用户看到"提取完成，AI 整理出 2 项"
 *   就会去收件箱找那 2 项，找不到就是骗人。
 *
 * 存储：`notify-log`（数组，最多 60 条；页面只展示近 30 天）。
 * 为什么不进 cloudSync：通知是"这台设备上发生过什么"的记录，跨设备合并会出现
 * 同一件事两遍；晨报/提取这些事件本身在别的设备上也会重新产生。
 */
import Taro from '@tarojs/taro';

export const NOTIFY_KEY = 'notify-log';
/** 页面右上角那句「仅保留最近 30 天」必须与这里的过滤一致，否则就是空承诺 */
export const KEEP_DAYS = 30;
const MAX_ENTRIES = 60;

export type NotifyKind = 'briefing' | 'extract' | 'reminder' | 'system';

export interface NotifyEntry {
  id: string;
  kind: NotifyKind;
  /** 已经渲染好的文案（不是 key）：通知是历史快照，切语言后不该整批改写 */
  title: string;
  desc: string;
  at: number;
}

function readRaw(): NotifyEntry[] {
  try {
    const v = Taro.getStorageSync(NOTIFY_KEY);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is NotifyEntry =>
        !!e && typeof e.id === 'string' && typeof e.title === 'string' && Number.isFinite(e.at)
    );
  } catch (err) {
    console.warn('[notify] read failed:', err);
    return [];
  }
}

function writeRaw(list: NotifyEntry[]): void {
  try {
    Taro.setStorageSync(NOTIFY_KEY, list.slice(0, MAX_ENTRIES));
  } catch (err) {
    console.warn('[notify] write failed:', err);
  }
}

/**
 * 记一条通知。
 * `dedupeKey` 用于「同一天同一件事只记一次」——晨报页每次 onShow 都会重新加载，
 * 不去重就会一天刷出十几条「晨报已生成」。
 */
export function pushNotify(
  entry: Omit<NotifyEntry, 'id' | 'at'> & { at?: number; dedupeKey?: string }
): void {
  const at = entry.at || Date.now();
  const list = readRaw();
  if (entry.dedupeKey) {
    const hit = list.find((e) => e.id.startsWith(`${entry.dedupeKey}:`));
    if (hit) return;
  }
  const id = `${entry.dedupeKey || entry.kind}:${at}:${Math.random().toString(36).slice(2, 6)}`;
  const next: NotifyEntry = { id, kind: entry.kind, title: entry.title, desc: entry.desc, at };
  writeRaw([next, ...list]);
}

/** 近 30 天，新 → 旧 */
export function listNotify(now = Date.now()): NotifyEntry[] {
  const floor = now - KEEP_DAYS * 24 * 3600 * 1000;
  return readRaw()
    .filter((e) => e.at >= floor)
    .sort((a, b) => b.at - a.at);
}

export function clearNotify(): void {
  writeRaw([]);
}

export interface NotifyGroup {
  key: 'today' | 'yesterday' | 'earlier';
  at: number;
  items: NotifyEntry[];
}

/** 按「今天 / 昨天 / 更早」分组。用本地日界切，不用 24 小时差 —— 凌晨看昨天的通知
 *  不该被算进"今天"（用户对"今天"的理解是日历日，不是滚动 24 小时）。 */
export function groupNotify(entries: NotifyEntry[], now = Date.now()): NotifyGroup[] {
  const startOfDay = (ts: number) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(now);
  const yesterday = today - 24 * 3600 * 1000;
  const groups: NotifyGroup[] = [
    { key: 'today', at: today, items: [] },
    { key: 'yesterday', at: yesterday, items: [] },
    { key: 'earlier', at: 0, items: [] }
  ];
  for (const e of entries) {
    if (e.at >= today) groups[0].items.push(e);
    else if (e.at >= yesterday) groups[1].items.push(e);
    else groups[2].items.push(e);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** 时间戳 → 今天显示 HH:mm，更早显示 M/D */
export function formatNotifyTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
