// 晨报存档（2026-10-31）：每天一份「定版」，近 7 天可回看（产品评估 §7.2 B）。
// 免费版承诺就是 7 天 —— 上限写死在这里；将来做 PRO「无限回看」只动 ARCHIVE_MAX 的档位逻辑。
// 存储薄壳：Briefing 整包存（几 KB/天 × 7 可接受）；写失败只告警不连累晨报主流程。
import Taro from '@tarojs/taro';
import type { Briefing } from '../types';

const ARCHIVE_KEY = 'briefing-archive';
export const ARCHIVE_MAX = 7;

export interface BriefingArchiveEntry {
  /** 'YYYY-MM-DD'，与 Briefing.date 一致（同一天重复打开只保留最新一份） */
  date: string;
  savedAt: string;
  payload: Briefing;
}

export function listBriefingArchive(): BriefingArchiveEntry[] {
  try {
    const raw = Taro.getStorageSync(ARCHIVE_KEY);
    const list = Array.isArray(raw) ? raw : [];
    return list.filter((e) => e && typeof e.date === 'string' && e.payload);
  } catch (err) {
    console.warn('[briefingArchive] read failed:', err);
    return [];
  }
}

/** 记录/刷新当天存档：同日覆盖（当天早些时候的旧版被最新版替代），按 date 倒序，截断到 ARCHIVE_MAX */
export function recordBriefingArchive(b: Briefing | null | undefined): void {
  if (!b || !b.date) return;
  try {
    const entry: BriefingArchiveEntry = { date: b.date, savedAt: new Date().toISOString(), payload: b };
    const rest = listBriefingArchive().filter((e) => e.date !== b.date);
    const next = [entry, ...rest].slice(0, ARCHIVE_MAX);
    Taro.setStorageSync(ARCHIVE_KEY, next);
  } catch (err) {
    console.warn('[briefingArchive] write failed:', err);
  }
}

/** 近 7 天（含今天）打开过晨报的天数 —— 价值周报的 briefingOpenDays 数据源 */
export function countBriefingOpenDays(now: Date = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  return listBriefingArchive().filter((e) => {
    const d = new Date(String(e.date).replace(' ', 'T'));
    return !Number.isNaN(d.getTime()) && d.getTime() >= start;
  }).length;
}
