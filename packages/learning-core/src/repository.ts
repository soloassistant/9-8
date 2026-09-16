import { findCourse, LEARN_LANGS, type LearnLangId } from './data';
import type {
  Achievement,
  CommunityPost,
  CourseProgress,
  LearningRepository,
  LearningStats
} from './contracts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) || null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function createBrowserStorage(): StorageLike {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // 浏览器隐私模式或禁用 storage 时回退到内存展示。
  }
  return new MemoryStorage();
}

/** 存储 key 集合：展示版与 Taro 过渡入口各自使用独立命名空间，互不污染。 */
export interface StorageKeys {
  store: string;
  achievements: string;
  nickname: string;
  community: string;
}

const WEB_STORAGE_KEYS: StorageKeys = {
  store: 'learning-web:v1:store',
  achievements: 'learning-web:v1:achievements',
  nickname: 'learning-web:v1:nickname',
  community: 'learning-web:v1:community'
};

interface LearnStore {
  progress: Record<string, CourseProgress>;
  streak: { days: string[] };
  activeLang?: LearnLangId;
}

const today = () => new Date().toISOString().slice(0, 10);

function shiftDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function readJson<T>(storage: StorageLike, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage: StorageLike, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 展示版无法写入时仍允许继续浏览课程。
  }
}

function emptyStore(): LearnStore {
  return { progress: {}, streak: { days: [] } };
}

function normalizeStore(value: LearnStore): LearnStore {
  return {
    progress: value && value.progress && typeof value.progress === 'object' ? value.progress : {},
    streak: value && value.streak && Array.isArray(value.streak.days) ? value.streak : { days: [] },
    activeLang: value?.activeLang
  };
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
}

function seedPosts(): CommunityPost[] {
  const now = Date.now();
  return [
    {
      id: 'demo-1',
      name: '柚子同学',
      langName: '日语',
      text: 'N5 寒暄课打卡 ✅ こんにちは已经在便利店用上了，店员真的会回你！',
      at: new Date(now - 3 * 3600 * 1000).toISOString(),
      likes: 12,
      liked: false,
      mine: false,
      demo: true
    },
    {
      id: 'demo-2',
      name: 'Kevin',
      langName: '英语',
      text: 'A2 餐厅点餐课学完，昨天给外国同事推荐了菜单，成就感和实用性双达标 🥳',
      at: new Date(now - 26 * 3600 * 1000).toISOString(),
      likes: 8,
      liked: false,
      mine: false,
      demo: true
    },
    {
      id: 'demo-3',
      name: 'momo',
      langName: '韩语',
      text: '连续打卡 5 天！티켓和환승记住了，下周去首尔地铁实测 🚇',
      at: new Date(now - 2 * 24 * 3600 * 1000).toISOString(),
      likes: 21,
      liked: false,
      mine: false,
      demo: true
    }
  ];
}

export class LocalLearningRepository implements LearningRepository {
  private readonly storage: StorageLike;
  private readonly keys: StorageKeys;

  constructor(storage: StorageLike = createBrowserStorage(), keys: StorageKeys = WEB_STORAGE_KEYS) {
    this.storage = storage;
    this.keys = keys;
  }

  private readStore(): LearnStore {
    return normalizeStore(readJson(this.storage, this.keys.store, emptyStore()));
  }

  private writeStore(store: LearnStore): void {
    writeJson(this.storage, this.keys.store, store);
  }

  getLanguages() {
    return LEARN_LANGS;
  }

  getActiveLanguage(): LearnLangId {
    const active = this.readStore().activeLang;
    return active && LEARN_LANGS.some((lang) => lang.id === active) ? active : 'en';
  }

  setActiveLanguage(langId: LearnLangId): void {
    const store = this.readStore();
    store.activeLang = langId;
    this.writeStore(store);
  }

  getCourse(courseId: string) {
    const found = findCourse(courseId);
    return found ? { lang: found.lang, course: found.course } : null;
  }

  getCourseProgress(courseId: string): CourseProgress {
    return this.readStore().progress[courseId] || { learned: [] };
  }

  markWords(courseId: string, wordIds: string[], learned: boolean): CourseProgress {
    const store = this.readStore();
    const current = store.progress[courseId] || { learned: [] };
    const learnedWords = new Set(current.learned);
    wordIds.forEach((wordId) => (learned ? learnedWords.add(wordId) : learnedWords.delete(wordId)));
    const next: CourseProgress = {
      learned: Array.from(learnedWords),
      lastAt: new Date().toISOString(),
      completed: current.completed
    };
    store.progress[courseId] = next;
    if (learned && !store.streak.days.includes(today())) {
      store.streak.days = [...store.streak.days, today()].slice(-180);
    }
    this.writeStore(store);
    return next;
  }

  completeCourse(courseId: string, completed: boolean): CourseProgress {
    const store = this.readStore();
    const course = this.getCourse(courseId)?.course;
    const current = store.progress[courseId] || { learned: [] };
    const next = {
      ...current,
      completed: Boolean(completed && course && current.learned.length >= course.words.length)
    };
    store.progress[courseId] = next;
    this.writeStore(store);
    return next;
  }

  getLangStats(langId: LearnLangId): LearningStats {
    const lang = LEARN_LANGS.find((item) => item.id === langId);
    const store = this.readStore();
    let learned = 0;
    let total = 0;
    let coursesDone = 0;
    let coursesTotal = 0;
    lang?.levels.forEach((level) =>
      level.courses.forEach((course) => {
        const mastered = store.progress[course.id]?.learned.length || 0;
        learned += mastered;
        total += course.words.length;
        coursesTotal += 1;
        if (course.words.length > 0 && mastered >= course.words.length) coursesDone += 1;
      })
    );
    return { learned, total, percent: total ? Math.round((learned / total) * 100) : 0, coursesDone, coursesTotal };
  }

  getStreak(): number {
    const days = new Set(this.readStore().streak.days);
    let cursor = days.has(today()) ? today() : shiftDate(-1);
    let streak = 0;
    while (days.has(cursor)) {
      streak += 1;
      const date = new Date(cursor + 'T00:00:00');
      date.setDate(date.getDate() - 1);
      cursor = date.toISOString().slice(0, 10);
    }
    return streak;
  }

  isTodayCheckedIn(): boolean {
    return this.readStore().streak.days.includes(today());
  }

  getAchievements(): Achievement[] {
    const store = this.readStore();
    let learned = 0;
    let coursesDone = 0;
    const languagesTouched = new Set<string>();
    LEARN_LANGS.forEach((lang) =>
      lang.levels.forEach((level) =>
        level.courses.forEach((course) => {
          const mastered = store.progress[course.id]?.learned.length || 0;
          if (mastered > 0) languagesTouched.add(lang.id);
          learned += mastered;
          if (course.words.length > 0 && mastered >= course.words.length) coursesDone += 1;
        })
      )
    );
    const streak = this.getStreak();
    const definitions = [
      ['first-word', '🌱', '开口第一词', '掌握第一个单词', learned >= 1, Math.min(100, learned * 100)],
      ['words-20', '📚', '词汇新手', '累计掌握 20 个单词', learned >= 20, Math.min(100, Math.round((learned / 20) * 100))],
      ['words-60', '🎓', '词汇达人', '累计掌握 60 个单词', learned >= 60, Math.min(100, Math.round((learned / 60) * 100))],
      ['streak-3', '🔥', '三日之约', '连续打卡 3 天', streak >= 3, Math.min(100, Math.round((streak / 3) * 100))],
      ['streak-7', '⚡', '一周不断', '连续打卡 7 天', streak >= 7, Math.min(100, Math.round((streak / 7) * 100))],
      ['first-course', '🏁', '首课通关', '完成第一门课程', coursesDone >= 1, Math.min(100, coursesDone * 100)],
      ['courses-3', '🏆', '课程三连', '完成 3 门课程', coursesDone >= 3, Math.min(100, Math.round((coursesDone / 3) * 100))],
      ['polyglot', '🌍', '多语之星', '在 2 个语种都有学习记录', languagesTouched.size >= 2, Math.min(100, Math.round((languagesTouched.size / 2) * 100))]
    ] as const;
    const saved = readJson<Record<string, string>>(this.storage, this.keys.achievements, {});
    let changed = false;
    const result = definitions.map(([id, icon, name, desc, hit, progress]) => {
      const unlockedAt = hit ? saved[id] || new Date().toISOString() : null;
      if (hit && !saved[id]) {
        saved[id] = unlockedAt as string;
        changed = true;
      }
      return { id, icon, name, desc, unlockedAt, progress: hit ? 100 : progress };
    });
    if (changed) writeJson(this.storage, this.keys.achievements, saved);
    return result;
  }

  getLearnerName(): string {
    return readJson<string>(this.storage, this.keys.nickname, '我').trim() || '我';
  }

  setLearnerName(name: string): void {
    writeJson(this.storage, this.keys.nickname, name.trim().slice(0, 12) || '我');
  }

  getCommunityPosts(): CommunityPost[] {
    const posts = readJson<CommunityPost[] | null>(this.storage, this.keys.community, null);
    if (posts && Array.isArray(posts)) return posts;
    const seeded = seedPosts();
    writeJson(this.storage, this.keys.community, seeded);
    return seeded;
  }

  addPost(payload: { text: string }): CommunityPost {
    const text = payload.text.trim().slice(0, 200);
    const post: CommunityPost = {
      id: 'post-' + Date.now(),
      name: this.getLearnerName(),
      langName: LEARN_LANGS.find((lang) => lang.id === this.getActiveLanguage())?.name || '英语',
      text,
      at: new Date().toISOString(),
      likes: 0,
      liked: false,
      mine: true
    };
    writeJson(this.storage, this.keys.community, [post, ...this.getCommunityPosts()].slice(0, 50));
    return post;
  }

  toggleLike(postId: string): void {
    const next = this.getCommunityPosts().map((post) =>
      post.id === postId
        ? { ...post, liked: !post.liked, likes: post.likes + (post.liked ? -1 : 1) }
        : post
    );
    writeJson(this.storage, this.keys.community, next);
  }
}

export function getRecommendedPath(langId: LearnLangId, repository: LearningRepository) {
  const lang = LEARN_LANGS.find((item) => item.id === langId);
  if (!lang) return [];
  const steps: Array<{ type: 'continue' | 'next' | 'review'; courseId: string; title: string; reason: string }> = [];
  const courses = lang.levels.flatMap((level) => level.courses);
  const unfinished = courses.filter((course) => {
    const progress = repository.getCourseProgress(course.id);
    return progress.learned.length > 0 && progress.learned.length < course.words.length;
  });
  if (unfinished.length) {
    const course = unfinished[0];
    const progress = repository.getCourseProgress(course.id);
    steps.push({
      type: 'continue',
      courseId: course.id,
      title: course.title,
      reason: '已掌握 ' + progress.learned.length + '/' + course.words.length + ' 词，接着学完这课'
    });
  }
  const stale = courses
    .filter((course) => {
      const progress = repository.getCourseProgress(course.id);
      return Boolean(
        progress.learned.length &&
        progress.lastAt &&
        !unfinished.some((item) => item.id === course.id) &&
        daysSince(progress.lastAt) > 3
      );
    })
    .sort((a, b) => {
      const left = repository.getCourseProgress(a.id).lastAt || '';
      const right = repository.getCourseProgress(b.id).lastAt || '';
      return left.localeCompare(right);
    });
  if (stale.length) {
    const course = stale[0];
    const progress = repository.getCourseProgress(course.id);
    steps.push({
      type: 'review',
      courseId: course.id,
      title: course.title,
      reason: '隔了 ' + daysSince(progress.lastAt || new Date().toISOString()) + ' 天没复习，巩固已学词'
    });
  }
  const next = courses.find((course) => repository.getCourseProgress(course.id).learned.length === 0);
  if (next && steps.length < 3) {
    steps.push({
      type: 'next',
      courseId: next.id,
      title: next.title,
      reason: steps.length ? '当前级别推进下一课，循序渐进' : '零基础从这里开口，先迈出第一步'
    });
  }
  return steps.slice(0, 3);
}

export function getLearningSummary(repository: LearningRepository) {
  const languages = repository.getLanguages();
  const stats = languages.reduce(
    (result, lang) => {
      const current = repository.getLangStats(lang.id);
      return { learnedWords: result.learnedWords + current.learned, totalWords: result.totalWords + current.total };
    },
    { learnedWords: 0, totalWords: 0 }
  );
  return {
    activeLanguage: repository.getActiveLanguage(),
    learnedWords: stats.learnedWords,
    totalWords: stats.totalWords,
    streak: repository.getStreak()
  };
}
