/**
 * git 可执行文件解析（`.tools/` 下所有脚本共用）。
 *
 * 为什么需要：这些脚本原先一律 `spawnSync('git', ...)` 裸调。**在 PATH 里没有 git 的机器上，
 * spawn 直接 ENOENT**，而调用点只读 `stderr || stdout`（两者都是空串）→ 报出
 * `git status 失败: null`。实测症状：`verify:mutation` 的 23/24 个用例**全部变成 ERROR**，
 * 报错信息却一个字都没提到 git —— 看上去像"门禁本身坏了"，于是没人跑它。
 *
 * 本机就是这种机器：git 在 `~/.local/bin/mingit/cmd/`，不在 PATH。
 * 所以这里按「环境变量 → PATH → 常见安装位置」依次探测，探测不到时给出**点名失败原因**的
 * 错误，而不是让上层印 null。
 *
 * 为什么不 `throw`：三个调用点对"没 git"的处置不一样（变异/部署应当中止并报错，
 * 构建指纹只是少一个 head 字段）。所以只提供 `resolveGit()`（返回 null 或路径），
 * 由调用方决定怎么办。`describeGitCandidates()` 供报错文案复用。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

/** 候选列表（按优先级）。GIT_BIN 最高，便于在非常规环境一句话覆盖。 */
function gitCandidates() {
  const list = [];
  if (process.env.GIT_BIN) list.push(process.env.GIT_BIN);
  list.push('git'); // PATH
  if (process.platform === 'win32') {
    list.push(
      'C:/Program Files/Git/cmd/git.exe',
      'C:/Program Files (x86)/Git/cmd/git.exe',
      path.join(os.homedir(), '.local', 'bin', 'mingit', 'cmd', 'git.exe'),
      path.join(os.homedir(), 'scoop', 'shims', 'git.exe')
    );
  } else {
    list.push('/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git');
  }
  return list;
}

let cached;
/** 返回可用的 git 路径；一个都不可用返回 null。结果缓存（探测要 spawn，别每用例一次）。 */
function resolveGit() {
  if (cached !== undefined) return cached;
  for (const bin of gitCandidates()) {
    if (!bin) continue;
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) {
      cached = bin;
      return bin;
    }
  }
  cached = null;
  return null;
}

/** 给报错文案用的候选清单（已探测过的也列出来，方便用户直接看到该装/该配哪个） */
function describeGitCandidates() {
  return gitCandidates().filter(Boolean).join(' / ');
}

module.exports = { resolveGit, describeGitCandidates, gitCandidates };
