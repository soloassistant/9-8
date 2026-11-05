#!/usr/bin/env node
/**
 * verify-modal-text —— Taro.showModal 按钮文案上限门禁（2026-11-05）
 *
 * 防的是什么（真机实测）：H5 端 Taro.showModal 对 confirmText / cancelText 硬校验
 *   text.replace(/[\u0391-\uFFE5]/g, 'aa').length > 8  →  showModal:fail
 * 即「中文最多 4 个汉字，非中文最多 8 个字符」。定位链路 perm.locCrossAgree
 * 「同意并继续」（5 汉字 → 10）每次在 DOM 创建前被拒，Promise 直接 reject，
 * 定位永远失败，页面却提示「未授权定位」——功能可用性缺陷，不是文案小问题。
 *
 * 判据（与 Taro 实现逐字一致）：
 *   - confirmText / cancelText 即使 showCancel:false 也会先校验；缺省值按 Taro
 *     默认 confirmText='确定'、cancelText='取消'；i18n 取值两边都要解析且 ≤8。
 *
 * 支持的取值形态（resolveLangs 实现）：
 *   字面量 '确定' / t('perm.agree') / t('perm.agree').slice(0,2) /
 *   lang === 'zh' ? A : B（A/B 递归解析，可嵌套上述形态）。
 * 不支持（解析不到一律按失败，不放行）：变量或函数返回值（含 t(keyVar)）、
 *   模板拼接、跨文件常量、缺 key、字典值为表达式、.replace() 等其它链式调用。
 *
 * 用法：
 *   node .tools/verify-modal-text.mjs           # 只列失败项
 *   node .tools/verify-modal-text.mjs --list    # 顺带列出每个调用点
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'src');
const LIST = process.argv.includes('--list');
const LIMIT = 8;
/** Taro h5 的归一化：CJK 统一按 2 个字符计（正则与 node_modules/@tarojs/taro-h5 完全一致） */
const CJK_RE = /[\u0391-\uFFE5]/g;
const normLen = (s) => String(s).replace(CJK_RE, 'aa').length;

function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else out += ' ';
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++; continue;
    }
    if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
    if (c === state) { state = 'code'; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function extractDict(src, name) {
  const i = src.indexOf('const ' + name);
  if (i < 0) return null;
  const start = src.indexOf('{', i);
  let depth = 0;
  let end = -1;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      j++;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(start + 1, end);
  const out = {};
  const re = /'((?:[^'\\]|\\.)+)'\s*:\s*('((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  let m;
  while ((m = re.exec(body))) {
    out[m[1]] = String(m[3] !== undefined ? m[3] : m[4])
      .replace(/\\n/g, '\n')
      .replace(/\\'/g, "'");
  }
  return out;
}

const langSrc = fs.readFileSync(path.join(SRC, 'store/language.ts'), 'utf8');
const zh = extractDict(langSrc, 'zh');
const en = extractDict(langSrc, 'en');
if (!zh || !en) {
  console.log('FAIL 无法从 src/store/language.ts 解析 zh / en 字典');
  process.exit(1);
}

/** 读到一个顶层表达式结束（逗号 / 收尾括号），跳过字符串与嵌套括号 */
function readExpr(body, start) {
  let depth = 0;
  let i = start;
  for (; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; }
      continue;
    }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return body.slice(start, i).trim();
}

/** 取对象顶层同名属性的原始表达式；没有返回 null */
function topLevelProp(body, key) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; }
      continue;
    }
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (depth === 0 && body.startsWith(key, i)) {
      let j = i + key.length;
      while (j < body.length && /\s/.test(body[j])) j++;
      if (body[j] === ':') return readExpr(body, j + 1);
    }
  }
  return null;
}

const unquote = (expr) => {
  const q = expr[0];
  if ((q === "'" || q === '"' || q === '`') && expr.length >= 2 && expr.endsWith(q)) {
    return expr.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return null;
};

/** 解析成 { zh, en } / { missingKey } / null（无法静态解析） */
function resolveLangs(expr) {
  let e = expr.trim();
  const lit = unquote(e);
  if (lit !== null) return { zh: lit, en: lit };
  const tern = /^[A-Za-z_$][\w$.]*\s*(?:===\s*'zh'|!==\s*'en')\s*\?\s*([\s\S]+?)\s*:\s*([\s\S]+)$/.exec(e);
  if (tern) {
    const a = resolveLangs(tern[1]);
    const b = resolveLangs(tern[2]);
    return a && b && a.zh != null ? { zh: a.zh, en: b.en, key: a.key || b.key } : null;
  }
  const call = /^(?:t|tt|tr)\s*\(\s*(['"])([^'"]+)\1\s*\)(?:\s*\.\s*slice\s*\(\s*(\d+)\s*,\s*(\d+)\s*\))?/.exec(e);
  if (call) {
    const key = call[2];
    if (zh[key] == null || en[key] == null) return { missingKey: key };
    const cut = (v) => (call[3] != null ? v.slice(Number(call[3]), Number(call[4])) : v);
    return { zh: cut(zh[key]), en: cut(en[key]), key };
  }
  return null;
}

function scanFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const rel = path.relative(REPO, file).replace(/\\/g, '/');
  const found = [];
  const re = /\bshowModal\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    let j = m.index + m[0].length;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '{') {
      found.push({ file: rel, line: code.slice(0, m.index).split('\n').length, unresolved: 'options 不是对象字面量（无法静态解析）' });
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let k = j; k < code.length; k++) {
      const c = code[k];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        k++;
        while (k < code.length && code[k] !== q) { if (code[k] === '\\') k++; k++; }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) continue;
    const body = code.slice(j + 1, end);
    const line = code.slice(0, m.index).split('\n').length;
    for (const [prop, fallback] of [['confirmText', '确定'], ['cancelText', '取消']]) {
      const expr = topLevelProp(body, prop);
      if (expr == null) {
        found.push({ file: rel, line, prop, expr: '(缺省)', zh: fallback, en: fallback });
        continue;
      }
      const r = resolveLangs(expr);
      if (!r) {
        found.push({ file: rel, line, prop, expr, unresolved: '无法静态解析成文案（变量/拼接/未知调用）' });
      } else if (r.missingKey) {
        found.push({ file: rel, line, prop, expr, unresolved: `i18n key 不存在或缺少一种语言：${r.missingKey}` });
      } else {
        found.push({ file: rel, line, prop, expr, key: r.key, zh: r.zh, en: r.en });
      }
    }
  }
  return found;
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
})(SRC);

const entries = files.flatMap(scanFile);
const bad = entries.filter((e) => e.unresolved || normLen(e.zh) > LIMIT || normLen(e.en) > LIMIT);
const calls = new Set(entries.map((e) => `${e.file}:${e.line}`));

if (LIST) {
  for (const e of entries) {
    const mark = e.unresolved || normLen(e.zh) > LIMIT || normLen(e.en) > LIMIT ? '✗' : '·';
    const detail = e.unresolved
      ? e.unresolved
      : `zh=${JSON.stringify(e.zh)}(${normLen(e.zh)}) en=${JSON.stringify(e.en)}(${normLen(e.en)})`;
    console.log(`${mark} ${e.file}:${e.line} ${e.prop} ${e.expr}  ${detail}`);
  }
}

console.log(`\nverify-modal-text：扫描 ${files.length} 个文件 / ${calls.size} 个 showModal 调用点 / ${entries.length} 个按钮文案`);
for (const e of bad) {
  const detail = e.unresolved
    ? e.unresolved
    : `zh=${JSON.stringify(e.zh)}(${normLen(e.zh)}) en=${JSON.stringify(e.en)}(${normLen(e.en)}) > ${LIMIT}`;
  console.log(`  ✗ ${e.file}:${e.line} ${e.prop} ${e.expr}  ${detail}`);
}
if (bad.length) {
  console.log(`\nFAIL ${bad.length}（上限：中文 ≤4 个汉字 / 非中文 ≤8 个字符，Taro h5 showModal 硬校验）`);
  process.exit(1);
}
console.log('\nPASS 全部 showModal 按钮文案都在 Taro h5 上限内');
