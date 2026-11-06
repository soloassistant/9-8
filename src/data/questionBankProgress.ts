/**
 * 题库答题记录 / 错题本仓储（接入批次 5/6）。
 *
 * 只落本机 storage：`questionBankProgress` 已按设备级豁免登记在 verify-h5-coverage，
 * 到期条件是「进度接入 cloudSync」的那一笔必须删除豁免并挪进 CROSS_DEVICE_KEYS。
 *
 * 语义：
 *   · attempts / correctCount / wrongCount 是累计计数，答对不会把「曾经答错」抹掉；
 *   · mistakes() 只列 wrongCount > 0 的题（错题本是复习清单，不是「最近一次答错」）；
 *   · 读不懂的版本/损坏数据一律抛错，页面渲染失败态 —— 绝不静默当「没有错题」。
 */
export const QUESTION_BANK_PROGRESS_KEY = 'questionBankProgress';
export const QUESTION_BANK_PROGRESS_VERSION = 1;

export interface ProgressStorage {
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
}

export class QuestionBankProgressError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuestionBankProgressError';
    this.code = code;
  }
}

export interface ProgressEntry {
  questionId: string;
  attempts: number;
  correctCount: number;
  wrongCount: number;
  lastCorrect: boolean;
  lastAnsweredAt: string;
}

export interface ProgressStats {
  answeredQuestions: number;
  attempts: number;
  correctRate: number;
  wrongQuestions: number;
}

interface ProgressDoc { version: number; entries: ProgressEntry[] }

function readDoc(storage: ProgressStorage): ProgressDoc {
  const raw = storage.getStorageSync(QUESTION_BANK_PROGRESS_KEY);
  if (raw === '' || raw === undefined || raw === null) return { version: QUESTION_BANK_PROGRESS_VERSION, entries: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new QuestionBankProgressError('questionBankProgress.corrupt', '答题记录不是对象，拒绝读取');
  const doc = raw as ProgressDoc;
  if (doc.version !== QUESTION_BANK_PROGRESS_VERSION) {
    throw new QuestionBankProgressError('questionBankProgress.versionUnsupported', `不支持的回答记录版本 ${doc.version}（当前 ${QUESTION_BANK_PROGRESS_VERSION}）`);
  }
  if (!Array.isArray(doc.entries)) throw new QuestionBankProgressError('questionBankProgress.corrupt', '答题记录的 entries 不是数组');
  return { version: QUESTION_BANK_PROGRESS_VERSION, entries: doc.entries.slice() };
}

function writeDoc(storage: ProgressStorage, entries: ProgressEntry[]): void {
  storage.setStorageSync(QUESTION_BANK_PROGRESS_KEY, { version: QUESTION_BANK_PROGRESS_VERSION, entries });
}

export interface QuestionBankProgress {
  record(questionId: string, correct: boolean): ProgressEntry;
  get(questionId: string): ProgressEntry | null;
  list(): ProgressEntry[];
  /** 错题本：曾经答错过的题，按最近作答时间倒序。 */
  mistakes(): ProgressEntry[];
  stats(): ProgressStats;
}

export function createQuestionBankProgress(storage: ProgressStorage, options: { now?: () => string } = {}): QuestionBankProgress {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    record(questionId, correct) {
      if (typeof questionId !== 'string' || !questionId.trim()) throw new QuestionBankProgressError('questionBankProgress.invalidId', 'questionId 不能为空');
      const doc = readDoc(storage);
      const idx = doc.entries.findIndex((e) => e.questionId === questionId);
      const prev = idx >= 0 ? doc.entries[idx] : null;
      const entry: ProgressEntry = {
        questionId,
        attempts: (prev?.attempts ?? 0) + 1,
        correctCount: (prev?.correctCount ?? 0) + (correct ? 1 : 0),
        wrongCount: (prev?.wrongCount ?? 0) + (correct ? 0 : 1),
        lastCorrect: correct,
        lastAnsweredAt: now()
      };
      const entries = doc.entries.slice();
      if (idx >= 0) entries[idx] = entry; else entries.push(entry);
      writeDoc(storage, entries);
      return entry;
    },
    get(questionId) {
      return readDoc(storage).entries.find((e) => e.questionId === questionId) ?? null;
    },
    list() {
      return readDoc(storage).entries;
    },
    mistakes() {
      return readDoc(storage).entries
        .filter((e) => e.wrongCount > 0)
        .sort((a, b) => (a.lastAnsweredAt < b.lastAnsweredAt ? 1 : -1));
    },
    stats() {
      const entries = readDoc(storage).entries;
      const attempts = entries.reduce((n, e) => n + e.attempts, 0);
      const correct = entries.reduce((n, e) => n + e.correctCount, 0);
      return {
        answeredQuestions: entries.length,
        attempts,
        correctRate: attempts === 0 ? 0 : correct / attempts,
        wrongQuestions: entries.filter((e) => e.wrongCount > 0).length
      };
    }
  };
}
