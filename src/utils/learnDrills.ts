/**
 * 学习练习题生成器：从课程词库（data/learn.ts）自动派生三类练习，零额外数据成本。
 * - 语法：例句关键词填空（选词补全）
 * - 听力：听词选义（TTS 播报 + 四选一）
 * - 口语：跟读句清单
 * 纯函数、可缓存于 useMemo；每轮随机洗牌。
 */
import { LearnCourse, LearnLangId, LearnWord } from '@/data/learn';
import { TtsLang } from '@/utils/tts';

/* ---------------- 语种映射 ---------------- */

/** 课程语种 → TTS 播报语种 */
export function langToTts(langId: LearnLangId): TtsLang {
  switch (langId) {
    case 'ja':
      return 'ja-JP';
    case 'ko':
      return 'ko-KR';
    default:
      return 'en-US';
  }
}

/** 课程语种 → 微信同声传译识别语种（插件仅支持中英） */
export function langToAsr(langId: LearnLangId): 'zh_CN' | 'en_US' {
  return langId === 'en' ? 'en_US' : 'zh_CN';
}

/* ---------------- 洗牌工具 ---------------- */

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------- 语法：例句填空 ---------------- */

export interface GrammarQuestion {
  /** 来源词 id */
  wordId: string;
  /** 填空句干（含 ____ 占位） */
  stem: string;
  /** 正确答案 */
  answer: string;
  /** 四选项（已洗牌，含正确项） */
  options: string[];
  /** 正确词中文释义（答后展示） */
  meaningCn: string;
  /** 完整例句中文（答后展示） */
  exampleCn: string;
}

/** 在例句中定位目标词（英文忽略大小写，日韩精确匹配）；未命中返回 null */
function locateTerm(example: string, term: string): { start: number; end: number } | null {
  const lower = example.toLowerCase();
  const needle = term.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return null;
  return { start: idx, end: idx + term.length };
}

function pickDistractors(pool: string[], answer: string, count: number): string[] {
  const seen = new Set([answer.toLowerCase()]);
  const picked: string[] = [];
  for (const item of shuffle(pool)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
    if (picked.length >= count) break;
  }
  return picked;
}

/** 生成一课的语法填空题（每词一题；目标词在例句中找不到时跳过该词） */
export function buildGrammarQuestions(course: LearnCourse): GrammarQuestion[] {
  const terms = course.words.map((wd) => wd.term);
  const questions: GrammarQuestion[] = [];
  for (const word of course.words) {
    const pos = locateTerm(word.example, word.term);
    // 目标词太短（如 ko「길」）误伤率低，不额外限制；找不到命中则跳过
    if (!pos) continue;
    const distractors = pickDistractors(terms, word.term, 3);
    if (distractors.length < 3) continue;
    questions.push({
      wordId: word.id,
      stem: `${word.example.slice(0, pos.start)}____${word.example.slice(pos.end)}`,
      answer: word.example.slice(pos.start, pos.end),
      options: shuffle([word.example.slice(pos.start, pos.end), ...distractors]),
      meaningCn: word.meaning,
      exampleCn: word.exampleCn
    });
  }
  return shuffle(questions);
}

/* ---------------- 听力：听音选义 ---------------- */

export interface ListeningQuestion {
  wordId: string;
  /** 播报内容（目标语单词，不展示文字） */
  speakText: string;
  /** 四个中文释义选项（已洗牌） */
  options: string[];
  /** 正确释义 */
  answer: string;
  /** 答后展示：例句与中文 */
  example: string;
  exampleCn: string;
}

/** 生成一课的听力题（每词一题，选项取同课释义） */
export function buildListeningQuestions(course: LearnCourse): ListeningQuestion[] {
  const meanings = course.words.map((wd) => wd.meaning);
  return shuffle(course.words).map((word) => {
    const distractors = pickDistractors(meanings, word.meaning, 3);
    // 课程固定 6 词，干扰项必然充足；不足时兜底重复补位（理论不可达）
    while (distractors.length < 3) distractors.push(word.meaning + ' ');
    return {
      wordId: word.id,
      speakText: word.term,
      options: shuffle([word.meaning, ...distractors]),
      answer: word.meaning,
      example: word.example,
      exampleCn: word.exampleCn
    };
  });
}

/* ---------------- 口语：跟读句清单 ---------------- */

export interface SpeakingLine {
  wordId: string;
  term: string;
  reading?: string;
  meaningCn: string;
  /** 跟读目标句（目标语） */
  example: string;
  exampleCn: string;
}

export function buildSpeakingLines(course: LearnCourse): SpeakingLine[] {
  return course.words.map((wd: LearnWord) => ({
    wordId: wd.id,
    term: wd.term,
    reading: wd.reading,
    meaningCn: wd.meaning,
    example: wd.example,
    exampleCn: wd.exampleCn
  }));
}

/* ---------------- 口语评分：转写相似度 ---------------- */

/** 归一化：小写 + 去标点/空白，仅保留字母数字与 CJK/谚文/假名 */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g, '');
}

function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/**
 * Dice 系数比较目标句与 ASR 转写相似度（0~1）。
 * 短句（归一化后 <2 字符）退化为等值比较。
 */
export function speechSimilarity(expected: string, actual: string): number {
  const a = normalizeForCompare(expected);
  const b = normalizeForCompare(actual);
  if (!a || !b) return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  const map = new Map<string, number>();
  ga.forEach((g) => map.set(g, (map.get(g) || 0) + 1));
  let hit = 0;
  gb.forEach((g) => {
    const n = map.get(g) || 0;
    if (n > 0) {
      map.set(g, n - 1);
      hit += 1;
    }
  });
  return (2 * hit) / (ga.length + gb.length);
}
