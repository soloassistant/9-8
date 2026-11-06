/**
 * 题库查询层（接入批次 1/5）：筛选 / 搜索 / 读取结果语义。
 *
 * 刻意把「读取」和「筛选」分开：
 *   · `loadQuestionBank` 只回答「题库读出来了吗」。读取失败返回 `status:'error'`，
 *     **绝不返回空数组** —— 从 PR-2 仓储层起就守住这条：存储损坏 / 版本不支持
 *     与「用户还没录题」是两件性质不同的事，都渲染成「题库 0 题」会让用户以为题库丢了。
 *   · `filterQuestions` 是纯函数，不碰存储；筛选条件失效只会返回错误的子集，
 *     不会静默变成全量（有 test-question-bank-query 的变异用例钉住）。
 *
 * 学科筛选始终与体系一起用：闭集 key 是 `${examSystem}:${subject}`，
 * 不扁平化——`mathematics` 在 IGCSE 与 A-Level 是两套大纲，不能混成同一科。
 */
import type { ExamSystem, Question } from '../types/questionBank';
import { EXAM_SYSTEMS } from '../types/questionBank';
import { normalizeStem } from '../utils/questionBank';
import { createQuestionBankRepo, QuestionBankError, type QuestionBankStorage } from './questionBankRepo';

export interface QuestionFilter {
  /** 为空表示「全部体系」。 */
  examSystem?: ExamSystem | null;
  /** 必须与 examSystem 一起使用；单独传会被当成该体系下的学科（闭集不扁平化）。 */
  subject?: string | null;
  /** 题干 / 解析 / 知识点 / 学科，大小写与空白归一后包含匹配。 */
  keyword?: string;
}

/** 读取结果：ok 才有 questions；error 永远不携带空数组。 */
export type QuestionBankLoad =
  | { status: 'ok'; questions: Question[] }
  | { status: 'error'; code: string; message: string };

export function matchesFilter(q: Question, filter: QuestionFilter): boolean {
  if (filter.examSystem && q.examSystem !== filter.examSystem) return false;
  if (filter.subject) {
    // 体系已给出时按闭集 key 匹配；未给出时只按学科名（调用方应总是成对传，见文件头）
    if (filter.examSystem) {
      if (q.examSystem !== filter.examSystem || q.subject !== filter.subject) return false;
    } else if (q.subject !== filter.subject) return false;
  }
  return true;
}

/** 关键词搜索：题干 + 解析 + 学科 + 知识点，复用题干归一化（全半角/空白/大小写）。 */
export function searchQuestions(questions: Question[], keyword: string): Question[] {
  const needle = normalizeStem(keyword);
  if (!needle) return questions;
  return questions.filter((q) => {
    const fields = [q.stem, q.explanation || '', q.subject, ...q.knowledgeTags];
    return fields.some((field) => normalizeStem(field).includes(needle));
  });
}

/** 先按体系/学科收窄，再按关键词搜索；两步都是纯过滤，顺序不影响结果。 */
export function filterQuestions(questions: Question[], filter: QuestionFilter): Question[] {
  const scoped = questions.filter((q) => matchesFilter(q, filter));
  return filter.keyword ? searchQuestions(scoped, filter.keyword) : scoped;
}

/** 题库里真实出现过的体系，按枚举顺序排（不展示「0 题」的体系筛选）。 */
export function examSystemsOf(questions: Question[]): ExamSystem[] {
  const present = new Set(questions.map((q) => q.examSystem));
  return EXAM_SYSTEMS.filter((s) => present.has(s));
}

/** 指定体系下真实出现过的学科（同科不同体系不会混在一起）。 */
export function subjectsOf(questions: Question[], examSystem: ExamSystem): string[] {
  const seen = new Set<string>();
  for (const q of questions) if (q.examSystem === examSystem) seen.add(q.subject);
  return [...seen];
}

/**
 * 读取题库。错误只分「读不出来」，不降级成空态：
 * 仓储层的 corrupt / versionUnsupported 都会原样带 code 返回，页面据此渲染失败态 + 重试。
 */
export function loadQuestionBank(storage: QuestionBankStorage): QuestionBankLoad {
  try {
    return { status: 'ok', questions: createQuestionBankRepo(storage).list() };
  } catch (err) {
    const code = err instanceof QuestionBankError ? err.code : 'questionBank.unknown';
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', code, message };
  }
}
