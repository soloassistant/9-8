// 变异用例：登录页「手机号支持国际区号」（harness: .tools/verify-phone-intl.js）
//
// 运行方式（复用既有 mutation-verify 的「基线先行 + 改坏 + 还原 + sha256 校验」流水线）：
//   node .tools/mutation-verify.mjs .tools/mutations-phone.mjs
//
// 注意：mutation-verify 要求目标文件**在 git 里是干净的**（没有未提交改动）。
// 产品代码刚落盘、还没提交时，会以 ERROR 拒绝变异 —— 这是既有机制，不是本文件的 bug。
//
// 自证沙箱（产品代码未落地时用来证明「每条变异都真的被抓到」）：
//   PHONE_INTL_MUTATION_BASE=.tools/.phone-selftest/base \
//     node .tools/mutation-verify.mjs .tools/mutations-phone.mjs
// 该环境变量只影响本文件里的路径前缀与 harness 的 --root，默认（不设）就是真实 src/。
//
// 设计说明：产品源码的具体写法（变量名、缩进、引号）此刻未必可知，所以 `from` 不写死，
// 而是**运行时从真实源码里截出整个导出函数的原文**作为锚点（天然唯一、天然匹配）。
// `to` 用契约里已定稿的导出名（findDialCode / normalizeNational）重写整段函数。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.PHONE_INTL_MUTATION_BASE || '').replace(/\\/g, '/').replace(/\/+$/, '');
const prefix = BASE ? BASE + '/' : '';
const HARNESS = BASE ? `node .tools/verify-phone-intl.js --root ${BASE}` : 'node .tools/verify-phone-intl.js';

const DIAL_FILE = prefix + 'src/data/dialCodes.ts';
const PHONE_FILE = prefix + 'src/utils/phoneIntl.ts';

function readOrThrow(rel) {
  try {
    return readFileSync(path.join(REPO, rel), 'utf8');
  } catch (err) {
    throw new Error(
      `读不到变异目标 ${rel}（${err && err.code ? err.code : err}）。` +
        '产品代码可能还没落地；用 PHONE_INTL_MUTATION_BASE 指向自证沙箱。'
    );
  }
}

/** 跳过一段字符串字面量，返回收尾引号的下标。 */
function skipStringLiteral(src, start) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    if (src[i] === quote) return i;
  }
  return src.length - 1;
}

/**
 * 截出 `export function <name>(...) { ... }` 的完整原文（含 export 关键字）。
 * 用花括号配对，跳过字符串与注释，保证锚点在文件里**正好出现一次**且覆盖整个函数体。
 */
function extractExportedFunction(src, name) {
  const headerRe = new RegExp('export\\s+function\\s+' + name + '\\s*\\(');
  const header = headerRe.exec(src);
  if (!header) {
    throw new Error(`在源码里找不到 "export function ${name}(" —— 契约形状变了，请修本变异文件`);
  }
  let depth = 0;
  for (let i = header.index; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipStringLiteral(src, i);
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(header.index, i + 1);
    }
  }
  throw new Error(`无法截取 ${name} 的函数体（花括号不配平？）`);
}

const dialSrc = readOrThrow(DIAL_FILE);
const phoneSrc = readOrThrow(PHONE_FILE);

const buildOriginal = extractExportedFunction(phoneSrc, 'buildPhoneE164');
const validateOriginal = extractExportedFunction(phoneSrc, 'validateNational');

/* 注入 +1：守「北美号码被 SDK normalizePhone 改写成 +86」这条实测事故。 */
const dialArrayOpen = /export\s+const\s+DIAL_CODES\b[^=]*=\s*\[/.exec(dialSrc);
if (!dialArrayOpen) {
  throw new Error('找不到 `export const DIAL_CODES ... = [` —— 契约形状变了，请修本变异文件');
}
const US_ENTRY =
  "\n  { iso: 'US', nameZh: '美国', nameEn: 'United States', code: '1', minLen: 10, maxLen: 10, pattern: /^\\d{10}$/ }, // 变异：注入 +1";

export default [
  {
    // 被「【禁止 +1】」静态断言 + 全表 SDK 请求断言同时抓住（双重闸门）
    label: "区号表注入 code: '1'（北美号码会被 SDK 改写成 +86）",
    file: DIAL_FILE,
    from: dialArrayOpen[0],
    to: dialArrayOpen[0] + US_ENTRY,
    cmd: HARNESS
  },
  {
    // 被 buildPhoneE164('86','13800138000') / ('852',' 9123 4567 ') 抓住
    label: "buildPhoneE164 丢掉 E.164 的 '+' 前缀",
    file: PHONE_FILE,
    from: buildOriginal,
    to: `export function buildPhoneE164(code: string, national: string): string {
  const entry = findDialCode(code);
  if (!entry) return '';
  const digits = normalizeNational(national);
  if (!digits) return '';
  return code + digits; // 变异：没有 +
}`,
    cmd: HARNESS
  },
  {
    // 被 buildPhoneE164('852',' 9123 4567 ') 抓住（必须剥掉空格/分隔符）
    label: 'buildPhoneE164 忘记 normalizeNational（不剥非数字）',
    file: PHONE_FILE,
    from: buildOriginal,
    to: `export function buildPhoneE164(code: string, national: string): string {
  const entry = findDialCode(code);
  if (!entry) return '';
  if (!national) return '';
  return '+' + code + national; // 变异：原样拼接，不剥非数字
}`,
    cmd: HARNESS
  },
  {
    // 被 validateNational('852','9123456') === 'length' 抓住
    label: 'validateNational 跳过位数检查（短号被放行）',
    file: PHONE_FILE,
    from: validateOriginal,
    to: `export function validateNational(code: string, national: string): PhoneIssue {
  const entry = findDialCode(code);
  if (!entry) return 'unsupported';
  const digits = normalizeNational(national);
  if (!digits) return 'empty';
  if (entry.pattern && !entry.pattern.test(digits)) return 'format';
  return null; // 变异：不查 minLen/maxLen
}`,
    cmd: HARNESS
  },
  {
    // 被 validateNational('86','12345678901') === 'format' 抓住
    label: 'validateNational 跳过 pattern 检查（非法号段被放行）',
    file: PHONE_FILE,
    from: validateOriginal,
    to: `export function validateNational(code: string, national: string): PhoneIssue {
  const entry = findDialCode(code);
  if (!entry) return 'unsupported';
  const digits = normalizeNational(national);
  if (!digits) return 'empty';
  if (digits.length < entry.minLen || digits.length > entry.maxLen) return 'length';
  return null; // 变异：不查 pattern
}`,
    cmd: HARNESS
  }
];
