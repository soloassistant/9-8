#!/usr/bin/env node
/**
 * verify-deploy-fresh.mjs —— 发布前预检：**产物必须与当前提交一致，且自洽**。
 *
 * 为什么需要（2026-10-29 审计 P0#4）：
 *   产品入口 `D:\Agent\dist` 是「手工复制 + 面板发布」，全仓没有任何 workflow 或门禁守着它。
 *   而 `dist/build-stamp.json` 里的 `head` 字段虽然记录了构建时的提交，**从来没有人拿它跟
 *   git HEAD 比过** —— 于是「线上跑着一个落后 N 个提交的构建」这种事故无人报警（实测发生过）。
 *   更糟的是叠加「并行构建清空共享 dist」时，`robocopy /MIR` 会把半成品镜像上线：
 *   白屏 + SDK 404 + 登录/同步全废。
 *
 * 所以发布前必须过这一关：
 *   A 指纹与提交一致（build-stamp.head === git HEAD）
 *   B 入口自洽（index.html 引用的每个 js/css 都真实存在）—— 防「半成品镜像」
 *   C 关键自托管资产在位（assets/wb-sdk.js：缺了登录/同步/AI 全废）
 *   D 兜底数据可用（api/hotspot.json 能解析且 items 非空）
 *
 * 用法: node .tools/verify-deploy-fresh.mjs [dist目录，默认 dist]
 * 退出码: 0 = 可以发布；1 = 有阻塞项；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok: ok === true, detail });
  if (ok === true) pass++;
  else fail++;
}

const DIST = path.resolve(ROOT, process.argv[2] || 'dist');

// —— A. 指纹 vs git HEAD ——
let head = '';
let stampHead = '';
try {
  const { resolveGit } = require('./lib/git.cjs');
  // resolveGit() 返回「可用的 git 可执行文件路径」或 null（不会抛）
  const bin = resolveGit();
  if (bin) {
    const { execFileSync } = require('node:child_process');
    head = execFileSync(bin, ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  }
} catch (e) {
  head = '';
}
try {
  const stamp = JSON.parse(fs.readFileSync(path.join(DIST, 'build-stamp.json'), 'utf8'));
  stampHead = String(stamp.head || '');
} catch {
  stampHead = '';
}
// 「产物是否还代表当前提交」不能只看 stamp.head === HEAD：
// 只改 .tools/ 或文档的提交不影响产物，要求重建会逼着人做无意义的重建，
// 反过来又会让人干脆绕过这道门禁。按**构建输入**判：src/、config/、site/ 有改动才算过期。
let changedInputs = [];
try {
  const { resolveGit } = require('./lib/git.cjs');
  const bin = resolveGit();
  if (bin && head && stampHead) {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync(bin, ['diff', '--name-only', `${stampHead}..HEAD`], { cwd: ROOT, encoding: 'utf8' });
    changedInputs = out.split('\n').map((x) => x.trim()).filter(Boolean).filter((f) => /^(src|config|site)\//.test(f));
  }
} catch {
  changedInputs = ['(无法比对，按未过期处理并提示)'];
}
const headMatches = !!head && !!stampHead && (head.startsWith(stampHead) || stampHead.startsWith(head));
check(
  'A1 产物指纹对应当前提交（或自建产物以来没有构建输入变更）',
  headMatches || changedInputs.length === 0,
  headMatches
    ? `stamp.head=${stampHead}`
    : `stamp.head=${stampHead || '(缺失)'} git HEAD=${head || '(取不到)'}，期间改动的构建输入：${changedInputs.join(', ') || '无'}`
);

// —— B. 入口自洽：index.html 引用的每个文件都得在 ——
let html = '';
try {
  html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
} catch {
  html = '';
}
const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const missingRefs = refs.filter((r) => !fs.existsSync(path.join(DIST, r)));
check('B1 index.html 存在', !!html, DIST);
check(
  `B2 入口引用的 ${refs.length} 个 js/css 全部存在（防半成品镜像）`,
  refs.length > 0 && missingRefs.length === 0,
  missingRefs.join(', ')
);

// —— C. 自托管 SDK ——
const sdk = path.join(DIST, 'assets', 'wb-sdk.js');
check(
  'C1 自托管云 SDK 在位（缺了登录/同步/AI 全废）',
  fs.existsSync(sdk) && fs.statSync(sdk).size > 10000,
  fs.existsSync(sdk) ? `${Math.round(fs.statSync(sdk).size / 1024)}KB` : '缺失'
);

// —— D. 热点兜底数据 ——
let hot = null;
try {
  hot = JSON.parse(fs.readFileSync(path.join(DIST, 'api', 'hotspot.json'), 'utf8'));
} catch {
  hot = null;
}
check(
  'D1 热点兜底数据可解析且非空',
  !!hot && Array.isArray(hot.items) && hot.items.length > 0,
  hot ? `${hot.items.length} 条` : '缺失/不可解析'
);

console.log(`发布前预检（${path.basename(DIST)}）`);
for (const r of rows) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n${fail === 0 ? `可以发布（${pass} 项全过）` : `有 ${fail} 项阻塞，先重建再发布`}`);
process.exit(fail === 0 ? 0 : 1);
