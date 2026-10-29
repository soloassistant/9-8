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

// —— A. 指纹：产物是否由当前这批输入产出 ——
// 比**输入内容哈希**，不比 commit：第一版用 `git diff stampHead..HEAD` 判「有没有 src 改动」，
// 结果产物是「提交前构建、提交后发布」这个最常见的顺序时就误报过期（改动其实已经打进产物了）。
// lib/build-inputs 的 diffAgainstStamp 才是准确语义：逐文件比内容哈希。
let stamp = null;
let changedInputs = [];
let head = '';
try {
  const { diffAgainstStamp, readStamp } = require('./lib/build-inputs');
  const d = diffAgainstStamp(DIST, ROOT);
  changedInputs = d.changed || [];
  stamp = d.stamp || readStamp(DIST);
  try {
    const { resolveGit } = require('./lib/git.cjs');
    const bin = resolveGit();
    if (bin) {
      const { execFileSync } = require('node:child_process');
      head = execFileSync(bin, ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    }
  } catch {
    head = '';
  }
  check(
    'A1 产物由当前这批输入产出（逐文件比内容哈希）',
    changedInputs.length === 0,
    changedInputs.length ? `有 ${changedInputs.length} 个输入变了：${changedInputs.slice(0, 6).join(', ')}${changedInputs.length > 6 ? ' …' : ''}` : ''
  );
  check(
    'A2 指纹里记的提交存在（便于回溯"这份产物是哪个提交时构建的"）',
    !!stamp && !!stamp.head,
    `stamp.head=${(stamp && stamp.head && stamp.head.slice(0, 7)) || '(缺失)'} 当前 HEAD=${head ? head.slice(0, 7) : '(取不到)'}`
  );
} catch (e) {
  check('A1 产物由当前这批输入产出（逐文件比内容哈希）', false, String((e && e.message) || e));
}

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
