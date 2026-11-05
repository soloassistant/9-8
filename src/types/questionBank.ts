/**
 * 题库领域模型（PR-1）—— 纯类型与闭集常量，零 UI、零 I/O。
 * 硬边界：只做「对齐大纲的自编题」，不复制任何真题。`source='official'` 指用户自己持有的
 * 正版材料录入，不是我们抓取的真题；CAIE / College Board / IBO 真题版权严格，禁止抓取、转载或入库。
 */
export type ExamSystem = 'gaokao' | 'zhongkao' | 'igcse' | 'alevel' | 'ap' | 'ib' | 'other';
export type Board = 'cie' | 'edexcel' | 'aqa' | 'ocr' | 'collegeboard' | 'ibo' | 'china_moe' | 'other';
export type Level = 'hl' | 'sl' | 'as' | 'a2' | 'foundation' | 'higher' | 'standard' | 'na';
export type QuestionType = 'single' | 'multi' | 'fill' | 'judge';
export type LangCode = 'zh' | 'en';
export type QuestionSource = 'manual' | 'import' | 'official';

export const EXAM_SYSTEMS: readonly ExamSystem[] = ['gaokao', 'zhongkao', 'igcse', 'alevel', 'ap', 'ib', 'other'];
export const BOARDS: readonly Board[] = ['cie', 'edexcel', 'aqa', 'ocr', 'collegeboard', 'ibo', 'china_moe', 'other'];
export const LEVELS: readonly Level[] = ['hl', 'sl', 'as', 'a2', 'foundation', 'higher', 'standard', 'na'];
export const QUESTION_TYPES: readonly QuestionType[] = ['single', 'multi', 'fill', 'judge'];
export const LANG_CODES: readonly LangCode[] = ['zh', 'en'];
export const QUESTION_SOURCES: readonly QuestionSource[] = ['manual', 'import', 'official'];
/** 英文卷体系：这些体系用 zh 只给 warning，不拒绝（IB 也有中文 B 等课程）。 */
export const ENGLISH_EXAMS: readonly ExamSystem[] = ['igcse', 'alevel', 'ap', 'ib'];

/** 每个体系允许的层级：IB 只允许 hl/sl；高考/中考/AP 无分层（na）。 */
export const LEVELS_BY_EXAM: Record<ExamSystem, readonly Level[]> = {
  gaokao: ['na'], zhongkao: ['na'], igcse: ['foundation', 'higher'], alevel: ['as', 'a2', 'na'],
  ap: ['na'], ib: ['hl', 'sl'], other: LEVELS
};

/** subject 常量表：每个体系先只登记最小可用学科，避免任意字符串。 */
export const SUBJECTS_BY_EXAM: Record<ExamSystem, readonly string[]> = {
  gaokao: ['数学'], zhongkao: ['数学'], igcse: ['mathematics'], alevel: ['mathematics'],
  ap: ['calculus'], ib: ['mathematics-aa'], other: ['other']
};

/**
 * 按大纲分层的知识点闭集，key 为 `${examSystem}:${subject}`。
 * 只填最小可用集合（10–15 个 topic/syllabus），够验证机制；不抄全量大纲。
 */
export const SYLLABUS_TOPICS: Record<string, readonly string[]> = {
  'gaokao:数学': ['集合与常用逻辑', '函数与导数', '三角函数', '解三角形', '平面向量', '数列', '不等式', '立体几何', '解析几何', '概率与统计', '计数原理', '复数'],
  'zhongkao:数学': ['实数与代数式', '方程与不等式', '一次函数', '二次函数', '三角形', '四边形', '圆', '图形变换', '统计与概率', '实际问题建模'],
  'igcse:mathematics': ['number', 'algebra', 'algebraic manipulation', 'geometry', 'mensuration', 'trigonometry', 'statistics', 'probability', 'ratio and proportion', 'graphs of functions'],
  'alevel:mathematics': ['algebra and functions', 'coordinate geometry', 'sequences and series', 'differentiation', 'integration', 'trigonometry', 'exponentials and logarithms', 'vectors', 'proof', 'kinematics', 'forces and equilibrium', 'probability and distributions'],
  'ap:calculus': ['limits and continuity', 'differentiation', 'applications of derivatives', 'integration', 'fundamental theorem of calculus', 'differential equations', 'sequences and series', 'parametric and polar curves', 'vector-valued functions', 'numerical approximations'],
  'ib:mathematics-aa': ['algebra', 'functions', 'sequences and series', 'complex numbers', 'vectors', 'trigonometry', 'statistics', 'probability', 'calculus', 'proof', 'binomial theorem', 'geometry']
};

export interface QuestionOption { key: string; text: string }

/** 单选存 key，多选/填空存 key 或字符串数组，判断存 boolean。 */
export type AnswerKey = string | string[] | boolean;

export interface Question {
  /** 身份：独立随机生成、与内容无关、永不变更；由 utils/questionBank.questionId() 生成。 */
  id: string;
  /** 内容指纹：只用于判重与「疑似重复」提示，不参与身份。同一 id 的 stemHash 变化 = 该题被修订，引用该 id 的记录仍然有效。 */
  stemHash: string;
  /** 题干，允许 LaTeX：`$\frac{1}{2}$`、`$x^{2}$`、`$\sqrt{3}$`。 */
  stem: string;
  options: QuestionOption[];
  type: QuestionType;
  answerKey: AnswerKey;
  explanation?: string;
  examSystem: ExamSystem;
  board: Board;
  /** 必须出现在 SUBJECTS_BY_EXAM[examSystem] 中。 */
  subject: string;
  level: Level;
  syllabusCode?: string;
  year?: number;
  paper?: string;
  /** 必须落在 SYLLABUS_TOPICS[`${examSystem}:${subject}`] 闭集内。 */
  knowledgeTags: string[];
  difficulty: number;
  source: QuestionSource;
  langCode: LangCode;
  createdAt: string;
  updatedAt: string;
}
