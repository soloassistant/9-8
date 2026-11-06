/**
 * 题库导入（PR-B）：在 PR-A 的解析/校验之上叠加 CSV、重复检测与分批写入。
 *
 * 身份口径：id 留空按 questionId() 生成；stemHash 一律按 stem 重算，外部显式传
 * stemHash 直接拒绝。重复按 `langCode + stemHash`（既有 + 批内都报），id 撞车
 * 显式拒绝；批次写盘失败只影响该批，已成功批次不回滚。
 */
import type { AnswerKey, Board, ExamSystem, LangCode, Level, Question, QuestionOption, QuestionSource, QuestionType } from '../types/questionBank';
import { BOARDS, EXAM_SYSTEMS, LANG_CODES, LEVELS, QUESTION_SOURCES, QUESTION_TYPES } from '../types/questionBank';
import { questionId, stemHash, validateQuestion } from '../utils/questionBank';
import { CsvParseError, parseCsv } from '../utils/questionBankCsv';
import type { QuestionBankRepo } from './questionBankRepo';

export type RejectionLayer = 'structure' | 'semantic' | 'batch';
export type ImportFormat = 'json' | 'csv';

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
  format: ImportFormat;
  totalRows: number;
  candidates: ParsedQuestion[];
  rejected: ImportRejection[];
  warnings: ImportWarningRow[];
}

export interface ParseOptions {
  format?: ImportFormat | 'auto';
  now?: () => string;
  /** 测试可注入固定 id；生产用 utils/questionBank 的 questionId。 */
  idFactory?: () => string;
}

export interface ImportDuplicate {
  row: number;
  incomingId: string;
  /** 库里保留的那条（批内重复时是先进来的那条）。 */
  matchedId: string;
  hash: string;
  langCode: LangCode;
  reason: 'existing' | 'within-batch' | 'id';
}

export interface ImportProgress {
  batch: number;
  processed: number;
  total: number;
  imported: number;
  rejected: number;
  duplicates: number;
}

export interface ImportResult extends ParseResult {
  imported: number;
  importedIds: string[];
  duplicates: ImportDuplicate[];
  batches: number;
  failedBatches: number;
}

export interface ImportOptions extends ParseOptions {
  /** 每批写入条数，默认 50；只影响落盘批次，不影响校验。 */
  batchSize?: number;
  onProgress?: (p: ImportProgress) => void;
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

interface RawRow { row: number; data: Record<string, unknown> }

/** CSV 单元格里的列表：JSON 数组字面量，或 `a|b|c`（人工在表格里补题用后者）。 */
function csvList(cell: string): unknown {
  const t = cell.trim();
  if (!t) return [];
  if (t.startsWith('[')) return JSON.parse(t);
  return t.split('|').map((s) => s.trim()).filter(Boolean);
}

function csvOptions(cell: string): unknown {
  const t = cell.trim();
  if (!t) return [];
  if (t.startsWith('[')) return JSON.parse(t);
  // `A|选项文本;B|选项文本`：只按第一个 | 切，选项文本里再有 | 会原样保留
  return t.split(';').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf('|');
    return i < 0 ? { key: pair, text: '' } : { key: pair.slice(0, i).trim(), text: pair.slice(i + 1).trim() };
  });
}

function csvAnswer(cell: string, type: string): unknown {
  const t = cell.trim();
  if (type === 'single') return t;
  if (type === 'judge') return t === 'true' ? true : t === 'false' ? false : t;
  return csvList(t);
}

function draftFromCsv(cells: Record<string, string>): DraftResult {
  const typeCell = (cells.type || '').trim();
  const parseCell = (field: string, fn: (cell: string) => unknown): unknown => {
    try {
      return fn(cells[field] || '');
    } catch (err) {
      return { __cellError: `${field} 单元格解析失败：${err instanceof Error ? err.message : String(err)}` };
    }
  };
  const options = parseCell('options', csvOptions);
  const tags = parseCell('knowledgeTags', csvList);
  const answerKey = cells.answerKey !== undefined ? parseCell('answerKey', (c) => csvAnswer(c, typeCell)) : undefined;
  for (const [field, value] of [['options', options], ['knowledgeTags', tags], ['answerKey', answerKey]] as const) {
    if (value && typeof value === 'object' && !Array.isArray(value) && '__cellError' in value) {
      return { ok: false, issues: [{ field, code: 'structure.invalidCell', message: (value as { __cellError: string }).__cellError }] };
    }
  }
  const numberCell = (field: string): unknown => {
    const t = (cells[field] || '').trim();
    return t === '' ? undefined : Number(t);
  };
  const text = (field: string): string => (cells[field] || '').trim();
  return checkDraft({
    id: text('id'), stem: cells.stem, options, type: typeCell, answerKey,
    explanation: text('explanation'), examSystem: text('examSystem'), board: text('board'),
    subject: text('subject'), level: text('level'), syllabusCode: text('syllabusCode'),
    year: numberCell('year'), paper: text('paper'), knowledgeTags: tags,
    difficulty: numberCell('difficulty'), source: text('source'), langCode: text('langCode')
  });
}

const CSV_REQUIRED = ['stem', 'options', 'type', 'answerKey', 'examSystem', 'board', 'subject', 'level', 'knowledgeTags', 'difficulty', 'langCode'] as const;

function jsonRows(text: string, result: ParseResult): RawRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.rejected.push({ row: 0, field: 'file', code: 'structure.jsonParse', message: `JSON 解析失败：${message}`, layer: 'structure' });
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions)
      ? (parsed as { questions: unknown[] }).questions
      : null;
  if (!list) {
    result.rejected.push({ row: 0, field: 'file', code: 'structure.jsonShape', message: 'JSON 顶层必须是数组，或含 questions 数组的对象', layer: 'structure' });
    return null;
  }
  return list.map((data, i) => ({ row: i + 1, data: data as Record<string, unknown> }));
}

function csvRows(text: string, result: ParseResult): RawRow[] | null {
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    const row = err instanceof CsvParseError ? err.line : 0;
    result.rejected.push({ row, field: 'file', code: 'structure.csvParse', message: err instanceof Error ? err.message : String(err), layer: 'structure' });
    return null;
  }
  if (table.length === 0 || table[0].every((h) => h.trim() === '')) {
    result.rejected.push({ row: 1, field: 'file', code: 'csv.empty', message: 'CSV 缺少表头', layer: 'structure' });
    return null;
  }
  const headers = table[0].map((h) => h.trim());
  const dup = headers.filter((h, i) => h && headers.indexOf(h) !== i);
  if (dup.length) {
    result.rejected.push({ row: 1, field: dup[0], code: 'csv.headerDuplicate', message: `表头重复：${dup.join('、')}`, layer: 'structure' });
    return null;
  }
  if (headers.includes('stemHash')) {
    result.rejected.push({ row: 1, field: 'stemHash', code: 'structure.stemHashNotAllowed', message: 'stemHash 由导入通道按题干重算，CSV 不允许携带该列', layer: 'structure' });
    return null;
  }
  const missing = CSV_REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length) {
    result.rejected.push({ row: 1, field: missing[0], code: 'csv.headerMissing', message: `表头缺少列：${missing.join('、')}`, layer: 'structure' });
    return null;
  }
  const rows: RawRow[] = [];
  table.slice(1).forEach((cells, i) => {
    if (cells.every((c) => c.trim() === '')) return;
    const data: Record<string, unknown> = {};
    headers.forEach((h, idx) => { if (h) data[h] = cells[idx] ?? ''; });
    rows.push({ row: i + 2, data });
  });
  return rows;
}

/**
 * 解析 JSON / CSV，逐行做结构 + 语义校验；语义层复用 validateQuestion。
 */
export function parseQuestionBank(text: string, options: ParseOptions = {}): ParseResult {
  const format: ImportFormat = options.format === 'json' || options.format === 'csv'
    ? options.format
    : /^\s*[{[]/.test(text.replace(/^\uFEFF/, '')) ? 'json' : 'csv';
  const result: ParseResult = { format, totalRows: 0, candidates: [], rejected: [], warnings: [] };
  const rows = format === 'json' ? jsonRows(text, result) : csvRows(text, result);
  if (!rows) return result;
  result.totalRows = rows.length;
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? questionId;

  rows.forEach(({ row, data }) => {
    const parsedRow = format === 'json' ? draftFromJson(data) : draftFromCsv(data as Record<string, string>);
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

/**
 * 解析 + 判重 + 分批写盘。判重先于写入：既有（langCode + stemHash 命中库里）、
 * 批内（先进来的那条保留）、id 撞车（库里已有该 id，不覆盖）都进 duplicates 并带上行号。
 * 某批写盘抛错只把该批各行标 batch.writeFailed，已成功批次不回滚，failedBatches 计数。
 */
export function importQuestionBank(repo: QuestionBankRepo, text: string, options: ImportOptions = {}): ImportResult {
  const parsed = parseQuestionBank(text, options);
  const result: ImportResult = { ...parsed, imported: 0, importedIds: [], duplicates: [], batches: 0, failedBatches: 0 };
  if (parsed.candidates.length === 0) return result;

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 50));
  const keyOf = (q: Question) => `${q.langCode}:${q.stemHash}`;
  const existing = repo.list();
  const seenIds = new Set(existing.map((q) => q.id));
  const existingHash = new Map<string, string>();
  for (const q of existing) if (!existingHash.has(keyOf(q))) existingHash.set(keyOf(q), q.id);

  const batchHash = new Map<string, string>();
  const fresh: ParsedQuestion[] = [];
  const addDuplicate = (row: number, q: Question, matchedId: string, reason: ImportDuplicate['reason']) => {
    result.duplicates.push({ row, incomingId: q.id, matchedId, hash: q.stemHash, langCode: q.langCode, reason });
  };

  for (const cand of parsed.candidates) {
    const q = cand.question;
    const key = keyOf(q);
    if (seenIds.has(q.id)) addDuplicate(cand.row, q, q.id, 'id');
    else if (existingHash.has(key)) addDuplicate(cand.row, q, existingHash.get(key) as string, 'existing');
    else if (batchHash.has(key)) addDuplicate(cand.row, q, batchHash.get(key) as string, 'within-batch');
    else {
      // 先记账再入队：同批里后面撞上这个 id / 指纹时也能被拦住
      seenIds.add(q.id);
      batchHash.set(key, q.id);
      fresh.push(cand);
    }
  }

  for (let i = 0; i < fresh.length; i += batchSize) {
    const batch = fresh.slice(i, i + batchSize);
    result.batches += 1;
    try {
      const outcome = repo.importQuestions(batch.map((p) => p.question));
      const addedIds = new Set(outcome.added.map((q) => q.id));
      const stored = new Set(repo.list().map((q) => q.id));
      for (const p of batch) {
        if (addedIds.has(p.question.id) && stored.has(p.question.id)) {
          result.imported += 1;
          result.importedIds.push(p.question.id);
        } else {
          const leak = addedIds.has(p.question.id) ? 'batch.notPersisted' : 'batch.duplicateLeak';
          result.rejected.push({
            row: p.row, field: 'id', code: leak, layer: 'batch',
            message: addedIds.has(p.question.id)
              ? `id「${p.question.id}」写入后读不回来`
              : `仓储层把 id「${p.question.id}」判为重复并丢弃`
          });
        }
      }
    } catch (err) {
      result.failedBatches += 1;
      const message = err instanceof Error ? err.message : String(err);
      for (const p of batch) result.rejected.push({ row: p.row, field: 'batch', code: 'batch.writeFailed', layer: 'batch', message });
    }
    options.onProgress?.({
      batch: result.batches,
      processed: Math.min(i + batchSize, fresh.length),
      total: fresh.length,
      imported: result.imported,
      rejected: result.rejected.length,
      duplicates: result.duplicates.length
    });
  }
  return result;
}
