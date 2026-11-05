/**
 * 题库本地仓储层（PR-2）。
 *
 * 身份语义（PR-1 定稿，这里是执行点）：
 *   · **id 是身份**：由调用方 `questionId()` 生成，仓储层永不变更 —— `update` 只改内容，
 *     所以老师改错别字不会让学生的作答记录、错题本、练习进度断链。
 *   · **stemHash 是内容指纹**：add / update / 导入时一律按当前 stem 重算。
 *     同一 id 的 stemHash 变了 = 该题被修订，引用该 id 的记录仍然有效。
 *
 * 刻意不 import @tarojs/taro：存储能力由调用方注入（页面层传 Taro 兼容对象），
 * 本层因此是纯逻辑，可用假存储跑断言。不碰 cloudSync / SYNC_KEYS / 任何页面。
 */
import type { LangCode, Question } from '../types/questionBank';
import { findDuplicates, stemHash } from '../utils/questionBank';

export const QUESTION_BANK_STORAGE_KEY = 'questionBank';
/** 当前文档版本。加版本时同步在 MIGRATIONS 里补一条迁移。 */
export const QUESTION_BANK_SCHEMA_VERSION = 1;

/** 最小存储接口：与 Taro.getStorageSync / setStorageSync 同签名，缺失时返回 ''。 */
export interface QuestionBankStorage {
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
}

export class QuestionBankError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuestionBankError';
    this.code = code;
  }
}

/** 文档形状：版本号 + 题目数组。版本号是迁移的唯一依据。 */
interface QuestionBankDoc { version: number; questions: Question[] }

/**
 * 迁移表：key = 旧版本，value = 升到 key+1 的函数。加了新版本却没补迁移时，
 * 读到旧数据走 versionUnsupported 明确报错 —— 绝不把读不懂的版本静默当空库，
 * 那等于把用户的题库清空且不可恢复。
 */
const MIGRATIONS: Record<number, (doc: QuestionBankDoc) => QuestionBankDoc> = {};

/** 可改的内容字段；id / stemHash / createdAt / updatedAt 由仓储层自己维护。 */
export type QuestionPatch = Partial<Omit<Question, 'id' | 'stemHash' | 'createdAt' | 'updatedAt'>>;

export interface DuplicateHit {
  incomingId: string;
  /** 库里保留的那条 id（同批内重复时是先进来的那条） */
  matchedId: string;
  hash: string;
  langCode: LangCode;
  reason: 'stem' | 'id';
}
export interface ImportOutcome { added: Question[]; duplicates: DuplicateHit[] }
export interface QuestionBankRepo {
  list(): Question[];
  getById(id: string): Question | null;
  add(question: Question): Question;
  update(id: string, patch: QuestionPatch): Question;
  remove(id: string): boolean;
  importQuestions(incoming: Question[]): ImportOutcome;
}

function readDoc(storage: QuestionBankStorage): QuestionBankDoc {
  const raw = storage.getStorageSync(QUESTION_BANK_STORAGE_KEY);
  // Taro 缺失时返回 ''；null/undefined 一并当「还没建库」
  if (raw === '' || raw === undefined || raw === null) return { version: QUESTION_BANK_SCHEMA_VERSION, questions: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new QuestionBankError('questionBank.corrupt', '题库存储内容不是对象，拒绝读取');
  let doc = raw as QuestionBankDoc;
  if (!Number.isInteger(doc.version)) throw new QuestionBankError('questionBank.corrupt', '题库存储缺少整数 version 字段');
  let version = doc.version;
  while (version !== QUESTION_BANK_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new QuestionBankError('questionBank.versionUnsupported', `不支持的题库版本 ${version}（当前 ${QUESTION_BANK_SCHEMA_VERSION}）`);
    const next = migrate(doc);
    if (!Number.isInteger(next.version) || next.version <= version) throw new QuestionBankError('questionBank.corrupt', `迁移 ${version} 没有推进版本号`);
    doc = next;
    version = next.version;
  }
  if (!Array.isArray(doc.questions)) throw new QuestionBankError('questionBank.corrupt', '题库存储的 questions 不是数组');
  return { version: QUESTION_BANK_SCHEMA_VERSION, questions: doc.questions.slice() };
}

function writeDoc(storage: QuestionBankStorage, questions: Question[]): void {
  storage.setStorageSync(QUESTION_BANK_STORAGE_KEY, { version: QUESTION_BANK_SCHEMA_VERSION, questions });
}

export function createQuestionBankRepo(
  storage: QuestionBankStorage,
  options: { now?: () => string } = {}
): QuestionBankRepo {
  const now = options.now ?? (() => new Date().toISOString());
  const save = (questions: Question[]) => writeDoc(storage, questions);

  return {
    list(): Question[] {
      return readDoc(storage).questions;
    },
    getById(id: string): Question | null {
      return readDoc(storage).questions.find((q) => q.id === id) ?? null;
    },
    add(question: Question): Question {
      const doc = readDoc(storage);
      if (doc.questions.some((q) => q.id === question.id)) {
        throw new QuestionBankError('questionBank.duplicateId', `id「${question.id}」已存在；改题请用 update`);
      }
      // 指纹始终由当前 stem 重算，不接受调用方传进来的旧值
      const row: Question = { ...question, stemHash: stemHash(question.stem) };
      save([...doc.questions, row]);
      return row;
    },
    update(id: string, patch: QuestionPatch): Question {
      const doc = readDoc(storage);
      const idx = doc.questions.findIndex((q) => q.id === id);
      if (idx < 0) throw new QuestionBankError('questionBank.notFound', `没有 id「${id}」的题目`);
      const prev = doc.questions[idx];
      const next: Question = {
        ...prev,
        ...patch,
        // 身份三件套由仓储层写死：id / createdAt 永不变，stemHash 只跟题干走
        id: prev.id,
        createdAt: prev.createdAt,
        stemHash: stemHash(patch.stem !== undefined ? patch.stem : prev.stem),
        updatedAt: now()
      };
      const questions = doc.questions.slice();
      questions[idx] = next;
      save(questions);
      return next;
    },
    remove(id: string): boolean {
      const doc = readDoc(storage);
      const next = doc.questions.filter((q) => q.id !== id);
      if (next.length === doc.questions.length) return false;
      save(next);
      return true;
    },
    importQuestions(incoming: Question[]): ImportOutcome {
      const doc = readDoc(storage);
      const prepared = incoming.map((q) => ({ ...q, stemHash: stemHash(q.stem) }));
      // id 撞车不覆盖：同一记录再次导入不是「新题」，也不能悄悄替换内容
      const seen = new Set(doc.questions.map((q) => q.id));
      const idClash: Question[] = [];
      const fresh: Question[] = [];
      for (const q of prepared) {
        if (seen.has(q.id)) idClash.push(q);
        else {
          seen.add(q.id);
          fresh.push(q);
        }
      }
      const hits: DuplicateHit[] = idClash.map((q) => ({
        incomingId: q.id, matchedId: q.id, hash: q.stemHash, langCode: q.langCode, reason: 'id' as const
      }));
      // 判重口径只有 findDuplicates（langCode + stemHash）：既有题目排前面，故首项即保留者
      const groups = findDuplicates([...doc.questions, ...fresh]);
      const dropped = new Set<string>();
      for (const g of groups) {
        const keeper = g.questionIds[0];
        for (const dupId of g.questionIds.slice(1)) {
          const q = fresh.find((x) => x.id === dupId);
          if (!q) continue; // 既有题目自身的历史重复，不归导入处理
          dropped.add(dupId);
          hits.push({ incomingId: dupId, matchedId: keeper, hash: g.hash, langCode: g.langCode, reason: 'stem' });
        }
      }
      const added = fresh.filter((q) => !dropped.has(q.id));
      if (added.length) save([...doc.questions, ...added]);
      return { added, duplicates: hits };
    }
  };
}
