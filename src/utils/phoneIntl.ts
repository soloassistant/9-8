/**
 * 国际手机号的纯函数工具（零依赖，不 import Taro —— 便于在 Node 里独立验证）。
 *
 * 设计口径：
 *   · 区号与本地号码**分开存**：`dialCode` 只存不带 `+` 的区号（如 '852'），
 *     `national` 只存本地号码数字；两者在提交前才拼成 E.164。
 *   · 中国大陆额外有形态约束（`/^1\d{10}$/`），其余地区只校验位数区间 ——
 *     各国号段的形态规则差异太大，前端不做过度约束，剩下的交给服务端。
 */
import { findDialCode } from '../data/dialCodes';

export type PhoneIssue = 'unsupported' | 'empty' | 'length' | 'format' | null;

/** 只保留数字。H5 的 `type='number'` 仍可能放进 `e` / `.` / `-`，必须再剥一次。 */
export function normalizeNational(input: string): string {
  return String(input ?? '').replace(/\D/g, '');
}

/**
 * 拼成 E.164（如 `+85291234567`）。
 * 未知区号或号码为空时返回空串 —— 调用方拿到空串就应当判定为「不可提交」，
 * 绝不把空号码交给 SDK（SDK 对空值的行为不可依赖）。
 */
export function buildPhoneE164(code: string, national: string): string {
  const entry = findDialCode(code);
  const digits = normalizeNational(national);
  if (!entry || !digits) return '';
  return `+${entry.code}${digits}`;
}

/**
 * 校验本地号码。判定顺序（先报最根本的问题，避免"位数不对"掩盖"区号不认识"）：
 *   未知区号 → 'unsupported'；剥完数字为空 → 'empty'；
 *   位数不在 [minLen, maxLen] → 'length'；形态不匹配 → 'format'；否则 null。
 */
export function validateNational(code: string, national: string): PhoneIssue {
  const entry = findDialCode(code);
  if (!entry) return 'unsupported';
  const digits = normalizeNational(national);
  if (!digits) return 'empty';
  if (digits.length < entry.minLen || digits.length > entry.maxLen) return 'length';
  if (entry.pattern && !entry.pattern.test(digits)) return 'format';
  return null;
}
