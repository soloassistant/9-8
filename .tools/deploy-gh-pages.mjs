#!/usr/bin/env node
/**
 * deploy-gh-pages.mjs —— 把 `dist/` 发布到 gh-pages 分支（本项目 H5 的唯一上线通道）。
 *
 * 为什么需要它（2026-10-23）：
 *   1. 仓库里**根本没有** `deploy-gh-pages.ps1`（只有 SFTP 的 `deploy.ps1`，那不是上线通道），
 *      部署一直是手敲一段 Git Bash 命令，纯靠人记。漏一步就把旧产物推上线。
 *   2. 更要命的是**没有新鲜度校验**：只要 `dist/index.html` 存在就能推，
 *      于是「源码改了、没重新构建、直接部署」会把**旧 bundle** 送上线，且没有任何报错。
 *      这正是本轮发现的「三档漂移」（origin/main 13:32 / 本地 dist 11:35 / 线上 10:17）的成因。
 *   3. `refresh-data.yml` 每 30 分钟往 gh-pages 推 `api/hotspot.json`。本脚本若整树覆盖，
 *      会把刚刷新的热点数据**回退**成构建时的旧快照 —— 所以发布前要做「不降级合并」。
 *
 * 用法：
 *   node .tools/deploy-gh-pages.mjs                # 校验 + 发布
 *   node .tools/deploy-gh-pages.mjs --check-only   # 只跑校验（新鲜度/资源/热点），不推送
 *   node .tools/deploy-gh-pages.mjs --allow-stale   # 跳过新鲜度闸（慎用，只在明确知道原因时）
 *
 * 退出码：0 成功；1 校验失败（不推送）；2 git/网络失败。
 *
 * 设计取舍（都是踩过坑之后的决定）：
 *   · **非 force 推送**：commit 的父提交取当前 gh-pages 尖端，于是正常情况是快进。
 *     force 会静默覆盖 refresh-data 的提交；非 force 遇到竞态只会被拒 → 重试时重新取父提交。
 *   · **不删 gh-pages 上的其它文件？会删。** 本脚本用 `read-tree --empty` 重建整棵树，
 *     即「dist 是唯一真相」。所以 hotspot.json 必须在发布前并入 dist（见 mergeHotspot）。
 *   · 产物引用校验只认 `index.html` 里真实声明的 script/link —— 少一个文件线上就是白屏，
 *     而 SPA fallback 会把 index.html 当 JS 返回，报的是 `Unexpected token '<'`，极难现场定位。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// build-inputs 是 CommonJS（copy-assets.js 也要用），ESM 里用 createRequire 引
const require = createRequire(import.meta.url);

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');
const HOTSPOT = path.join(DIST, 'api', 'hotspot.json');
const BRANCH = 'gh-pages';

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check-only');
const ALLOW_STALE = argv.includes('--allow-stale');

/** CI 里 git 凭据由 actions/checkout 注入；本机要走 Windows 凭据管理器（wincred） */
const IS_CI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';

const log = (...a) => console.log('[deploy]', ...a);

function die(msg, code = 1) {
  console.error('[deploy] ✗ ' + msg);
  process.exit(code);
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) }
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * 推送/拉取时的凭据参数。
 * CI：不动 helper（checkout 已把 token 写进 http.extraheader）。
 * 本机：**必须** `-c credential.helper=` 清空继承的 helper，再显式用 wincred ——
 *       只写后者会因继承的 helper 先响应而拿不到凭据（本项目踩过，表现为长时间无输出）。
 */
function credArgs() {
  return IS_CI ? [] : ['-c', 'credential.helper=', '-c', 'credential.helper=wincred'];
}

/* ============================ 1. 前置校验 ============================ */

function preflight() {
  if (!fs.existsSync(INDEX)) {
    die('dist/index.html 不存在。先跑两步构建：\n' +
      '  node node_modules/@tarojs/cli/bin/taro build --type h5\n' +
      '  node .tools/copy-assets.js dist');
  }

  // ---- 新鲜度闸：dist 必须是「当前源码」构建出来的 ----
  // 主判据 = 构建指纹（dist/build-stamp.json 里的输入内容哈希）。
  // 不用 mtime：读文件就会更新 mtime，内容未变也会误报（实测踩到 src/pages/mine/index.tsx）。
  // 没有指纹（老产物 / 指纹写入失败）时退化为 mtime 判据并明确告警。
  const { diffAgainstStamp } = require('./lib/build-inputs');
  const diff = diffAgainstStamp(DIST, ROOT);

  if (diff.reason === 'no-stamp') {
    log('⚠ dist 里没有 build-stamp.json（旧产物？），退化为 mtime 判据');
    const distMtime = fs.statSync(INDEX).mtimeMs;
    let newest = { file: '(none)', mtime: 0 };
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
          walk(p);
          continue;
        }
        const m = fs.statSync(p).mtimeMs;
        if (m > newest.mtime) newest = { file: path.relative(ROOT, p), mtime: m };
      }
    };
    for (const d of ['src', 'config']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
    if (newest.mtime > distMtime) {
      const msg =
        `dist 比源码旧（差 ${Math.round((newest.mtime - distMtime) / 1000)}s），拒绝发布。\n` +
        `  源码 ${newest.file} 更新于 ${new Date(newest.mtime).toLocaleString()}\n` +
        `  dist 构建于        ${new Date(distMtime).toLocaleString()}\n` +
        `请先重新构建：npm run build:h5`;
      if (ALLOW_STALE) log('⚠ --allow-stale：' + msg);
      else die(msg);
    } else {
      log('✓ mtime 判据通过（但无法证明 dist 对应当前源码，建议重新构建以生成指纹）');
    }
  } else if (!diff.ok) {
    const msg =
      `dist 不是当前源码构建出来的，拒绝发布。以下构建输入在构建后被改过：\n` +
      diff.changed.map((f) => '  · ' + f).join('\n') +
      `\n指纹：构建时 ${String(diff.stamp.inputsHash).slice(0, 12)}… / 现在 ${String(diff.now.hash).slice(0, 12)}…` +
      `\n构建于 ${diff.stamp.builtAt}${diff.stamp.head ? `，对应 commit ${String(diff.stamp.head).slice(0, 7)}` : ''}` +
      `\n请先重新构建：npm run build:h5`;
    if (ALLOW_STALE) log('⚠ --allow-stale：' + msg);
    else die(msg);
  } else {
    log(`✓ 新鲜度闸通过（指纹 ${diff.stamp.inputsHash.slice(0, 12)}…，${diff.stamp.inputCount} 个输入与构建时一致）`);
  }

  // ---- 依赖变更告警（不阻断）：package.json / yarn.lock 有未提交改动时，
  // 发布出去的产物无法由任何一个 commit 复现。CI 上永远是干净的，所以只在本机出现。----
  const depDirty = git(['status', '--porcelain', '--', 'package.json', 'yarn.lock']);
  if (depDirty.code === 0 && depDirty.out) {
    log('⚠ 依赖文件有未提交改动（发布产物无法由 commit 复现）：\n    ' + depDirty.out.replace(/\n/g, '\n    '));
  }

  // ---- 产物引用校验：index.html 声明的每个资源都必须真实存在 ----
  const html = fs.readFileSync(INDEX, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('data:'));
  const missing = [];
  for (const ref of refs) {
    const rel = ref.replace(/^\.?\//, '').split('?')[0];
    if (!fs.existsSync(path.join(DIST, rel))) missing.push(ref);
  }
  if (missing.length) {
    die('index.html 引用的资源缺失（线上会白屏 / 报 Unexpected token \'<\'）：\n  ' + missing.join('\n  ') +
      '\n最常见原因：只跑了 taro build，漏了 `node .tools/copy-assets.js dist`（它负责拷 assets/wb-sdk.js）');
  }
  log(`✓ 产物引用校验通过（${refs.length} 个本地资源全部存在）`);

  const jsMatch = html.match(/js\/(app\.[a-z0-9]+\.js)/);
  log(`本次将发布的 bundle：${jsMatch ? jsMatch[1] : '(未识别)'}`);
}

/* ==================== 2. 热点数据「不降级」合并 ==================== */

function repoSlug() {
  const r = git(['remote', 'get-url', 'origin']);
  if (r.code !== 0) return null;
  const m = r.out.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function readUpdatedAt(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = j && j.updatedAt ? Date.parse(j.updatedAt) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * gh-pages 上的 hotspot.json 由 refresh-data.yml 每 30 分钟刷新一次。
 * 若我们直接把构建时的 dist 推上去，会把**更新的线上数据回退**成旧快照。
 * 所以：拉远端那份，只要它比本地新，就把它写回 dist 再发布。
 * 拉取失败不阻断发布（fail-open），但会明确告警 —— 宁可发旧数据，也不要发不出去。
 */
async function mergeHotspot() {
  const localTs = readUpdatedAt(HOTSPOT);
  const slug = repoSlug();
  if (!slug) {
    log('⚠ 无法从 origin 解析出 GitHub owner/repo，跳过热点合并');
    return;
  }
  const url = `https://raw.githubusercontent.com/${slug.owner}/${slug.repo}/${BRANCH}/api/hotspot.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      log(`⚠ 热点合并跳过：远端返回 HTTP ${res.status}`);
      return;
    }
    const text = await res.text();
    const remoteTs = (() => {
      try {
        return Date.parse(JSON.parse(text).updatedAt) || null;
      } catch {
        return null;
      }
    })();
    if (!remoteTs) {
      log('⚠ 热点合并跳过：远端文件无法解析');
      return;
    }
    if (localTs === null) {
      fs.writeFileSync(HOTSPOT, text, 'utf8');
      log(`✓ 本地热点缺失，已采用远端（${new Date(remoteTs).toISOString()}）`);
      return;
    }
    if (remoteTs > localTs) {
      fs.writeFileSync(HOTSPOT, text, 'utf8');
      log(`✓ 远端热点更新，已并入（${new Date(localTs).toISOString()} → ${new Date(remoteTs).toISOString()}）`);
    } else {
      log(`✓ 本地热点不旧于远端（本地 ${new Date(localTs).toISOString()}），保持不变`);
    }
  } catch (e) {
    log(`⚠ 热点合并跳过（${String(e.message || e)}）—— 发布继续，但热点可能是构建时快照`);
  }
}

/* ============================ 3. 发布 ============================ */

function currentRemoteTip() {
  const f = git(['fetch', 'origin', BRANCH, '--quiet', ...credArgs()]);
  if (f.code !== 0) {
    // 分支可能还不存在（首次发布）：用空父提交
    log('⚠ 拉取 origin/' + BRANCH + ' 失败（首次发布？），将创建无父提交');
    return null;
  }
  const r = git(['rev-parse', 'origin/' + BRANCH]);
  return r.code === 0 ? r.out : null;
}

/** 用 dist/ 的内容造一棵 git 树（GIT_WORK_TREE 指向 dist，索引文件临时） */
function buildTree() {
  const idx = path.join(ROOT, '.git', `gh-pages-index-${process.pid}`);
  const env = {
    GIT_DIR: path.join(ROOT, '.git'),
    GIT_WORK_TREE: DIST,
    GIT_INDEX_FILE: idx
  };
  try {
    let r = git(['read-tree', '--empty'], { env });
    if (r.code !== 0) die('git read-tree 失败: ' + r.err, 2);
    r = git(['add', '-f', '-A'], { env });
    if (r.code !== 0) die('git add 失败: ' + r.err, 2);
    const t = git(['write-tree'], { env });
    if (t.code !== 0) die('git write-tree 失败: ' + t.err, 2);
    return t.out;
  } finally {
    try {
      fs.rmSync(idx, { force: true });
    } catch {
      /* 清理失败不影响发布 */
    }
  }
}

function commitTree(tree, parent, message) {
  const args = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit-tree', tree];
  if (parent) args.push('-p', parent);
  args.push('-m', message);
  const r = git(args);
  if (r.code !== 0) die('git commit-tree 失败: ' + r.err, 2);
  return r.out;
}

async function deploy() {
  const sha = git(['rev-parse', '--short', 'HEAD']).out || 'unknown';
  const message = `deploy: H5 ${sha} (${new Date().toISOString()})`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const parent = currentRemoteTip();
    const tree = buildTree();
    const commit = commitTree(tree, parent, message);
    log(`第 ${attempt} 次推送：commit=${commit.slice(0, 10)} parent=${parent ? parent.slice(0, 10) : '(none)'}`);

    const push = git(['push', 'origin', `${commit}:refs/heads/${BRANCH}`, ...credArgs()]);
    if (push.code === 0) {
      log('✓ 已发布到 ' + BRANCH);
      return commit;
    }
    // 非快进（refresh-data 刚好推了新的）→ 重新取父提交重试；其它错误直接失败
    if (/non-fast-forward|fetch first|rejected/i.test(push.err)) {
      log(`⚠ 远端在发布期间被更新（多半是 refresh-data），重试 ${attempt}/3`);
      continue;
    }
    die('推送失败：' + push.err, 2);
  }
  die('连续 3 次推送被拒（远端持续变动），已放弃', 2);
}

/** 发布后复核：远端树里的 bundle 名与本地产物一致（防「推上去的是旧包」） */
function verifyRemote(expectedCommit) {
  const f = git(['fetch', 'origin', BRANCH, '--quiet', ...credArgs()]);
  if (f.code !== 0) {
    log('⚠ 发布后复核跳过（fetch 失败）');
    return false;
  }
  const tip = git(['rev-parse', 'origin/' + BRANCH]).out;
  const html = git(['show', `origin/${BRANCH}:index.html`]).out;
  const remoteBundle = (html.match(/js\/(app\.[a-z0-9]+\.js)/) || [])[1];
  const localBundle = (fs.readFileSync(INDEX, 'utf8').match(/js\/(app\.[a-z0-9]+\.js)/) || [])[1];
  const okBundle = !!remoteBundle && remoteBundle === localBundle;

  // 远端热点不能比本地旧（否则说明合并没生效）
  const remoteHot = git(['show', `origin/${BRANCH}:api/hotspot.json`]).out;
  let remoteTs = null;
  try {
    remoteTs = Date.parse(JSON.parse(remoteHot).updatedAt) || null;
  } catch {
    remoteTs = null;
  }
  const localTs = readUpdatedAt(HOTSPOT);
  const okHot = remoteTs !== null && localTs !== null && remoteTs >= localTs;

  log(`复核：远端 tip=${(tip || '').slice(0, 10)}（期望 ${String(expectedCommit).slice(0, 10)}）`);
  log(`复核：远端 bundle=${remoteBundle} / 本地=${localBundle} → ${okBundle ? '✓' : '✗'}`);
  log(`复核：远端热点=${remoteTs ? new Date(remoteTs).toISOString() : '(不可解析)'} → ${okHot ? '✓' : '✗'}`);
  return okBundle && okHot;
}

/* ============================ main ============================ */

(async () => {
  log(`仓库 ${ROOT}`);
  log(`模式 ${CHECK_ONLY ? '仅校验' : '校验 + 发布'}${IS_CI ? '（CI）' : '（本机）'}`);
  preflight();
  await mergeHotspot();
  if (CHECK_ONLY) {
    log('✓ 仅校验模式：全部通过，未推送');
    return;
  }
  const commit = await deploy();
  if (!verifyRemote(commit)) die('发布后复核未通过：远端产物与本地不一致', 2);
  log('✓ 全部完成');
})().catch((e) => die(String((e && e.stack) || e), 2));
