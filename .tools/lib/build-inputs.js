// 构建输入指纹 —— 让「dist 是不是这一版源码构建出来的」可判定。
//
// 为什么不用 mtime（2026-10-23 实测踩到）：任何工具读/碰一下文件都会更新 mtime，
// `src/pages/mine/index.tsx` 内容一个字没改（git status 干净）却比 dist 新，
// 纯时间戳闸门就会误报「dist 比源码旧」。反过来，`git checkout` 把文件恢复成旧内容时
// mtime 变新，又会漏报。**判「是不是同一版源码」只能比内容，不能比时间。**
//
// 口径：`src/` + `config/` 下的全部文件 + `package.json` / `tsconfig.json` / `yarn.lock`。
// 这些就是决定 bundle 字节的输入；node_modules 与点目录一律排除（不是源码）。
//
// 用法（CommonJS，`copy-assets.js` 与 `deploy-gh-pages.mjs` 共用，避免两处口径漂移）：
//   const { computeInputs, writeStamp, readStamp } = require('./lib/build-inputs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { resolveGit } = require('./git.cjs');

const INPUT_DIRS = ['src', 'config'];
const INPUT_FILES = ['package.json', 'tsconfig.json', 'yarn.lock'];
/** 指纹落在产物里，随发布一起上线 —— 线上因此可自查「这个 bundle 出自哪个 commit」 */
const STAMP_REL = 'build-stamp.json';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(root, dir, out) {
  for (const ent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    // node_modules 与点目录不是构建输入（.git / .tools 也不该进指纹）
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      walk(root, path.posix.join(dir, ent.name), out);
      continue;
    }
    out.push(path.posix.join(dir, ent.name));
  }
}

/** 归一成 posix 相对路径并排序，保证跨平台/跨次运行一致 */
function collectInputs(root) {
  const files = [];
  for (const d of INPUT_DIRS) {
    if (fs.existsSync(path.join(root, d))) walk(root, d, files);
  }
  for (const f of INPUT_FILES) {
    if (fs.existsSync(path.join(root, f))) files.push(f);
  }
  return files.sort();
}

/**
 * 返回 { hash, files, srcHash }：hash 是全部输入内容的联合摘要，files 是逐文件摘要
 * （逐文件摘要用于在闸门拒绝时**指出到底哪个文件变了**，否则只给一个总哈希没法排查）。
 * srcHash 只覆盖 src/ —— 锁文件/配置抖动时它不动，可以据此判断「是源码变了还是只是依赖变了」。
 */
function computeInputs(root) {
  const files = collectInputs(root);
  const per = {};
  const h = crypto.createHash('sha256');
  const hs = crypto.createHash('sha256');
  for (const rel of files) {
    const one = sha256(fs.readFileSync(path.join(root, rel)));
    per[rel] = one;
    h.update(rel);
    h.update('\0');
    h.update(one);
    h.update('\n');
    if (rel.startsWith('src/')) {
      hs.update(rel);
      hs.update('\0');
      hs.update(one);
      hs.update('\n');
    }
  }
  return { hash: h.digest('hex'), srcHash: hs.digest('hex'), files: per };
}

/**
 * 工作区状态 —— **「构建输入有没有没入库的改动」**。
 *
 * 为什么必须判这个（2026-10-29 审计）：`build-stamp.json` 里记的 `head` 是**构建那一刻的 HEAD**，
 * 不是产物对应的源码状态。工作区领先 HEAD 是常态（并行会话改完还没提交就构建），
 * 于是产物里可能装着**从未进过版本库的代码**，而 stamp 看上去一切正常。
 * 产品入口 `D:\Agent\dist` 又是「手工复制 + 面板发布」，没有任何东西会拦住它。
 *
 * 口径刻意只圈**构建输入**（src/ config/ package.json tsconfig.json yarn.lock）：
 * `.tools/` 下的门禁脚本改动不影响 bundle，用它判「脏」会在并行协作时天天误报。
 * 反过来，未入库的新文件**必须**算脏 —— 它同样会进 bundle。
 *
 * 取不到 git 时返回 dirty=null（**不是 false**）：null 表示「不知道」，不能当成「干净」。
 */
function workingTreeState(root) {
  const bin = resolveGit();
  if (!bin) return { available: false, dirty: null, files: [] };
  const scope = [...INPUT_DIRS, ...INPUT_FILES];
  const run = (paths) => {
    try {
      const out = execFileSync(
        bin,
        ['status', '--porcelain', '--untracked-files=all', '--', ...paths],
        { cwd: root, encoding: 'utf8' }
      );
      return out.split('\n').filter(Boolean);
    } catch {
      return null;
    }
  };
  const scoped = run(scope);
  if (scoped === null) return { available: false, dirty: null, files: [] };
  const whole = run([]);
  return {
    available: true,
    dirty: scoped.length > 0,
    files: scoped,
    treeDirty: whole === null ? null : whole.length > 0,
    treeDirtyCount: whole === null ? null : whole.length
  };
}

function currentHead(root) {
  // 裸调 'git' 在 PATH 没有 git 时会 ENOENT 并被下面的 catch 吞成 null ——
  // 指纹里少了 head 字段，而没有任何提示。这里先解析出真实路径；
  // 解析不到仍返回 null（构建不该因为缺 git 就失败），但至少不是"悄悄少一个字段"的假象。
  const bin = resolveGit();
  if (!bin) return null;
  try {
    return execFileSync(bin, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** 由构建后置步骤调用：把这一刻的输入指纹写进 dist */
function writeStamp(dist, root) {
  const { hash, srcHash, files } = computeInputs(root);
  const wt = workingTreeState(root);
  const stamp = {
    builtAt: new Date().toISOString(),
    head: currentHead(root),
    inputsHash: hash,
    srcHash,
    inputCount: Object.keys(files).length,
    // ★ 2026-10-29 新增：诚实记录「产物是不是由**已入库**的源码构建出来的」。
    //   dirty=null 表示 git 不可用、状态未知（≠ 干净）；发布预检要求 dirty===false。
    dirty: wt.dirty === true,
    dirtyState: wt.available ? (wt.dirty ? 'dirty' : 'clean') : 'unknown',
    dirtyFiles: wt.files || [],
    treeDirty: wt.treeDirty === true,
    treeDirtyCount: wt.treeDirtyCount === null ? null : wt.treeDirtyCount,
    files
  };
  fs.writeFileSync(path.join(dist, STAMP_REL), JSON.stringify(stamp, null, 2) + '\n', 'utf8');
  return stamp;
}

function readStamp(dist) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dist, STAMP_REL), 'utf8'));
    if (!j || typeof j.inputsHash !== 'string' || !j.files) return null;
    return j;
  } catch {
    return null;
  }
}

/** 对比指纹，返回 { ok, changed: [rel...] } */
function diffAgainstStamp(dist, root) {
  const stamp = readStamp(dist);
  const now = computeInputs(root);
  if (!stamp) return { ok: false, reason: 'no-stamp', changed: [], now };
  const changed = [];
  for (const [rel, sha] of Object.entries(now.files)) {
    if (stamp.files[rel] !== sha) changed.push(rel);
  }
  for (const rel of Object.keys(stamp.files)) {
    if (!(rel in now.files)) changed.push(rel + '（已删除）');
  }
  return { ok: changed.length === 0, changed, stamp, now };
}

module.exports = {
  STAMP_REL,
  INPUT_DIRS,
  INPUT_FILES,
  collectInputs,
  computeInputs,
  currentHead,
  workingTreeState,
  writeStamp,
  readStamp,
  diffAgainstStamp
};
