/**
 * 判分（接入批次 3/6）：纯函数，零 UI、零 I/O。
 *
 * 判错的必须判错 —— 这是错题本和进度统计的唯一数据来源。宁可对格式宽容，
 * 也不对「答案内容」宽容：多选少选/多选、填空错位、判断题反选都算错。
 * 填空只做空白收敛、全半角统一、大小写归一，不做同义替换。
 */
import type { Question } from '../types/questionBank';

/** 用户作答：单选存 key、多选/填空存数组、判断存 boolean；未答为 null。 */
export type UserResponse = string | string[] | boolean | null;

function norm(value: string): string {
  return value
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normFill(value: string): string {
  // 填空按字符内容比较：公式里的「x = 2」与「x=2」是同一个答案，空白全部忽略
  return norm(value).replace(/\s+/g, '');
}

function sameSet(expected: string[], got: string[]): boolean {
  if (expected.length !== got.length) return false;
  const a = expected.map(norm).sort();
  const b = got.map(norm).sort();
  return a.every((v, i) => v === b[i]);
}

export function gradeAnswer(question: Question, response: UserResponse): boolean {
  const expected = question.answerKey;
  switch (question.type) {
    case 'single':
      return typeof response === 'string' && typeof expected === 'string' && norm(response) !== '' && norm(response) === norm(expected);
    case 'multi':
      return Array.isArray(response) && Array.isArray(expected) && sameSet(expected as string[], response);
    case 'fill':
      return (
        Array.isArray(response) &&
        Array.isArray(expected) &&
        expected.length === response.length &&
        expected.every((v, i) => typeof v === 'string' && typeof response[i] === 'string' && normFill(response[i]) === normFill(v))
      );
    case 'judge':
      return typeof expected === 'boolean' && typeof response === 'boolean' && response === expected;
    default:
      return false;
  }
}

/** 结果页展示的标准答案（判断题由页面用 i18n 渲染，不在这里写中文）。 */
export function formatAnswerKey(question: Question): string {
  const expected = question.answerKey;
  if (Array.isArray(expected)) return expected.join('、');
  if (typeof expected === 'boolean') return expected ? 'true' : 'false';
  return String(expected);
}

/** 提交前检查是否答完：单选非空、多选至少一项、填空每空非空、判断已选。 */
export function isResponseComplete(question: Question, response: UserResponse): boolean {
  if (question.type === 'single') return typeof response === 'string' && response.trim() !== '';
  if (question.type === 'multi') return Array.isArray(response) && response.length > 0;
  if (question.type === 'fill') return Array.isArray(response) && response.every((v) => v.trim() !== '');
  if (question.type === 'judge') return typeof response === 'boolean';
  return false;
}
