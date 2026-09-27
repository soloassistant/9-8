/**
 * 语言学习进度（MVP）：本地 storage 持久化，结构向后兼容云同步。
 * - progress: 课程 -> 已掌握词
 * - streak.days: 学习打卡日期（yyyy-mm-dd，保留 180 天）；可为 string（旧）或 StreakDay（新，带 frozen/makeup 标记）
 * - streak.freeze / streak.makeup: 冻结卡与补签记录（L-01 / L-02）
 */
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import { LEARN_LANGS, LearnLangId } from '@/data/learn';

/** 语种 id 类型：对外转发导出，页面可直接从 utils/learn 引用 */
export type { LearnLangId };

const LEARN_STORE_KEY = 'learnStore';
const DAY_LIMIT = 180;

export interface CourseProgress {
  /** 已掌握的词 id */
  learned: string[];
  lastAt?: string;
  completed?: boolean;
}

/** 打卡日：旧数据为 string，新数据为 StreakDay；读取时统一归一化 */
export interface StreakDay {
  /** 'YYYY-MM-DD' */
  date: string;
  /** true = 由冻结卡补入（PRD L-01） */
  frozen?: boolean;
  /** true = 由补签补入（PRD L-02） */
  makeup?: boolean;
}

/** 冻结卡：每连续满 7 天发 1 张，最多持有 2 张 */
export interface StreakFreeze {
  /** 当前持有张数（0~2） */
  cards: number;
  /** 累计已发放张数（用于按连续天数幂等发卡） */
  granted: number;
  /** 已消耗冻结卡覆盖的日期 */
  usedDates: string[];
}

/** 补签：自然月 1 次，自然月 1 号重置（PRD Q6） */
export interface MakeupRecord {
  /** 'YYYY-MM' */
  month: string;
  used: number;
  dates: string[];
}

/** settleStreakOnOpen 的返回，供页面做 toast */
export interface SettleResult {
  /** 本次自动消耗了冻结卡的日期 */
  frozenDates: string[];
  /** 本次发放的冻结卡数 */
  grantedCards: number;
  /** 是否发生状态变化（供 toast） */
  changed: boolean;
}

export interface LearnStore {
  progress: Record<string, CourseProgress>;
  streak: {
    /** 打卡日：string（旧）或 StreakDay（新）混合，向后兼容 */
    days: Array<string | StreakDay>;
    freeze?: StreakFreeze;
    makeup?: MakeupRecord;
  };
  activeLang?: LearnLangId;
  /** 练习统计（语法/听力/口语）：courseId -> 各类最高得分 */
  drill?: Record<string, Record<DrillKind, number>>;
}

/** 练习类型：语法填空 / 听力选义 / 口语跟读 */
export type DrillKind = 'grammar' | 'listening' | 'speaking';

/** 归一化为 'YYYY-MM-DD' */
function toDateStr(d: string | StreakDay): string {
  return typeof d === 'string' ? d : d.date;
}

/** 当前自然月 'YYYY-MM' */
function currentMonth(): string {
  return dayjs().format('YYYY-MM');
}

export function readLearnStore(): LearnStore {
  try {
    const raw = Taro.getStorageSync(LEARN_STORE_KEY);
    if (raw && typeof raw === 'object') {
      const streakRaw = raw.streak && Array.isArray(raw.streak.days) ? raw.streak : { days: [] };
      return {
        progress: raw.progress || {},
        streak: {
          days: streakRaw.days || [],
          freeze:
            streakRaw.freeze && typeof streakRaw.freeze === 'object'
              ? {
                  cards: streakRaw.freeze.cards ?? 0,
                  granted: streakRaw.freeze.granted ?? 0,
                  usedDates: streakRaw.freeze.usedDates ?? []
                }
              : { cards: 0, granted: 0, usedDates: [] },
          makeup:
            streakRaw.makeup && typeof streakRaw.makeup === 'object'
              ? {
                  month: streakRaw.makeup.month ?? '',
                  used: streakRaw.makeup.used ?? 0,
                  dates: streakRaw.makeup.dates ?? []
                }
              : { month: '', used: 0, dates: [] }
        },
        activeLang: raw.activeLang,
        drill: raw.drill && typeof raw.drill === 'object' ? raw.drill : {}
      };
    }
  } catch (err) {
    console.warn('[learn] read store failed:', err);
  }
  return {
    progress: {},
    streak: { days: [], freeze: { cards: 0, granted: 0, usedDates: [] }, makeup: { month: '', used: 0, dates: [] } },
    drill: {}
  };
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

/** 今日打卡（幂等）：已打过返回 false，新打卡返回 true */
export function checkInToday(): boolean {
  const store = readLearnStore();
  const today = dayjs().format('YYYY-MM-DD');
  const hit = store.streak.days.some((d) => toDateStr(d) === today);
  if (hit) return false;
  store.streak.days = [...store.streak.days, today].slice(-DAY_LIMIT);
  writeLearnStore(store);
  return true;
}

/** 掌握/取消掌握单词；全课掌握时标记 completed 并自动打卡 */
export function markWords(courseId: string, wordIds: string[], learned: boolean) {
  const store = readLearnStore();
  const cur = store.progress[courseId] || { learned: [] };
  const set = new Set(cur.learned);
  wordIds.forEach((id) => (learned ? set.add(id) : set.delete(id)));
  const next: CourseProgress = { learned: Array.from(set), lastAt: new Date().toISOString() };
  store.progress[courseId] = next;
  // 顺序不可调换：writeLearnStore 是整体覆盖而非 merge，checkInToday() 内部会 read 一份新 store
  // 再写盘。若先 checkInToday() 再 writeLearnStore(store)，本次写盘会用上面的旧 store 整体覆盖，
  // 把刚打上的卡抹掉（与 addDrillResult() 保持一致的「先写盘、后打卡」顺序）。
  writeLearnStore(store);
  if (learned) checkInToday();
  return next;
}

/** 课程完成判定（由调用方在掌握全部词后写入） */
export function setCourseCompleted(courseId: string, completed: boolean, totalWords: number) {
  const store = readLearnStore();
  const cur = store.progress[courseId] || { learned: [] };
  store.progress[courseId] = { ...cur, completed: completed && cur.learned.length >= totalWords };
  writeLearnStore(store);
}

/**
 * 连续打卡天数：以今天（未学则从昨天）为锚点向前连续计数。
 * 冻结日（frozen）/ 补签日（makeup）也计入连续（L-03 统一口径）。
 */
export function getStreak(): number {
  const days = new Set(readLearnStore().streak.days.map(toDateStr));
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
  const today = dayjs().format('YYYY-MM-DD');
  return readLearnStore().streak.days.some((d) => toDateStr(d) === today);
}

/** 当前持有冻结卡张数 */
export function getFreezeCards(): number {
  return readLearnStore().streak.freeze?.cards ?? 0;
}

/**
 * 补签可行性：最近 2 天内（不含今天）的漏打卡日 + 当月额度。
 * - ok=true：date 为可补签的最近漏打卡日（优先昨天，其次前天）
 * - reason='exhausted'：本月额度已用尽
 * - reason='no-miss'：近 2 天无漏打卡日
 */
export function canMakeup(): { ok: boolean; date: string | null; reason: 'none' | 'exhausted' | 'no-miss' } {
  const store = readLearnStore();
  const mk = store.streak.makeup ?? { month: '', used: 0, dates: [] };
  if (mk.month === currentMonth() && mk.used >= 1) {
    return { ok: false, date: null, reason: 'exhausted' };
  }
  const days = new Set(store.streak.days.map(toDateStr));
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const twoDaysAgo = dayjs().subtract(2, 'day').format('YYYY-MM-DD');
  let candidate: string | null = null;
  if (!days.has(yesterday)) candidate = yesterday;
  else if (!days.has(twoDaysAgo)) candidate = twoDaysAgo;
  if (!candidate) return { ok: false, date: null, reason: 'no-miss' };
  return { ok: true, date: candidate, reason: 'none' };
}

/** 补签最近漏打卡日；成功返回 ok + 补签后连续天数 */
export function makeupMissed(): { ok: boolean; streak: number } {
  const can = canMakeup();
  if (!can.ok || !can.date) return { ok: false, streak: getStreak() };
  const store = readLearnStore();
  store.streak.days = [...store.streak.days, { date: can.date, makeup: true }].slice(-DAY_LIMIT);
  const mk = store.streak.makeup ?? { month: '', used: 0, dates: [] };
  if (mk.month !== currentMonth()) {
    mk.month = currentMonth();
    mk.used = 0;
    mk.dates = [];
  }
  mk.used += 1;
  mk.dates = [...mk.dates, can.date];
  store.streak.makeup = mk;
  writeLearnStore(store);
  return { ok: true, streak: getStreak() };
}

/**
 * 惰性结算（PRD Q5）：学习页 useDidShow 时调用。
 * ① 补算漏打卡日：有连续记录且昨日未打卡 + 有冻结卡 → 消耗 1 张并标记 frozen，保住连续记录
 * ② 连续天数每满 7 天发 1 张（上限 2）
 * 幂等：同一天多次调用不重复发卡/消耗（granted / usedDates 去重）。
 */
export function settleStreakOnOpen(): SettleResult {
  const store = readLearnStore();
  const freeze = store.streak.freeze ?? { cards: 0, granted: 0, usedDates: [] };
  const result: SettleResult = { frozenDates: [], grantedCards: 0, changed: false };

  // ① 漏打卡日：昨日未打卡且有冻结卡 → 消耗 1 张保住连续记录
  const days = new Set(store.streak.days.map(toDateStr));
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
  const hasAnyStreak = store.streak.days.length > 0;
  if (hasAnyStreak && !days.has(yesterday) && freeze.cards > 0) {
    store.streak.days = [...store.streak.days, { date: yesterday, frozen: true }].slice(-DAY_LIMIT);
    freeze.cards -= 1;
    freeze.usedDates = [...freeze.usedDates, yesterday];
    result.frozenDates.push(yesterday);
    result.changed = true;
  }

  // ② 每连续满 7 天发 1 张（上限 2）
  const streak = getStreak();
  const entitled = Math.min(2, Math.floor(streak / 7));
  while (freeze.granted < entitled && freeze.cards < 2) {
    freeze.granted += 1;
    freeze.cards += 1;
    result.grantedCards += 1;
    result.changed = true;
  }

  store.streak.freeze = freeze;
  if (result.changed) writeLearnStore(store);
  return result;
}

/** 单语种学习统计：已掌握/总词数 */
export function getLangStats(langId: LearnLangId): {
  learned: number;
  total: number;
  percent: number;
  coursesDone: number;
  coursesTotal: number;
} {
  const lang = LEARN_LANGS.find((l) => l.id === langId);
  const store = readLearnStore();
  let learned = 0;
  let total = 0;
  let coursesDone = 0;
  let coursesTotal = 0;
  if (lang) {
    lang.levels.forEach((level) =>
      level.courses.forEach((course) => {
        const mastered = store.progress[course.id]?.learned.length || 0;
        learned += mastered;
        total += course.words.length;
        coursesTotal += 1;
        if (course.words.length > 0 && mastered >= course.words.length) coursesDone += 1;
      })
    );
  }
  return {
    learned,
    total,
    percent: total ? Math.round((learned / total) * 100) : 0,
    coursesDone,
    coursesTotal
  };
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
      reason:
        store.progress && flat.some((c) => (store.progress[c.id]?.learned.length || 0) > 0)
          ? '当前级别推进下一课，循序渐进'
          : '零基础从这里开口，先迈出第一步'
    });
  }

  return steps.slice(0, 3);
}

/** 记录一次练习成绩（取该课该类型历史最高分）；完成练习即自动打卡 */
export function addDrillResult(courseId: string, kind: DrillKind, scorePct: number) {
  const store = readLearnStore();
  const cur = store.drill?.[courseId] || { grammar: 0, listening: 0, speaking: 0 };
  store.drill = {
    ...(store.drill || {}),
    [courseId]: { ...cur, [kind]: Math.max(cur[kind] || 0, Math.round(scorePct)) }
  };
  writeLearnStore(store);
  checkInToday();
}

/** 读取某课练习最高分（无记录返回 0） */
export function getDrillScore(courseId: string, kind: DrillKind): number {
  return readLearnStore().drill?.[courseId]?.[kind] || 0;
}
