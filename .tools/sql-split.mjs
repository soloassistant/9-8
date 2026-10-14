#!/usr/bin/env node
/**
 * sql-split.mjs —— 把 .sql 迁移文件切成「一条语句一次 exec_sql 调用」的清单。
 *
 * 为什么不能正则凑：美元引用 $tag$…$tag$、单引号串（含 '' 转义）、双引号标识符、
 * 行注释、**可嵌套**的块注释，全靠逐字符扫描才能数对分号。
 *
 * 用法：
 *   node sql-split.mjs <file>                      # 列出每条语句 [i] 长度 + 摘要
 *   node sql-split.mjs <file> --strip-comments     # 同上，并显示剥注释后的长度
 *   node sql-split.mjs <file> --strip-comments <i> # 打印第 i 条的 base64
 *   node sql-split.mjs <file> --body-md5 <i>       # 打印第 i 条函数体的 length + md5
 *
 * CLI 主体包在 main() 里、用 import.meta 判断直接执行，以便被别的脚本 import 复用。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** 逐字符扫描，返回语句数组（纯注释块不算语句） */
export function splitSql(text) {
  const stmts = [];
  let i = 0;
  const n = text.length;
  let cur = ''; // 当前语句累积（含注释，保持原样）
  let hasCode = false; // 当前语句是否含非注释代码
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    // 行注释
    if (c === '-' && c2 === '-') {
      const j = text.indexOf('\n', i);
      const end = j === -1 ? n : j;
      cur += text.slice(i, end);
      i = end;
      continue;
    }
    // 块注释（可嵌套）
    if (c === '/' && c2 === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; continue; }
        if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      cur += text.slice(i, j);
      i = j;
      continue;
    }
    // 美元引用 $tag$…$tag$
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        cur += text.slice(i, end);
        hasCode = true;
        i = end;
        continue;
      }
    }
    // 单引号串（'' 转义）
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      cur += text.slice(i, j);
      hasCode = true;
      i = j;
      continue;
    }
    // 双引号标识符（"" 转义）
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      cur += text.slice(i, j);
      hasCode = true;
      i = j;
      continue;
    }
    if (c === ';') {
      if (hasCode) stmts.push(cur + ';');
      cur = '';
      hasCode = false;
      i++;
      continue;
    }
    if (!/\s/.test(c)) hasCode = true;
    cur += c;
    i++;
  }
  if (hasCode && cur.trim()) stmts.push(cur + ';');
  return stmts;
}

/** 剥掉行/块注释（保留字符串与美元引用内的原样），用于看「净语句」长度 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '-' && c2 === '-') {
      const j = text.indexOf('\n', i);
      i = j === -1 ? n : j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; continue; }
        if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      i = j;
      continue;
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += text.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 取第 i 条语句里第一个美元引用体的原文（CREATE FUNCTION 用；语句前导注释不含 $） */
export function extractBody(stmt) {
  const m = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/.exec(stmt);
  if (!m) return null;
  const tag = m[0];
  const start = stmt.indexOf(tag) + tag.length;
  const close = stmt.indexOf(tag, start);
  if (close === -1) return null;
  return stmt.slice(start, close);
}

function digest(s) {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

function summarize(stmt) {
  const s = stripComments(stmt).replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) {
    console.error('usage: node sql-split.mjs <file> [--strip-comments [i]] [--body-md5 i]');
    process.exit(2);
  }
  const text = readFileSync(file, 'utf8');
  const stmts = splitSql(text);
  console.log(`${file} → ${stmts.length} statements`);
  stmts.forEach((s, i) => {
    const net = stripComments(s);
    console.log(`[${i}] raw=${s.length} net=${net.length}  ${summarize(s)}`);
  });
  const scIdx = args.indexOf('--strip-comments');
  if (scIdx !== -1 && args[scIdx + 1] !== undefined) {
    const i = Number(args[scIdx + 1]);
    const net = stripComments(stmts[i]).trim();
    console.log(`--- [${i}] base64 (net, ${net.length} chars) ---`);
    console.log(Buffer.from(net, 'utf8').toString('base64'));
  }
  const md5Idx = args.indexOf('--body-md5');
  if (md5Idx !== -1 && args[md5Idx + 1] !== undefined) {
    const i = Number(args[md5Idx + 1]);
    const body = extractBody(stmts[i]);
    if (body === null) {
      console.error(`[${i}] has no dollar-quoted body`);
      process.exit(1);
    }
    console.log(`[${i}] body length=${body.length} md5=${digest(body)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sql-split.mjs')) {
  main();
}
