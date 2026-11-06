/**
 * 题库导入解析（PR-A）：JSON → 结构校验 → 语义校验，产出「可入库候选」。
 *
 * 身份口径：id 留空按 questionId() 生成；stemHash 一律按 stem 重算，外部显式传
 * stemHash 直接拒绝。本笔只做解析与校验，不写仓储、不做 CSV、不做重复检测 ——
 * 那些在 PR-B 叠加。
 */
import type { AnswerKey, Board, ExamSystem, LangCode, Level, Question, QuestionOption, QuestionSource, QuestionType } from '../types/questionBank';
import { BOARDS, EXAM_SYSTEMS, LANG_CODES, LEVELS, QUESTION_SOURCES, QUESTION_TYPES } from '../types/questionBank';
import { questionId, stemHash, validateQuestion } from '../utils/questionBank';

export type RejectionLayer = 'structure' | 'semantic';

export interface ImportRejection {
  /** 数据行号：JSON 数组下标 + 1。0 = 整文件问题。 */
  row: number;
  field: string;
  code: string;
  message: string;
  layer: RejectionLayer;
}

export interface ImportWarningRow { row: number; field: string; code: string; message: string }
export interface ParsedQuestion { row: number; question: Question }

export interface ParseResult {
  totalRows: number;
  candidates: ParsedQuestion[];
  rejected: ImportRejection[];
  warnings: ImportWarningRow[];
}

export interface ParseOptions {
  now?: () => string;
  /** 测试可注入固定 id；生产用 utils/questionBank 的 questionId。 */
  idFactory?: () => string;
}

interface Draft {
  id?: string;
  stem: string;
  options: QuestionOption[];
  type: QuestionType;
  answerKey: AnswerKey;
  explanation?: string;
  examSystem: ExamSystem;
  board: Board;
  subject: string;
  level: Level;
  syllabusCode?: string;
  year?: number;
  paper?: string;
  knowledgeTags: string[];
  difficulty: number;
  source: QuestionSource;
  langCode: LangCode;
}

interface DraftIssue { field: string; code: string; message: string }
type DraftResult = { ok: true; draft: Draft } | { ok: false; issues: DraftIssue[] };

interface DraftInput {
  id?: unknown; stem?: unknown; options?: unknown; type?: unknown; answerKey?: unknown;
  explanation?: unknown; examSystem?: unknown; board?: unknown; subject?: unknown; level?: unknown;
  syllabusCode?: unknown; year?: unknown; paper?: unknown; knowledgeTags?: unknown;
  difficulty?: unknown; source?: unknown; langCode?: unknown;
  /** 出现即拒绝：指纹不允许导入方伪造。 */
  foreignStemHash?: unknown;
}

const REQUIRED_STRINGS = ['stem', 'type', 'examSystem', 'board', 'subject', 'level', 'langCode'] as const;
const ENUMS: [string, readonly string[]][] = [
  ['type', QUESTION_TYPES], ['examSystem', EXAM_SYSTEMS], ['board', BOARDS], ['level', LEVELS],
  ['langCode', LANG_CODES], ['source', QUESTION_SOURCES]
];

const blank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function enumOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function checkDraft(input: DraftInput): DraftResult {
  const issues: DraftIssue[] = [];
  const add = (field: string, code: string, message: string) => { issues.push({ field, code, message }); };
  const raw = input as Record<string, unknown>;

  if (input.foreignStemHash !== undefined) {
    add('stemHash', 'structure.stemHashNotAllowed', 'stemHash 由导入通道按题干重算，不接受外部传值');
  }
  if (!blank(input.id) && typeof input.id !== 'string') add('id', 'structure.type', 'id 必须是字符串（留空则自动生成）');
  for (const field of REQUIRED_STRINGS) {
    const v = raw[field];
    if (blank(v)) add(field, 'structure.required', `缺少必填字段 ${field}`);
    else if (typeof v !== 'string') add(field, 'structure.type', `${field} 必须是字符串`);
  }
  for (const [field, list] of ENUMS) {
    const v = raw[field];
    if (typeof v === 'string' && !blank(v) && !enumOf(v, list)) add(field, 'structure.enum', `${field} 不在枚举内`);
  }

  const type = enumOf(input.type, QUESTION_TYPES);
  let options: QuestionOption[] = [];
  if (!blank(input.options)) {
    if (!Array.isArray(input.options)) add('options', 'structure.type', 'options 必须是数组');
    else {
      options = input.options.map((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          add(`options[${i}]`, 'structure.type', '每个选项必须是 { key, text } 对象');
          return { key: '', text: '' };
        }
        const o = item as Record<string, unknown>;
        if (typeof o.key !== 'string') add(`options[${i}].key`, 'structure.type', '选项 key 必须是字符串');
        if (typeof o.text !== 'string') add(`options[${i}].text`, 'structure.type', '选项 text 必须是字符串');
        return { key: typeof o.key === 'string' ? o.key.trim() : '', text: typeof o.text === 'string' ? o.text.trim() : '' };
      });
    }
  }
  if ((type === 'single' || type === 'multi') && options.length === 0) add('options', 'structure.required', '选择题必须提供 options');

  let answerKey: AnswerKey = '';
  if (blank(input.answerKey)) add('answerKey', 'structure.required', '缺少 answerKey');
  else if (type === 'single') {
    if (typeof input.answerKey !== 'string') add('answerKey', 'structure.type', '单选答案必须是字符串');
    else answerKey = input.answerKey.trim();
  } else if (type === 'multi' || type === 'fill') {
    if (!Array.isArray(input.answerKey) || input.answerKey.length === 0) add('answerKey', 'structure.type', `${type} 答案必须是非空字符串数组`);
    else if (input.answerKey.some((v) => typeof v !== 'string' || !v.trim())) add('answerKey', 'structure.type', `${type} 答案数组里每项都必须是非空字符串`);
    else answerKey = (input.answerKey as string[]).map((v) => v.trim());
  } else if (type === 'judge') {
    if (typeof input.answerKey !== 'boolean') add('answerKey', 'structure.type', '判断题答案必须是 true / false');
    else answerKey = input.answerKey;
  }

  let knowledgeTags: string[] = [];
  if (blank(input.knowledgeTags)) add('knowledgeTags', 'structure.required', '缺少 knowledgeTags');
  else if (!Array.isArray(input.knowledgeTags)) add('knowledgeTags', 'structure.type', 'knowledgeTags 必须是数组');
  else if (input.knowledgeTags.some((v) => typeof v !== 'string')) add('knowledgeTags', 'structure.type', 'knowledgeTags 里每项都必须是字符串');
  else knowledgeTags = (input.knowledgeTags as string[]).map((v) => v.trim()).filter(Boolean);

  let difficulty = Number.NaN;
  if (blank(input.difficulty)) add('difficulty', 'structure.required', '缺少 difficulty');
  else if (typeof input.difficulty !== 'number' || !Number.isFinite(input.difficulty)) add('difficulty', 'structure.type', 'difficulty 必须是 1–5 的整数');
  else difficulty = input.difficulty;

  let year: number | undefined;
  if (!blank(input.year)) {
    if (typeof input.year !== 'number' || !Number.isFinite(input.year)) add('year', 'structure.type', 'year 必须是整数');
    else year = input.year;
  }

  const optional: Partial<Record<'explanation' | 'syllabusCode' | 'paper', string>> = {};
  for (const field of ['explanation', 'syllabusCode', 'paper'] as const) {
    const v = raw[field];
    if (blank(v)) continue;
    if (typeof v !== 'string') add(field, 'structure.type', `${field} 必须是字符串`);
    else optional[field] = v.trim() || undefined;
  }

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    draft: {
      id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
      stem: (input.stem as string).trim(),
      options,
      type: type as QuestionType,
      answerKey,
      explanation: optional.explanation,
      examSystem: enumOf(input.examSystem, EXAM_SYSTEMS) as ExamSystem,
      board: enumOf(input.board, BOARDS) as Board,
      subject: (input.subject as string).trim(),
      level: enumOf(input.level, LEVELS) as Level,
      syllabusCode: optional.syllabusCode,
      year,
      paper: optional.paper,
      knowledgeTags,
      difficulty,
      source: (blank(input.source) ? 'import' : enumOf(input.source, QUESTION_SOURCES)) as QuestionSource,
      langCode: enumOf(input.langCode, LANG_CODES) as LangCode
    }
  };
}

function draftFromJson(item: unknown): DraftResult {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, issues: [{ field: 'row', code: 'structure.rowNotObject', message: '每条数据必须是对象' }] };
  }
  const data = item as Record<string, unknown>;
  return checkDraft({
    id: data.id, stem: data.stem, options: data.options, type: data.type, answerKey: data.answerKey,
    explanation: data.explanation, examSystem: data.examSystem, board: data.board, subject: data.subject,
    level: data.level, syllabusCode: data.syllabusCode, year: data.year, paper: data.paper,
    knowledgeTags: data.knowledgeTags, difficulty: data.difficulty, source: data.source,
    langCode: data.langCode,
    foreignStemHash: 'stemHash' in data ? data.stemHash : undefined
  });
}

/**
 * 解析 JSON（数组，或带 questions 数组的对象），逐行做结构 + 语义校验。
 * 语义层复用 validateQuestion：大纲闭集 / 体系自洽 / 答案落在选项内都在那里。
 */
export function parseQuestionBank(text: string, options: ParseOptions = {}): ParseResult {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? questionId;
  const result: ParseResult = { totalRows: 0, candidates: [], rejected: [], warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.rejected.push({ row: 0, field: 'file', code: 'structure.jsonParse', message: `JSON 解析失败：${message}`, layer: 'structure' });
    return result;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions)
      ? (parsed as { questions: unknown[] }).questions
      : null;
  if (!list) {
    result.rejected.push({ row: 0, field: 'file', code: 'structure.jsonShape', message: 'JSON 顶层必须是数组，或含 questions 数组的对象', layer: 'structure' });
    return result;
  }
  result.totalRows = list.length;

  list.forEach((item, i) => {
    const row = i + 1;
    const parsedRow = draftFromJson(item);
    if (!parsedRow.ok) {
      for (const issue of parsedRow.issues) result.rejected.push({ row, ...issue, layer: 'structure' });
      return;
    }
    const draft = parsedRow.draft;
    const timestamp = now();
    const question: Question = {
      id: draft.id || idFactory(),
      stemHash: stemHash(draft.stem),
      stem: draft.stem,
      options: draft.options,
      type: draft.type,
      answerKey: draft.answerKey,
      explanation: draft.explanation,
      examSystem: draft.examSystem,
      board: draft.board,
      subject: draft.subject,
      level: draft.level,
      syllabusCode: draft.syllabusCode,
      year: draft.year,
      paper: draft.paper,
      knowledgeTags: draft.knowledgeTags,
      difficulty: draft.difficulty,
      source: draft.source,
      langCode: draft.langCode,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const verdict = validateQuestion({ ...draft, id: question.id, stemHash: question.stemHash, createdAt: timestamp, updatedAt: timestamp });
    if (!verdict.ok) {
      for (const e of verdict.errors) result.rejected.push({ row, field: e.field, code: e.code, message: e.message, layer: 'semantic' });
      return;
    }
    for (const w of verdict.warnings) result.warnings.push({ row, ...w });
    result.candidates.push({ row, question });
  });
  return result;
}
