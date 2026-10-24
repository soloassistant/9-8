// 文档门禁：检查 AGENTS.md / MEMORY.md 里写的事**在仓库里还成立**。
//
// 为什么需要它（这不是假想问题，是 2026-10-24 一次实测）：
//   两份文档里有 7 处与仓库现状不符，其中 3 处是**两份文档互相矛盾**：
//     · AGENTS 写项目根 `D:\Agent`，MEMORY 写 `D:/Agent/晨报`（后者才对）
//     · MEMORY 写「H5 线上 = GitHub Pages」，AGENTS 写「gh-pages 云端全废、不是产品入口」
//     · MEMORY 写「H5 是 mock 数据」，而 H5 早已接 WorkBuddy 云库
//   还有：云函数写 24 个（实际 25）、变异写「10/10 CAUGHT」（实际 116 条）、
//   产物指纹 `app.a8cbdfbb.js / 1,864,973 B`（早就换成别的名字）、
//   `.tools` 写「新增需 git add -f」（实际白名单已放行）。
//
// 腐烂是必然的 —— 文档是手写的，仓库是自动变化的。所以只有门禁能防：
//   A 组 引用真实性：文档提到的每个脚本 / npm script 必须现查真在
//   B 组 已知错误口径回归：踩过的错话不许再出现（每条对应一次真实事故）
//   C 组 数量一致性：文档若写了"N 个函数"，必须等于 `ls cloudfunctions/*/` 的实际数
//
// 断言规约同其它 harness：失败分支返回原因字符串，成功严格判 ok === true。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond === true) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${detail ? ' → ' + detail : ''}`); }
};

const DOCS = ['AGENTS.md', 'MEMORY.md'].filter((f) => fs.existsSync(path.join(ROOT, f)));
const text = Object.fromEntries(DOCS.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
const all = DOCS.map((f) => text[f]).join('\n');

// 产物目录 / 临时目录 / 依赖：不在「必须存在」的范围（构建后才有，或随时被清）
const SKIP_PREFIX = /^(dist\/|dist-|node_modules\/|\.tmp-|\.workbuddy\/|归档\/)|^<|^\.\.\.$/;

/** 展开 `a/*.mjs` 这类通配，返回命中的真实文件（用于判断"至少有一个"）。 */
function globExist(rel) {
  if (!rel.includes('*')) return fs.existsSync(path.join(ROOT, rel));
  const dir = path.dirname(rel);
  const base = path.basename(rel);
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  if (!fs.existsSync(path.join(ROOT, dir))) return false;
  return fs.readdirSync(path.join(ROOT, dir)).some((f) => re.test(f));
}

console.log('\n── A. 文档里提到的文件 / 命令必须真的存在 ──');

// A1：只看**带明确根前缀的完整相对路径**。
//     ⚠️ 第一版判据写宽了：把裸文件名（`app.scss`）、举例（`js/app.X.js`）、
//     反例（`deploy-gh-pages.ps1` 文档里明说"从来不存在"）、产物（`api/hotspot.json`）
//     全当成"必须存在"→ 一次误报 16 条。判据宽 = 噪声多 = 没人看的门禁。
const pathTokens = new Set();
for (const m of all.matchAll(/`([^`\n]+)`/g)) {
  const first = m[1].trim().split(/\s+/)[0].replace(/[,;:)]+$/, '');
  if (!/^(\.tools|\.github|docs|src|cloudfunctions|config)\/[\w./-]+\.(js|mjs|cjs|ts|tsx|json|md|scss|yml|yaml)$/.test(first)) continue;
  if (/[X*]/.test(path.basename(first))) continue;   // 占位/通配示例
  pathTokens.add(first);
}
const missingPaths = [...pathTokens].filter((p) => !globExist(p));
ok(
  missingPaths.length === 0,
  `A1 文档引用的仓库路径全部存在（检查 ${pathTokens.size} 个带根前缀的完整路径）`,
  missingPaths.join(', ')
);

// A2：`npm run xxx` 必须在 package.json
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const npmRefs = new Set([...all.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
const missingScripts = [...npmRefs].filter((s) => !scripts[s]);
ok(
  missingScripts.length === 0,
  `A2 文档提到的 npm script 全部存在（检查 ${npmRefs.size} 个）`,
  missingScripts.join(', ')
);

// A3：`node .tools/xxx` 直接调用的脚本
const nodeRefs = new Set([...all.matchAll(/node (\.tools\/[\w.-]+\.(?:js|mjs|cjs))/g)].map((m) => m[1]));
const missingNode = [...nodeRefs].filter((p) => !fs.existsSync(path.join(ROOT, p)));
ok(missingNode.length === 0, `A3 文档里 node 直调的脚本全部存在（检查 ${nodeRefs.size} 个）`, missingNode.join(', '));

console.log('\n── B. 已知错误口径不许回归（每条对应一次真实事故）──');

// B1：项目根必须**等于**实际仓库根。
//     ⚠️ 原写法是反向禁词（"不许出现裸 `D:\Agent`"）—— 那既挡不住别的写法，也测不出漏。
//     改成正向断言：把文档里声明的值取出来，和 `git rev-parse --show-toplevel` 比。
let realRoot = '';
try {
  realRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch { /* 非 git 环境跳过 */ }
if (realRoot) {
  const claim = all.match(/项目根\*\*：`([^`]+)`/);
  const claimed = claim ? claim[1] : '';
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  ok(
    claim !== null && norm(claimed) === norm(realRoot),
    `B1 文档声明的项目根 = 实际仓库根（文档写 \`${claimed}\`，实际 \`${realRoot}\`）`,
    claim ? '' : '文档里找不到「项目根：`…`」声明'
  );
}

// B2：不许再声称 H5 线上是 gh-pages（2026-10-23 已实测云端能力在 gh-pages 全废）
ok(
  !/H5 线上\s*=\s*GitHub Pages|H5 线上：https:\/\/soloassistant\.github\.io/.test(all),
  'B2 没有把 gh-pages 写成 H5 产品入口（它只是静态镜像）',
  'MEMORY.md 旧版曾这么写'
);

// B3：不许再说 H5 是 mock 数据
//     ⚠️ 必须排除**解释性引用**：修完这条时我在文档里写了「旧版写"H5 是 mock 数据"，已过期」，
//     第一版判据直接匹配到这句自己 → 把自己判死。这与「用 includes('navigateTo') 判"不再用
//     navigateTo"会被自己的注释误杀」是同一类错。判据要带上否定语境。
const NEGATED_BEFORE = /旧版|已过期|曾这么写|曾写|原来|历史|不要写|别写/;
function saysWrong(text, phrase) {
  for (const m of text.matchAll(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!NEGATED_BEFORE.test(before)) return true;
  }
  return false;
}
ok(
  !saysWrong(all, 'H5 是 mock 数据'),
  'B3 没有声称「H5 是 mock 数据」（H5 已接 WorkBuddy 云库；解释性引用已排除）',
  'MEMORY.md 旧版曾这么写'
);

// B4：产物指纹不许写死（bundle 名每次构建都变）
ok(
  !/app\.[0-9a-f]{8}\.js`（[\d,]+ B/.test(all),
  'B4 没有把「bundle 名 + 字节数」写死进文档（必然腐烂，改成命令现查）',
  'AGENTS.md 旧版曾写 app.a8cbdfbb.js（1,864,973 B）'
);

// B5：`.tools` 新增脚本不需要 -f（白名单已放行）
ok(
  !/新增文件需 `git add -f`/.test(all),
  'B5 没有声称「.tools 新增文件需 git add -f」（白名单已放行，只有新建子目录才要补白名单）'
);

console.log('\n── C. 文档里的数字必须等于现查结果 ──');

const realFnCount = fs.readdirSync(path.join(ROOT, 'cloudfunctions'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).length;
const fnClaim = all.match(/`cloudfunctions\/` 下 (\d+) 个函数/);
ok(
  fnClaim === null || Number(fnClaim[1]) === realFnCount,
  `C1 文档若声明云函数个数，必须等于实际值（实际 ${realFnCount}）`,
  fnClaim ? `文档写 ${fnClaim[1]} 个` : ''
);

const realMutFiles = fs.readdirSync(path.join(ROOT, '.tools')).filter((f) => /^mutations-.*\.mjs$/.test(f)).length;
// ⚠️ 这里原本写了 `mutClaim === null || true` —— 永远为真的断言就是假绿，删掉。
//     改成"变异资产必须存在且被 verify:mutation 收录"，这才是真判据。
const mutCmd = scripts['verify:mutation'] || '';
const mutFilesOnDisk = fs.readdirSync(path.join(ROOT, '.tools')).filter((f) => /^mutations-.*\.mjs$/.test(f));
const mutNotWired = mutFilesOnDisk.filter((f) => !mutCmd.includes(f));
ok(
  mutFilesOnDisk.length > 0 && mutNotWired.length === 0,
  `C2 变异资产存在且全部接进 verify:mutation（${realMutFiles} 个文件）`,
  mutNotWired.join(', ')
);

console.log('\n── D. 两份文档的硬事实不许互相矛盾 ──');
// D1：H5 数据链路（一问只能有一个答案）
const agentSaysCloud = /H5 走 WorkBuddy 云库|H5 的数据链路是真实的/.test(text['AGENTS.md'] || '') || /H5 走 WorkBuddy 云/.test(text['MEMORY.md'] || '');
ok(agentSaysCloud === true, 'D1 两份文档对「H5 走什么数据链路」口径一致（真实云库，非 mock）');

// D2：§4 是 gh-pages 口径的单一事实来源，那段结论句不许被删（删了两份文档就都没答案了）
ok(
  /gh-pages 现在只适合当\*\*静态外壳 \+ 热点数据镜像\*\*，不是产品入口/.test(text['AGENTS.md'] || ''),
  'D2 AGENTS.md §4 仍保有「gh-pages 不是产品入口」的结论句（单一事实来源）'
);

console.log('\n' + '─'.repeat(58));
console.log(`PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
console.log('─'.repeat(58) + '\n');
process.exit(fail > 0 ? 1 : 0);
