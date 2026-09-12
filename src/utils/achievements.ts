/**
 * 学习成就激励（MVP）：徽章由真实学习数据驱动解锁，本地 storage 持久化解锁时间。
 * 结构向后兼容云同步（后续接社区云库时可直接上云）。
 */
import Taro from '@tarojs/taro';
import { LEARN_LANGS } from '@/data/learn';
import { readLearnStore, getStreak } from './learn';

const ACHIEVE_STORE_KEY = 'learnAchievements';

export interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  unlockedAt: string | null;
  /** 0-100 解锁进度（未解锁时展示） */
  progress: number;
}

/** 全语种聚合统计 */
function totalStats() {
  const store = readLearnStore();
  let learned = 0;
  let coursesDone = 0;
  const langsTouched = new Set<string>();
  let coursesTotal = 0;
  LEARN_LANGS.forEach((lang) =>
    lang.levels.forEach((lv) =>
      lv.courses.forEach((c) => {
        coursesTotal += 1;
        const mastered = store.progress[c.id]?.learned.length || 0;
        if (mastered > 0) langsTouched.add(lang.id);
        learned += mastered;
        if (c.words.length > 0 && mastered >= c.words.length) coursesDone += 1;
      })
    )
  );
  return { learned, coursesDone, langsTouched: langsTouched.size, coursesTotal };
}

/** 评估中间态：带命中标记 */
type EvaluatedAchievement = Achievement & { hit: boolean };

/** 成就定义与判定（streak/词数/课数/语种广度） */
function evaluate(): EvaluatedAchievement[] {
  const total = totalStats();
  const streak = getStreak();
  const defs: Array<Omit<Achievement, 'unlockedAt'> & { hit: boolean }> = [
    {
      id: 'first-word',
      icon: '🌱',
      name: '开口第一词',
      desc: '掌握第一个单词',
      hit: total.learned >= 1,
      progress: Math.min(100, total.learned * 100)
    },
    {
      id: 'words-20',
      icon: '📚',
      name: '词汇新手',
      desc: '累计掌握 20 个单词',
      hit: total.learned >= 20,
      progress: Math.min(100, Math.round((total.learned / 20) * 100))
    },
    {
      id: 'words-60',
      icon: '🎓',
      name: '词汇达人',
      desc: '累计掌握 60 个单词',
      hit: total.learned >= 60,
      progress: Math.min(100, Math.round((total.learned / 60) * 100))
    },
    {
      id: 'streak-3',
      icon: '🔥',
      name: '三日之约',
      desc: '连续打卡 3 天',
      hit: streak >= 3,
      progress: Math.min(100, Math.round((streak / 3) * 100))
    },
    {
      id: 'streak-7',
      icon: '⚡',
      name: '一周不断',
      desc: '连续打卡 7 天',
      hit: streak >= 7,
      progress: Math.min(100, Math.round((streak / 7) * 100))
    },
    {
      id: 'first-course',
      icon: '🏁',
      name: '首课通关',
      desc: '完成第一门课程',
      hit: total.coursesDone >= 1,
      progress: Math.min(100, Math.round((total.coursesDone / 1) * 100))
    },
    {
      id: 'courses-3',
      icon: '🏆',
      name: '课程三连',
      desc: '完成 3 门课程',
      hit: total.coursesDone >= 3,
      progress: Math.min(100, Math.round((total.coursesDone / 3) * 100))
    },
    {
      id: 'polyglot',
      icon: '🌍',
      name: '多语之星',
      desc: '在 2 个语种都有学习记录',
      hit: total.langsTouched >= 2,
      progress: Math.min(100, Math.round((total.langsTouched / 2) * 100))
    }
  ];
  return defs.map(({ hit, ...d }) => ({ ...d, hit, unlockedAt: null as string | null }));
}

/** 读取成就列表：解锁状态即时计算，解锁时间落库固化 */
export function getAchievements(): Achievement[] {
  let saved: Record<string, string> = {};
  try {
    const raw = Taro.getStorageSync(ACHIEVE_STORE_KEY);
    if (raw && typeof raw === 'object') saved = raw;
  } catch (err) {
    console.warn('[achievements] read failed:', err);
  }
  const evaluated = evaluate();
  const result: Achievement[] = [];
  let changed = false;
  evaluated.forEach((a) => {
    if (a.hit) {
      const at = saved[a.id] || new Date().toISOString();
      if (!saved[a.id]) {
        saved[a.id] = at;
        changed = true;
      }
      result.push({ ...a, unlockedAt: at, progress: 100 });
    } else {
      result.push({ ...a, unlockedAt: null });
    }
  });
  if (changed) {
    try {
      Taro.setStorageSync(ACHIEVE_STORE_KEY, saved);
    } catch (err) {
      console.warn('[achievements] write failed:', err);
    }
  }
  return result;
}

/** 已解锁数量（learn 页头部摘要用） */
export function getUnlockedCount(): number {
  return getAchievements().filter((a) => a.unlockedAt).length;
}

/** 供社区动态展示的当前昵称（可后续接登录体系） */
export function getLearnerName(): string {
  try {
    const raw = Taro.getStorageSync('learnNickname');
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  } catch (err) {
    console.warn('[achievements] nickname read failed:', err);
  }
  return '我';
}

export function setLearnerName(name: string) {
  try {
    Taro.setStorageSync('learnNickname', name.trim().slice(0, 12));
  } catch (err) {
    console.warn('[achievements] nickname write failed:', err);
  }
}
