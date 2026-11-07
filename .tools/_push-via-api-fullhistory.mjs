// _push-via-api-fullhistory.mjs —— github.com:443 不通时的保真推送后备（2026-10-31）
//
// 与 .tools/push-via-api.py 的区别：那个把 base→head 压成**单提交**（为 main 设计）；
// 本脚本把 `<remote-tip>..<local-tip>` 之间的**每个提交**按拓扑序逐个上传
// （blob → tree(base_tree) → commit(parents)），最后 PATCH ref（force=false）。
// 效果与 git push 完全等价：远端历史逐提交一致，无压缩、无改写。
//
// 安全性：所有对象先建、ref 最后更新；中途失败只留孤儿对象，远端分支不受影响。
// PATCH 带 force=false，服务端做快进校验。
//
// 用法：node _push-via-api-fullhistory.mjs <branch> [--dry]

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BRANCH = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!BRANCH) { console.error('用法: node _push-via-api-fullhistory.mjs <branch> [--dry]'); process.exit(2); }

const OWNER = 'soloassistant', REPO = '9-8', API = 'https://api.github.com';
const GIT = 'C:/Users/geral/.workbuddy/binaries/PortableGit/versions/1.3.0/cmd/git.exe';

const git = (...a) => execFileSync(GIT, a, { cwd: root, maxBuffer: 1 << 28 });
const gitBuf = (...a) => execFileSync(GIT, a, { cwd: root, maxBuffer: 1 << 28, encoding: 'buffer' });
const gitStr = (...a) => git(...a).toString('utf8').trim();

// ---- token：直读 wincred helper（勿走 credential fill —— helper-selector 在无 TTY 时挂住）----
// ⚠️ 别用 fs.globSync 做版本通配：node 22.22 在 Windows 上「中间段 * 」返回空
//   （'versions/*/mingw64/…' 匹配不到，首段/尾段却正常）——用 readdirSync 手动解析。
function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const versionsDir = join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'PortableGit', 'versions');
  const helpers = [];
  try {
    for (const v of readdirSync(versionsDir)) {
      const h = join(versionsDir, v, 'mingw64', 'bin', 'git-credential-wincred.exe');
      if (existsSync(h)) helpers.push(h);
    }
  } catch { /* versions 目录不存在 */ }
  for (const h of helpers) {
    try {
      const out = execFileSync(h, ['get'], { input: 'protocol=https\nhost=github.com\n\n', timeout: 20000 });
      const m = out.toString('utf8').match(/^password=(.+)$/m);
      if (m) return m[1].replace(/\r$/, '');
    } catch { /* try next */ }
  }
  throw new Error('取不到 GitHub 凭据（env / wincred helper 均失败）');
}
const TOKEN = resolveToken();

async function api(method, path, payload, attempt = 1) {
  let res, text;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'push-via-api-fullhistory',
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    text = await res.text();
  } catch (e) {
    // 本机到 github 的链路偶发抖动（ECONNRESET / TLS 中断）—— 退避重试
    if (attempt < 5) {
      const wait = attempt * 8000;
      console.log(`  [net] ${method} ${path} 失败（${e.cause?.code || e.code || e.message}），${wait / 1000}s 后第 ${attempt + 1} 次尝试`);
      await new Promise(r => setTimeout(r, wait));
      return api(method, path, payload, attempt + 1);
    }
    throw e;
  }
  if (!res.ok) {
    // 5xx / 二次限流同样退避重试；4xx（除 403/429）是逻辑错误，直接抛
    const retryable = res.status >= 500 || res.status === 403 || res.status === 429;
    if (retryable && attempt < 5) {
      const wait = attempt * 8000;
      console.log(`  [api] HTTP ${res.status} on ${path}，${wait / 1000}s 后第 ${attempt + 1} 次尝试`);
      await new Promise(r => setTimeout(r, wait));
      return api(method, path, payload, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} on ${method} ${path}\n${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : {};
}

const localTip = gitStr('rev-parse', 'HEAD');
const remote = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const remoteTip = remote.object.sha;
console.log(`local  HEAD = ${localTip}`);
console.log(`remote ${BRANCH} = ${remoteTip}`);

const commits = gitStr('rev-list', '--reverse', `${remoteTip}..${localTip}`).split('\n').filter(Boolean);
console.log(`待上传提交：${commits.length}`);
if (DRY) { console.log('[dry] 跳过执行'); process.exit(0); }

const objMap = new Map(); // 本地 commit sha → { sha: 远端新建 commit sha, tree: 远端 tree sha }
for (const c of commits) {
  const parentsLine = gitStr('rev-list', '--parents', '-1', c).split(/\s+/); // [c, p1, (p2)...]
  const parents = parentsLine.slice(1).map(p => (objMap.get(p) || { sha: p }).sha);

  // 与**第一父提交**的变更（-z 防中文路径转义，教训见 push-via-api.py；显式两点式对 merge 也成立）
  const raw = git('diff-tree', '--no-commit-id', '--name-status', '-z', '-r', parentsLine[1], c)
    .toString('utf8');
  const fields = raw.split('\0').filter(f => f !== '');
  const entries = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i][0];
    let path;
    if (status === 'R' || status === 'C') { i += 2; path = fields[i++]; } // status\0old\0new\0 → 取新路径
    else { path = fields[++i]; i += 1; }
    if (!path) continue;
    if (status === 'D') { entries.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
    const mode = gitStr('ls-tree', c, '--', path).split(/\s+/)[0] || '100644';
    const blob = gitBuf('show', `${c}:${path}`);
    const created = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: blob.toString('base64'), encoding: 'base64',
    });
    entries.push({ path, mode, type: 'blob', sha: created.sha });
  }

  // base_tree = 第一父提交的树；父提交若刚经 API 上传（远端 sha 本地不存在），用上传时记录的 tree sha
  const parentObj = objMap.get(parentsLine[1]);
  const baseTree = parentObj ? parentObj.tree : gitStr('rev-parse', `${parents[0]}^{tree}`);
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: baseTree, tree: entries });

  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: gitStr('log', '-1', '--format=%B', c),
    tree: tree.sha,
    parents,
    author: {
      name: gitStr('log', '-1', '--format=%an', c),
      email: gitStr('log', '-1', '--format=%ae', c),
      date: gitStr('log', '-1', '--format=%aI', c),
    },
  });
  objMap.set(c, { sha: commit.sha, tree: tree.sha });
  console.log(`  ${c.slice(0, 8)} → ${commit.sha.slice(0, 8)}  ${gitStr('log', '-1', '--format=%s', c).slice(0, 46)}`);
}

const finalSha = objMap.get(localTip)?.sha;
if (!finalSha) throw new Error('localTip 不在待上传列表里（rev-list 范围异常），拒绝动 ref');
console.log(`更新 ref ${BRANCH} → ${finalSha}`);
const updated = await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: finalSha, force: false });
console.log('完成，远端现指向:', updated.object.sha);
