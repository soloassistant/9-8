/**
 * verify-button-disabled.mjs —— 静态门禁：`<Button>` 的 `disabled` 必须只「真禁用」时才渲染。
 *
 * ## 守的是什么
 *
 * Taro H5 会把 `<Button disabled={false}>` 渲染成 `disabled="false"`，而 CSS 属性选择器
 * **只看属性在不在**。于是 Taro 内置的
 *
 *     taro-button-core[disabled] { color: rgba(255,255,255,.6) }
 *
 * （特异性 0,1,1）压过组件自己的类（0,1,0），把 color 顶成半透明白 —— 白底按钮直接
 * 白底白字、对比度 1.00、整个消失。2026-10-24 实测复现：
 *
 *     disabled 属性: "false"   computed color: rgba(255,255,255,0.6)
 *     computed bg:   rgb(255,255,255)          textContent: "立即订阅"（看不见）
 *
 * 根治办法只有一个：**条件为假时不要让属性出现**（`utils/buttonDisabled.ts` 返回 undefined）。
 * 提高 CSS 特异性解决不了「真禁用 vs 没禁用」的区分，因为两者在 CSS 里都是「属性存在」。
 *
 * ## 为什么是静态检查而不是渲染检查
 *
 * 渲染检查（量 computed color）更直接，但要起浏览器、要造出每个按钮的每个状态，
 * 不适合放进 CI 必跑段。这里退一步守「写法」：只要有 disabled 就必须是 disabledAttr(...)。
 * 渲染层的最终确认由人工/一次性脚本做（见 commit 说明里的 before/after 实测）。
 *
 * 用法: node .tools/verify-button-disabled.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const HELPER = path.join(SRC, 'utils', 'buttonDisabled.ts');

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond === true) {
    pass += 1;
  } else {
    failures.push(name + (detail ? ' —— ' + detail : ''));
  }
}

/* ---------- 工具：把 <Button ...> 的完整开标签切出来 ---------- */
/**
 * 从 `<Button` 起向后扫到「不在 {} 内、不在字符串内」的第一个 `>`。
 * 必须先扫括号深度：JSX 属性里常有 `{cond ? a : b}`、箭头函数、模板串，
 * 直接 indexOf('>') 会在 `=>` 上切错（本项目踩过同类坑）。
 */
function readTag(src, start) {
  let i = start + '<Button'.length;
  let depth = 0;
  let quote = '';
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return null; // 未闭合 —— 调用方判红
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** 核心判定：返回 {total, withDisabled:[{file,line,tag}], bad:[...]} */
function scan(files) {
  const withDisabled = [];
  const bad = [];
  let total = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    let at = src.indexOf('<Button');
    while (at >= 0) {
      total += 1;
      const tag = readTag(src, at);
      const line = src.slice(0, at).split(/\r?\n/).length;
      if (tag === null) {
        bad.push({ file, line, reason: '开标签未闭合（扫描器切不出边界）' });
      } else if (/\bdisabled\s*=/.test(tag)) {
        withDisabled.push({ file, line, tag });
        if (!/disabled\s*=\s*\{\s*disabledAttr\s*\(/.test(tag)) {
          bad.push({ file, line, reason: 'disabled 没用 disabledAttr()', tag });
        }
      }
      at = src.indexOf('<Button', at + 1);
    }
  }
  return { total, withDisabled, bad };
}

/* ---------- 1. 扫描器自检：坏样本必须被判红 ---------- */
console.log('0. 扫描器自检（防「一条都没匹配到」的假绿）');
{
  const good = '<Button disabled={disabledAttr(x)}>a</Button>';
  const bad1 = '<Button disabled={x}>a</Button>';
  const bad2 = '<Button onClick={() => go()} disabled={x.len === 0}>a</Button>';
  const none = '<Button onClick={go}>a</Button>';
  const r1 = scan([makeTmp(good)]);
  const r2 = scan([makeTmp(bad1)]);
  const r3 = scan([makeTmp(bad2)]);
  const r4 = scan([makeTmp(none)]);
  ok('自检：合规样本放行', r1.bad.length === 0, JSON.stringify(r1.bad));
  ok('自检：裸条件被判红', r2.bad.length === 1, JSON.stringify(r2.bad));
  ok('自检：带表达式+箭头函数的裸条件也被判红', r3.bad.length === 1, JSON.stringify(r3.bad));
  ok('自检：不含 disabled 的按钮不误判', r4.bad.length === 0 && r4.withDisabled.length === 0);
  ok('自检：切标签能跳过箭头函数的 >', r3.withDisabled.length === 1);
}

function makeTmp(content) {
  const p = path.join(ROOT, '.tmp-verify', 'button-sample-' + Math.random().toString(36).slice(2) + '.tsx');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

/* ---------- 2. helper 本身 ---------- */
console.log('\n1. utils/buttonDisabled.ts');
{
  ok('helper 存在', fs.existsSync(HELPER), HELPER);
  const code = fs.existsSync(HELPER) ? fs.readFileSync(HELPER, 'utf8') : '';
  // 必须是 `? true : undefined`。写成 `? true : false` 等于没修（React 照样会写 disabled="false"）。
  ok('返回形状是 ? true : undefined', /\?\s*true\s*:\s*undefined/.test(code));
  ok('没有退化成 ? true : false', /\?\s*true\s*:\s*false/.test(code) === false);
  ok('导出了 disabledAttr', /export\s+function\s+disabledAttr/.test(code));
}

/* ---------- 3. 全量扫描 ---------- */
console.log('\n2. 全仓 <Button>');
{
  const files = walk(SRC, []);
  const r = scan(files);
  ok('扫到了 Button（不是 0 个的假绿）', r.total > 0, 'total=' + r.total);
  ok('没有开标签切不出来', r.bad.filter((x) => x.reason && x.reason.includes('未闭合')).length === 0);
  for (const x of r.bad) {
    ok(
      `${path.relative(ROOT, x.file)}:${x.line} disabled 必须用 disabledAttr()`,
      false,
      (x.tag || '').slice(0, 120)
    );
  }
  console.log(`   Button 开标签 ${r.total} 个，其中带 disabled 的 ${r.withDisabled.length} 个`);
  for (const x of r.withDisabled) {
    console.log(`     · ${path.relative(ROOT, x.file)}:${x.line}`);
  }
}

/* ---------- 收尾 ---------- */
for (const p of fs.readdirSync(path.join(ROOT, '.tmp-verify')).filter((n) => n.startsWith('button-sample-'))) {
  try {
    fs.unlinkSync(path.join(ROOT, '.tmp-verify', p));
  } catch {
    /* 清理失败不影响判定 */
  }
}

console.log('\n' + '-'.repeat(60));
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`\nPASS ${pass} / FAIL ${failures.length}`);
  console.log('按钮 disabled 静态门禁：红');
  process.exit(1);
}
console.log(`PASS ${pass} / FAIL 0（共 ${pass} 条断言）`);
console.log('按钮 disabled 静态门禁：全绿');
