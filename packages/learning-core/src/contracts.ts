import type { LearnCourse, LearnLang, LearnLangId } from './data';

export interface CourseProgress {
  learned: string[];
  lastAt?: string;
  completed?: boolean;
}

export interface LearningStats {
  learned: number;
  total: number;
  percent: number;
  coursesDone: number;
  coursesTotal: number;
}

export interface PathStep {
  type: 'continue' | 'next' | 'review';
  courseId: string;
  title: string;
  reason: string;
}

export interface CommunityPost {
  id: string;
  name: string;
  langName: string;
  text: string;
  at: string;
  likes: number;
  liked: boolean;
  mine: boolean;
  demo?: boolean;
}

export interface LearningSummary {
  activeLanguage: LearnLangId;
  learnedWords: number;
  totalWords: number;
  streak: number;
}

export interface LearningRepository {
  getLanguages(): readonly LearnLang[];
  getActiveLanguage(): LearnLangId;
  setActiveLanguage(langId: LearnLangId): void;
  getCourse(courseId: string): { lang: LearnLang; course: LearnCourse } | null;
  getCourseProgress(courseId: string): CourseProgress;
  markWords(courseId: string, wordIds: string[], learned: boolean): CourseProgress;
  completeCourse(courseId: string, completed: boolean): CourseProgress;
  getLangStats(langId: LearnLangId): LearningStats;
  getStreak(): number;
  isTodayCheckedIn(): boolean;
  getAchievements(): Achievement[];
  getLearnerName(): string;
  setLearnerName(name: string): void;
  getCommunityPosts(): CommunityPost[];
  addPost(payload: { text: string }): CommunityPost;
  toggleLike(postId: string): void;
}

export interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  unlockedAt: string | null;
  progress: number;
}
