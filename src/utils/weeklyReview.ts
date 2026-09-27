// ============================================
// P1-G 本周复盘：过去 7 天（含今天）的确定性统计，纯函数、无副作用、不调 LLM
// 口径必须一致：cloudfunctions/getBriefing/index.js 内联了一份等价实现（云函数无法 import src），
// 两侧算法/停用词表/窗口定义改动时必须同步。
// ============================================
import type { ScheduleEvent, TodoItem } from '../types';

/** 本周复盘统计结果 */
export interface WeeklyReview {
  /** 窗口内 done 状态的待办数（TodoItem.status 完成态为 'done'） */
  todosDone: number;
  /** 窗口内日程数 */
  eventCount: number;
  /** 标题高频关键词 top5：出现 ≥2 次才保留；可为空数组（=前端不渲染关键词行） */
  keywords: string[];
}

/** 中文停用字符：bigram 命中任一即丢弃（功能虚词；不含 会/议/评/审 等实义字） */
const ZH_STOP_CHARS = new Set(
  '的吗呢吧啊呀哦嘛了着过在和与及或也很就都还把被让给从到地对得之其这那有个不用里上中为以但等再又才'
    .split('')
);

/** 英文停用词（小写整词） */
const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'of', 'to', 'a', 'in', 'on', 'at', 'is', 'are', 'be', 'am',
  'with', 'my', 'me', 'it', 'this', 'that', 'by', 'from', 'or', 'as', 'will',
  'can', 'has', 'have', 'had', 'do', 'does', 'not', 'no', 'yes', 'ok', 'pm', 'am'
]);

/**
 * 判断时间点是否落在窗口内：now 当天 00:00 起往前共 7 天（含今天），闭区间。
 * 输入兼容 'YYYY-MM-DD HH:mm'（iOS JS 引擎不认空格分隔，先归一为 'T'）与 ISO 串。
 */
function inWindow(dateStr: string | undefined, now: Date): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(d.getTime())) return false;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  return d.getTime() >= start && d.getTime() <= end;
}

/** 从标题提取计频 token：中文按连续汉字串 2 字滑窗 bigram（滤停用字），英文按小写整词 ≥3 字母（滤停用词） */
function extractTokens(title: string | undefined): string[] {
  if (!title) return [];
  const tokens: string[] = [];
  const zhRuns = title.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zhRuns) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      let stopped = false;
      for (const ch of bigram) {
        if (ZH_STOP_CHARS.has(ch)) {
          stopped = true;
          break;
        }
      }
      if (!stopped) tokens.push(bigram);
    }
  }
  const words = title.toLowerCase().match(/[a-z]{3,}/g) || [];
  for (const w of words) {
    if (!EN_STOPWORDS.has(w)) tokens.push(w);
  }
  return tokens;
}

/**
 * 计算本周复盘。
 * 待办窗口锚点：dueDate 优先，缺失回退 createTime（均缺失则不计入窗口）；
 * 日程窗口锚点：startTime。
 * 关键词：event/todo 标题合并计频，只保留出现 ≥2 次的，按频次降序、同频按首次出现序（Map 插入序 + 稳定排序，确定性），取 top5。
 */
export function computeWeeklyReview(events: ScheduleEvent[], todos: TodoItem[], now = new Date()): WeeklyReview {
  const weekEvents = (events || []).filter((e) => inWindow(e && e.startTime, now));
  const weekTodos = (todos || []).filter((t) => inWindow((t && (t.dueDate || t.createTime)) as string, now));
  const todosDone = weekTodos.filter((t) => t.status === 'done').length;

  const freq = new Map<string, number>();
  const bump = (token: string) => freq.set(token, (freq.get(token) || 0) + 1);
  weekEvents.forEach((e) => extractTokens(e.title).forEach(bump));
  weekTodos.forEach((t) => extractTokens(t.title).forEach(bump));

  const keywords = [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]) // 稳定排序：同频保持首次出现序
    .slice(0, 5)
    .map(([word]) => word);

  return { todosDone, eventCount: weekEvents.length, keywords };
}
