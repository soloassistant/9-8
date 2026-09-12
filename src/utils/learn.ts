/**
 * 语言学习进度（MVP）：本地 storage 持久化，结构向后兼容云同步。
 * - progress: 课程 -> 已掌握词
 * - streak.days: 学习打卡日期（yyyy-mm-dd，保留 180 天）
 */
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import { LEARN_LANGS, LearnLangId } from '@/data/learn';

const LEARN_STORE_KEY = 'learnStore';
const DAY_LIMIT = 180;

export interface CourseProgress {
  /** 已掌握的词 id */
  learned: string[];
  lastAt?: string;
  completed?: boolean;
}

export interface LearnStore {
  progress: Record<string, CourseProgress>;
  streak: { days: string[] };
  activeLang?: LearnLangId;
}

export function readLearnStore(): LearnStore {
  try {
    const raw = Taro.getStorageSync(LEARN_STORE_KEY);
    if (raw && typeof raw === 'object') {
      return {
        progress: raw.progress || {},
        streak: raw.streak && Array.isArray(raw.streak.days) ? raw.streak : { days: [] },
        activeLang: raw.activeLang
      };
    }
  } catch (err) {
    console.warn('[learn] read store failed:', err);
  }
  return { progress: {}, streak: { days: [] } };
}

function writeLearnStore(store: LearnStore) {
  try {
    Taro.setStorageSync(LEARN_STORE_KEY, store);
  } catch (err) {
    console.warn('[learn] write store failed:', err);
  }
}

export function setActiveLang(langId: LearnLangId) {
  const store = readLearnStore();
  store.activeLang = langId;
  writeLearnStore(store);
}

export function getCourseProgress(courseId: string): CourseProgress {
  return readLearnStore().progress[courseId] || { learned: [] };
}

/** 掌握/取消掌握单词；全课掌握时标记 completed 并自动打卡 */
export function markWords(courseId: string, wordIds: string[], learned: boolean) {
  const store = readLearnStore();
  const cur = store.progress[courseId] || { learned: [] };
  const set = new Set(cur.learned);
  wordIds.forEach((id) => (learned ? set.add(id) : set.delete(id)));
  const next: CourseProgress = { learned: Array.from(set), lastAt: new Date().toISOString() };
  store.progress[courseId] = next;
  if (learned) {
    const today = dayjs().format('YYYY-MM-DD');
    if (!store.streak.days.includes(today)) {
      store.streak.days = [...store.streak.days, today].slice(-DAY_LIMIT);
    }
  }
  writeLearnStore(store);
  return next;
}

/** 课程完成判定（由调用方在掌握全部词后写入） */
export function setCourseCompleted(courseId: string, completed: boolean, totalWords: number) {
  const store = readLearnStore();
  const cur = store.progress[courseId] || { learned: [] };
  store.progress[courseId] = { ...cur, completed: completed && cur.learned.length >= totalWords };
  writeLearnStore(store);
}

/** 连续打卡天数：以今天（未学则从昨天）为锚点向前连续计数 */
export function getStreak(): number {
  const days = new Set(readLearnStore().streak.days);
  let cursor = dayjs();
  if (!days.has(cursor.format('YYYY-MM-DD'))) cursor = cursor.subtract(1, 'day');
  let streak = 0;
  while (days.has(cursor.format('YYYY-MM-DD'))) {
    streak++;
    cursor = cursor.subtract(1, 'day');
  }
  return streak;
}

/** 今日是否已学（打卡态） */
export function isTodayCheckedIn(): boolean {
  return readLearnStore().streak.days.includes(dayjs().format('YYYY-MM-DD'));
}

/** 单语种学习统计：已掌握/总词数 */
export function getLangStats(langId: LearnLangId): { learned: number; total: number; percent: number; coursesDone: number; coursesTotal: number } {
  const lang = LEARN_LANGS.find((l) => l.id === langId);
  const store = readLearnStore();
  let learned = 0;
  let total = 0;
  let coursesDone = 0;
  let coursesTotal = 0;
  if (lang) {
    lang.levels.forEach((level) =>
      level.courses.forEach((course) => {
        const mastered = (store.progress[course.id]?.learned.length || 0);
        learned += mastered;
        total += course.words.length;
        coursesTotal += 1;
        if (course.words.length > 0 && mastered >= course.words.length) coursesDone += 1;
      })
    );
  }
  return { learned, total, percent: total ? Math.round((learned / total) * 100) : 0, coursesDone, coursesTotal };
}

/** 推荐路径步骤类型：continue=续学未完成课 / next=开启新课 / review=隔天复习 */
export interface PathStep {
  type: 'continue' | 'next' | 'review';
  courseId: string;
  title: string;
  /** 推荐理由 */
  reason: string;
}

/**
 * 个性化学习路径推荐（规则引擎，零成本）：按语种分析进度，
 * 优先级 续学未完成课 > 隔 ≥3 天复习已学课 > 开启下一门新课 > 零基础起步。
 */
export function getRecommendedPath(langId: LearnLangId): PathStep[] {
  const lang = LEARN_LANGS.find((l) => l.id === langId);
  if (!lang) return [];
  const store = readLearnStore();
  const steps: PathStep[] = [];
  const flat = lang.levels.flatMap((lv) => lv.courses);
  const now = Date.now();

  // 1) 续学：进度过半但未完成的课
  const unfinished = flat.filter((c) => {
    const p = store.progress[c.id];
    return p && p.learned.length > 0 && p.learned.length < c.words.length;
  });
  if (unfinished.length > 0) {
    const c = unfinished[0];
    const p = store.progress[c.id];
    steps.push({
      type: 'continue',
      courseId: c.id,
      title: c.title,
      reason: `已掌握 ${p!.learned.length}/${c.words.length} 词，接着学完这课`
    });
  }

  // 2) 复习：已学但超过 3 天没碰的课（间隔复习记忆更牢）
  const stale = flat
    .filter((c) => {
      const p = store.progress[c.id];
      if (!p || p.learned.length === 0) return false;
      if (unfinished.some((u) => u.id === c.id)) return false;
      if (!p.lastAt) return false;
      return now - new Date(p.lastAt).getTime() > 3 * 24 * 3600 * 1000;
    })
    .sort((a, b) => (store.progress[a.id]!.lastAt || '').localeCompare(store.progress[b.id]!.lastAt || ''));
  if (stale.length > 0) {
    const c = stale[0];
    const days = Math.floor((now - new Date(store.progress[c.id]!.lastAt!).getTime()) / (24 * 3600 * 1000));
    steps.push({
      type: 'review',
      courseId: c.id,
      title: c.title,
      reason: `隔了 ${days} 天没复习，巩固 ${store.progress[c.id]!.learned.length} 个词`
    });
  }

  // 3) 新课：第一门未开始的课
  const nextCourse = flat.find((c) => !store.progress[c.id] || store.progress[c.id].learned.length === 0);
  if (nextCourse && steps.length < 3) {
    steps.push({
      type: 'next',
      courseId: nextCourse.id,
      title: nextCourse.title,
      reason: store.progress && flat.some((c) => (store.progress[c.id]?.learned.length || 0) > 0)
        ? '当前级别推进下一课，循序渐进'
        : '零基础从这里开口，先迈出第一步'
    });
  }

  return steps.slice(0, 3);
}

/** 全语种总词库规模 */
export function getTotalWordCount(): number {
  return LEARN_LANGS.reduce(
    (sum, lang) => sum + lang.levels.reduce((s, lv) => s + lv.courses.reduce((ss, c) => ss + c.words.length, 0), 0),
    0
  );
}
