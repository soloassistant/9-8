import {
  BOARDS, ENGLISH_EXAMS, EXAM_SYSTEMS, LANG_CODES, LEVELS, LEVELS_BY_EXAM, QUESTION_SOURCES,
  QUESTION_TYPES, SUBJECTS_BY_EXAM, SYLLABUS_TOPICS, type LangCode, type Question
} from '../types/questionBank';

export interface Issue { field: string; code: string; message: string }
export interface DuplicateGroup { key: string; langCode: LangCode; hash: string; questionIds: string[] }
export type ValidationResult =
  | { ok: true; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

/** 去首尾空白、合并连续空白、全半角统一、去题号前缀、LaTeX 内空白收敛、统一小写。 */
export function normalizeStem(input: string): string {
  let s = typeof input === 'string' ? input : '';
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  s = s.replace(/\$\$([^$]*)\$\$/g, (_m, body: string) => `$$${body.replace(/\s+/g, '')}$$`);
  s = s.replace(/\$([^$]*)\$/g, (_m, body: string) => `$${body.replace(/\s+/g, '')}$`);
  s = s.replace(/^\s*(?:第\s*\d{1,3}\s*题|\(\s*\d{1,3}\s*\)|\d{1,3}\s*[.、)）])\s*/, '');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 稳定哈希：FNV-1a + djb2 双 32 位，无新依赖；同一归一化题干恒定。 */
export function stemHash(input: string): string {
  let fnv = 2166136261;
  let djb = 5381;
  for (const ch of normalizeStem(input)) {
    const c = ch.codePointAt(0) || 0;
    fnv = Math.imul(fnv ^ c, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) + c) >>> 0;
  }
  return `${fnv.toString(36)}-${djb.toString(36)}`;
}

/** 可预测的稳定 id：体系 + 语言 + 题干哈希。 */
export function questionId(q: Pick<Question, 'examSystem' | 'langCode' | 'stem'>): string {
  return `qb_${q.examSystem}_${q.langCode}_${stemHash(q.stem)}`;
}

/** 按 `langCode + hash` 判重；跨语言同题不合并。 */
export function findDuplicates(questions: Question[]): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  for (const q of questions) {
    const hash = stemHash(q.stem);
    const key = `${q.langCode}:${hash}`;
    const group = groups.get(key);
    if (group) group.questionIds.push(q.id);
    else groups.set(key, { key, langCode: q.langCode, hash, questionIds: [q.id] });
  }
  return [...groups.values()].filter((g) => g.questionIds.length > 1);
}

export function validateQuestion(q: Question): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });
  const stem = typeof q.stem === 'string' ? q.stem.replace(/\s+/g, ' ').trim() : '';
  if (stem.length < 4) err('stem', 'stem.tooShort', '题干去空白后至少 4 个字符');
  if (typeof q.id !== 'string' || !q.id.trim()) err('id', 'id.empty', 'id 不能为空');

  const options = Array.isArray(q.options) ? q.options : [];
  const keys = new Set<string>();
  if (!QUESTION_TYPES.includes(q.type)) err('type', 'type.invalid', `type 必须是 ${QUESTION_TYPES.join('/')}`);
  if (q.type === 'single' || q.type === 'multi') {
    if (options.length < 2) err('options', 'options.tooFew', '选择题至少 2 个选项');
    options.forEach((o, i) => {
      const key = typeof o?.key === 'string' ? o.key.trim() : '';
      const text = typeof o?.text === 'string' ? o.text.trim() : '';
      if (!key) err(`options[${i}].key`, 'options.keyEmpty', '选项 key 不能为空');
      else if (keys.has(key)) err(`options[${i}].key`, 'options.keyDuplicate', `选项 key「${key}」重复`);
      else keys.add(key);
      if (!text) err(`options[${i}].text`, 'options.textEmpty', '选项 text 不能为空');
    });
  } else if (options.length > 0) err('options', 'options.notApplicable', `${q.type} 题不应携带选项`);

  const answer = q.answerKey as unknown;
  if (q.type === 'single') {
    if (typeof answer !== 'string') err('answerKey', 'answerKey.singleType', '单选答案必须是单个选项 key');
    else if (!keys.has(answer)) err('answerKey', 'answerKey.notInOptions', `答案「${answer}」不在选项 key 集合内`);
  } else if (q.type === 'multi') {
    if (!Array.isArray(answer) || answer.length === 0) err('answerKey', 'answerKey.multiEmpty', '多选答案必须是非空 key 数组');
    else answer.forEach((k, i) => {
      if (typeof k !== 'string' || !keys.has(k)) err(`answerKey[${i}]`, 'answerKey.notInOptions', `答案「${String(k)}」不在选项 key 集合内`);
    });
  } else if (q.type === 'fill') {
    if (!Array.isArray(answer) || answer.length === 0) err('answerKey', 'answerKey.fillEmpty', '填空答案必须是非空字符串数组');
    else answer.forEach((v, i) => {
      if (typeof v !== 'string' || !v.trim()) err(`answerKey[${i}]`, 'answerKey.fillValue', '填空答案必须是非空字符串');
    });
  } else if (q.type === 'judge' && typeof answer !== 'boolean') {
    err('answerKey', 'answerKey.judgeType', '判断题答案必须是 true/false');
  }

  const subjects = SUBJECTS_BY_EXAM[q.examSystem];
  if (!subjects?.includes(q.subject)) err('subject', 'subject.unknown', `subject「${q.subject}」不属于 ${q.examSystem}`);
  const syllabusKey = `${q.examSystem}:${q.subject}`;
  const syllabus = SYLLABUS_TOPICS[syllabusKey];
  if (!syllabus) err('subject', 'syllabus.unknown', `没有 ${syllabusKey} 的大纲闭集`);
  const tags = Array.isArray(q.knowledgeTags) ? q.knowledgeTags : [];
  if (tags.length === 0) err('knowledgeTags', 'knowledgeTags.empty', '至少 1 个知识点');
  else if (syllabus) tags.forEach((tag) => {
    if (!syllabus.includes(tag)) err('knowledgeTags', 'knowledgeTags.unknown', `知识点「${tag}」不在 ${syllabusKey} 闭集内`);
  });

  if (!Number.isInteger(q.difficulty) || q.difficulty < 1 || q.difficulty > 5) err('difficulty', 'difficulty.range', '难度必须是 1–5 的整数');
  if (!EXAM_SYSTEMS.includes(q.examSystem)) err('examSystem', 'examSystem.invalid', `examSystem「${q.examSystem}」不在枚举内`);
  if (!BOARDS.includes(q.board)) err('board', 'board.invalid', `board「${q.board}」不在枚举内`);
  if (!LEVELS.includes(q.level)) err('level', 'level.invalid', `level「${q.level}」不在枚举内`);
  else if (LEVELS_BY_EXAM[q.examSystem] && !LEVELS_BY_EXAM[q.examSystem].includes(q.level)) {
    err('level', 'level.mismatch', `level「${q.level}」不适用于 ${q.examSystem}`);
  }
  if (!LANG_CODES.includes(q.langCode)) err('langCode', 'langCode.invalid', `langCode「${q.langCode}」不在枚举内`);
  if (!QUESTION_SOURCES.includes(q.source)) err('source', 'source.invalid', `source「${q.source}」不在枚举内`);
  if (q.year !== undefined && (!Number.isInteger(q.year) || q.year < 1900 || q.year > 2100)) err('year', 'year.invalid', 'year 必须是 1900–2100 的整数');
  if (ENGLISH_EXAMS.includes(q.examSystem) && q.langCode === 'zh') {
    warnings.push({ field: 'langCode', code: 'langCode.zhInEnglishExam', message: `${q.examSystem} 通常是英文卷，zh 仅提示不拒绝` });
  }
  return errors.length ? { ok: false, errors, warnings } : { ok: true, warnings };
}
