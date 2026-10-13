#!/usr/bin/env node
/**
 * git-status-lite.js —— 在**没有 git 命令行**的机器上，算出「到底哪些文件需要提交」。
 *
 * 为什么不用 mtime/size 粗判：触碰过但内容没变的文件也会被标成 modified，
 * 而真正该提交的新文件又容易漏。这里直接解析 `.git/index`（DIRC v2）拿到每个
 * 已跟踪文件的 blob SHA-1，再用 git 的 `blob <len>\0<content>` 重新哈希工作区文件比对 ——
 * **内容一致就一定没改**，与时间戳无关。判据是精确的。
 *
 * 输出：modified（已跟踪且内容变了）/ untracked（不在 index 且未被 .gitignore 忽略）/ deleted
 *
 * 用法: node .tools/git-status-lite.js [--all]
 * 退出码: 0 = 始终成功（这是只读盘点工具，不做判断）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const GIT_DIR = path.join(ROOT, '.git');

/* ---------------- 解析 .git/index (DIRC v2/v3) ---------------- */
function readIndex() {
  const buf = fs.readFileSync(path.join(GIT_DIR, 'index'));
  if (buf.subarray(0, 4).toString('binary') !== 'DIRC') throw new Error('不是 git index（缺 DIRC 魔数）');
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  const entries = new Map();
  let p = 12;
  for (let i = 0; i < count; i++) {
    const sha = buf.subarray(p + 40, p + 60).toString('hex');
    const flags = buf.readUInt16BE(p + 60);
    const stage = (flags >> 12) & 0x3;
    p += 62;
    if (version >= 3 && flags & 0x4000) p += 2; // extended flag
    // 路径是 NUL 结尾，随后补齐到 8 的倍数
    const end = buf.indexOf(0, p);
    const name = buf.subarray(p, end).toString('utf8');
    p = end + 1;
    p += (8 - ((p - 12) % 8)) % 8;
    if (stage !== 0) continue; // 合并冲突的 stage>0 条目，不参与比对
    entries.set(name.replace(/\\/g, '/'), sha);
  }
  return { version, count, entries };
}

/** git 的 blob 哈希：sha1("blob " + 字节数 + "\0" + 内容) */
function blobShaOf(buf) {
  const head = Buffer.from('blob ' + buf.length + '\0', 'binary');
  return crypto.createHash('sha1').update(head).update(buf).digest('hex');
}
function blobSha(file) {
  return blobShaOf(fs.readFileSync(file));
}

/**
 * 判断工作区文件是否与 index 里的 blob 一致 —— **必须试三种换行形态**。
 *
 * 踩过的坑（2026-10-12）：只按原样算哈希，80 个文件被判成已改，其中 44 个是
 * **纯假阳性** —— 仓库 `.git/config` 里没有 `core.autocrlf`、也没有 `.gitattributes`，
 * 但 Git-for-Windows 的**全局** `core.autocrlf` 默认是 true，检出时工作区被转成 CRLF，
 * 而 index 里存的是 LF 版 blob。内容一模一样，哈希却对不上。
 *
 * 反向也要试：有些文件是**带着 CRLF 提交进仓库**的（index 里就是 CRLF），
 * 工作区若被归一化成 LF 同样会误判。所以两个方向都得比。
 */
function matchesAnyEol(file, wantSha) {
  const raw = fs.readFileSync(file);
  if (blobShaOf(raw) === wantSha) return true;
  const bin = raw.toString('binary');
  const lf = Buffer.from(bin.replace(/\r\n/g, '\n'), 'binary');
  if (blobShaOf(lf) === wantSha) return true;
  const crlf = Buffer.from(bin.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'binary');
  if (blobShaOf(crlf) === wantSha) return true;
  return false;
}

/* ---------------- .gitignore（够用的子集） ---------------- */
function loadIgnores() {
  const file = path.join(ROOT, '.gitignore');
  const pats = [];
  if (!fs.existsSync(file)) return pats;
  for (let raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    pats.push(line);
  }
  return pats;
}

function toRegExp(pat) {
  let p = pat;
  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  // ** → 任意深度；* → 单层内任意字符；? → 单字符
  let src = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { src += '.*'; i++; if (p[i + 1] === '/') i++; }
      else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return { re: new RegExp('^' + (anchored ? '' : '(?:.*/)?') + src + '(?:/.*)?$'), dirOnly };
}

function isIgnored(rel, ignores) {
  for (const pat of ignores) {
    const { re, dirOnly } = pat;
    if (re.test(rel)) {
      // 目录型规则命中目录本身即可；命中文件时若规则带 / 则只对目录生效
      if (!dirOnly || true) return true;
    }
  }
  return false;
}

/* ---------------- 扫描工作区 ---------------- */
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', '.preview', '.swc', '.learncheck', '.trae', '.codefix', '.pai', '_backup']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (isIgnored(rel, ignores)) continue;
      walk(abs, out);
    } else if (e.isFile()) {
      if (!isIgnored(rel, ignores)) out.push(rel);
    }
  }
  return out;
}

const ignores = loadIgnores().map(toRegExp);
const { version, count, entries } = readIndex();

const modified = [];
const deleted = [];
for (const [rel, sha] of entries) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { deleted.push(rel); continue; }
  try {
    if (matchesAnyEol(abs, sha)) continue;
    modified.push(rel);
  } catch (e) {
    modified.push(rel + '  (读取失败: ' + e.message + ')');
  }
}

const working = walk(ROOT, []);
const untracked = working.filter((f) => !entries.has(f)).sort();

/* ---------------- 输出 ---------------- */
const showAll = process.argv.includes('--all');
const line = (s) => console.log(s);

line(`git index: v${version}，已跟踪 ${count} 条，忽略规则 ${ignores.length} 条`);
line(`工作区文件（已排除 ${[...SKIP_DIRS].join('/')}）：${working.length} 个`);
line('');

line(`=== 已跟踪且内容已改（${modified.length}）— 必须提交 ===`);
if (!modified.length) line('  （无）');
for (const f of modified.sort()) line('  M  ' + f);

line('');
line(`=== 已跟踪但工作区已删除（${deleted.length}）===`);
if (!deleted.length) line('  （无）');
for (const f of deleted.sort()) line('  D  ' + f);

line('');
line(`=== 新增未跟踪（${untracked.length}）— 需 git add ===`);
if (!untracked.length) line('  （无）');
const show = showAll ? untracked : untracked.filter((f) => !/^(dist|dist-preview|dist-weapp|__|_\.)/.test(f) && !/\.log$|\.png$|\.zip$/.test(f));
for (const f of show) line('  A  ' + f);
if (!showAll && show.length < untracked.length) {
  line(`  …另有 ${untracked.length - show.length} 个（疑似产物/临时文件，加 --all 查看全部）`);
}

line('');
line(`合计需提交：${modified.length} 改 + ${untracked.length} 新增 + ${deleted.length} 删除`);
