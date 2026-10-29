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
 * 用法:
 *   node .tools/verify-deploy-fresh.mjs [dist目录，默认 dist]   验仓库的构建产物
 *   node .tools/verify-deploy-fresh.mjs --publish               验**发布目录**（用户真正拿到的那份）
 *   node .tools/verify-deploy-fresh.mjs --prebuild              构建**前**闸：构建输入必须已入库
 *
 * ★ 2026-10-29 审计复检：加 `--publish` 模式。
 *   起因：上轮这个门禁只验仓库的 `dist/`，而**产品入口是 `D:\Agent\dist`**（手工
 *   `robocopy /MIR` + 面板发布），全仓没有任何门禁守着它 ⇒ 48 个门禁全绿，
 *   线上照样能跑着一个带缺陷的构建（实测：产物里两个 `id="app"` ⇒ 滚到底一整屏空白）。
 *   `--publish` 模式把同一套检查**指向发布目录**，并在 E 组加几条只在发布目录才成立的断言。
 *
 * ★ 2026-10-29 第二轮：加 `--prebuild` 模式 + A3 断言。
 *   起因：`build-stamp.json` 里的 `head` 记的是**构建那一刻的 HEAD**，不是产物对应的源码状态 ——
 *   工作区领先 HEAD 是常态（并行会话改完没提交就构建），于是产物里可能装着**从未进过版本库的代码**，
 *   而 stamp 看上去一切正常。产品入口又是手工复制 + 面板发布，没有任何东西会拦住它。
 *   现在的口径：
 *     · `--prebuild`：构建输入（src/ config/ package.json tsconfig.json yarn.lock）有未提交改动 ⇒ 拒绝构建
 *       （临时跳过：ALLOW_DIRTY_BUILD=1，但那样构建出的产物 dirty=true，发布预检会拦下）
 *     · A3：产物指纹里 `dirty` 必须是 false ——「由**已入库**的源码构建出来」
 *
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

// ── 模式三：构建前闸（不验产物，只验「能不能开始构建」）──────────────────
// 为什么不并进 A–E：它判的是**工作区**，与产物无关；且它必须在 taro build 之前跑，
// 一旦产物被构建流程清空就再也判不出「构建输入有没有入库」了。
if (process.argv.includes('--prebuild')) {
  const { workingTreeState } = require('./lib/build-inputs');
  const wt = workingTreeState(ROOT);
  const allowDirty = process.env.ALLOW_DIRTY_BUILD === '1';
  if (!wt.available) {
    console.log('构建前闸：取不到 git 状态（无法判断工作区是否干净）——放行，但请自行确认已提交。');
    process.exit(0);
  }
  if (!wt.dirty) {
    console.log(`构建前闸：构建输入全部已入库（${wt.treeDirtyCount ?? 0} 处非构建输入的改动不影响 bundle）——放行。`);
    process.exit(0);
  }
  const list = wt.files.map((l) => `    ${l}`).join('\n');
  if (allowDirty) {
    console.log(`构建前闸：工作区有未提交的构建输入改动（ALLOW_DIRTY_BUILD=1 已放行）：\n${list}`);
    console.log('⚠️ 这次构建出的产物会带 dirty=true，发布预检（A3）会拦住它上线。');
    process.exit(0);
  }
  console.error(`✗ 构建前闸：构建输入有未提交的改动，拒绝构建（产物会带着从未入库的代码上线）：\n${list}`);
  console.error('  先提交这些改动再构建；临时跳过请设 ALLOW_DIRTY_BUILD=1（那样产物不可发布）。');
  process.exit(1);
}

// 发布目录：平台按**目录**认 app（AGENTS.md §4），换目录 = 换 app = 换域名且登录必挂。
const PUBLISH_DIR_DEFAULT = 'D:\\Agent\\dist';
const isPublish = process.argv.includes('--publish');
const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
const DIST = isPublish
  ? path.resolve(process.env.PUBLISH_DIR || PUBLISH_DIR_DEFAULT)
  : path.resolve(ROOT, positional || 'dist');

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
  // A3 产物是不是由**已入库**的源码构建出来的
  //   A1 只保证「产物 == 当前工作区内容」；若工作区有未提交改动，产物里就装着从未进过
  //   版本库的代码（A1 照样绿）。这一条才把「已入库」钉住。
  //   旧产物没有 dirty 字段（= 判不了）⇒ 判红，要求重建。
  const dirtyState = stamp ? stamp.dirtyState : undefined;
  check(
    'A3 产物由已入库的源码构建（build-stamp.dirty 必须为 false）',
    !!stamp && stamp.dirty === false,
    stamp
      ? stamp.dirty === false
        ? `dirtyState=${dirtyState}`
        : stamp.dirty === true
          ? `构建时有未提交的构建输入改动：${(stamp.dirtyFiles || []).slice(0, 4).join(', ')}${(stamp.dirtyFiles || []).length > 4 ? ' …' : ''}`
          : `指纹里没有 dirty 字段（老产物，判不了）→ 先重建`
      : '(读不到 build-stamp.json)'
  );
} catch (e) {
  check('A1 产物由当前这批输入产出（逐文件比内容哈希）', false, String((e && e.message) || e));
  check('A3 产物由已入库的源码构建（build-stamp.dirty 必须为 false）', false, String((e && e.message) || e));
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

// —— E. 发布目录专属（--publish 模式）——
// 这一组存在的理由：上面 A–D 验的是**仓库 dist**，而用户拿到的是**发布目录**那份。
// 实测事故：产物里两个 `id="app"` ⇒ Taro 取第一个、真正的挂载点留在 body 当一屏高空壳
// ⇒ 页面可滚高度变 2 屏，**滚到底是一整屏纯空白**（2026-10-29 线上实测）。
if (isPublish) {
  const REPO_DIST = path.resolve(ROOT, 'dist');
  // E1 发布目录在位
  const pubExists = fs.existsSync(DIST) && fs.statSync(DIST).isDirectory();
  check('E1 发布目录存在（产品入口 = 面板按这个目录认 app）', pubExists, DIST);
  // E2 产物里 id="app" 恰好 1 次 —— 重复即「滚到底整屏空白」
  //    计数前必须剥 HTML 注释：骨架片段里的解释性注释本身写着 id="app"。
  const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const appIdCount = (stripComments(html).match(/id="app"/g) || []).length;
  check(
    'E2 发布产物里 id="app" 恰好出现 1 次（出现 2 次 = 滚到底是一整屏空白）',
    appIdCount === 1,
    `count=${appIdCount}`
  );
  // E3 发布目录与仓库 dist 是同一份产物（防「两代产物混放」）
  let mirrorOk = false;
  let mirrorDetail = '';
  try {
    const filesOf = (d) => {
      const out = [];
      const walk = (cur, pre) => {
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const p = `${cur}\\${e.name}`;
          const rel = pre ? `${pre}/${e.name}` : e.name;
          if (e.isDirectory()) walk(p, rel);
          else out.push(rel);
        }
      };
      walk(d, '');
      return out.sort();
    };
    const a = filesOf(DIST);
    const b = filesOf(REPO_DIST);
    const onlyPub = a.filter((f) => !b.includes(f));
    const onlyRepo = b.filter((f) => !a.includes(f));
    mirrorOk = onlyPub.length === 0 && onlyRepo.length === 0;
    mirrorDetail = mirrorOk
      ? `${a.length} 个文件一致`
      : `只在发布目录: ${onlyPub.slice(0, 5).join(', ')}；只在仓库 dist: ${onlyRepo.slice(0, 5).join(', ')}`;
  } catch (e) {
    mirrorDetail = String((e && e.message) || e);
  }
  check('E3 发布目录与仓库 dist 的文件清单一致（不是两代产物混放）', mirrorOk, mirrorDetail);
  // E4 热点数据新鲜度：烘焙快照会停在打包那一刻，太旧就别发
  const updatedAt = hot && hot.updatedAt ? Date.parse(hot.updatedAt) : NaN;
  const ageH = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 3600000 : NaN;
  check(
    'E4 发布产物的热点数据不算太旧（烘焙快照会停在打包那一刻）',
    Number.isFinite(ageH) && ageH < 24,
    Number.isFinite(ageH) ? `${ageH.toFixed(1)} 小时前（updatedAt=${hot.updatedAt}）` : 'updatedAt 缺失或不可解析'
  );
  // E5 发布目录里不能有上一代的 bundle（残留 = 用户可能加载到旧包）
  let staleBundles = [];
  try {
    const jsDir = path.join(DIST, 'js');
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const cur = [...html.matchAll(/js\/app\.([0-9a-f]+)\.js/g)].map((m) => m[1]);
    staleBundles = fs
      .readdirSync(jsDir)
      .filter((f) => /^app\.[0-9a-f]+\.js$/.test(f))
      .filter((f) => !cur.includes(f.match(/^app\.([0-9a-f]+)\.js$/)[1]));
  } catch {
    staleBundles = [];
  }
  check(
    'E5 发布目录里没有上一代的主包残留（残留 = 可能加载到旧包）',
    staleBundles.length === 0,
    staleBundles.join(', ')
  );
  // E6 两边的指纹必须指向同一次构建
  //   E3 只比**文件清单**，不比内容：清单一致但内容是两次不同构建的情况完全可能
  //   （例如先构建 → 改代码 → 只同步了部分文件）。指纹的 head/inputsHash 才是内容指纹。
  let sameBuild = false;
  let sameDetail = '';
  try {
    const { readStamp } = require('./lib/build-inputs');
    const pubStamp = readStamp(DIST);
    const repoStamp = readStamp(REPO_DIST);
    if (!pubStamp || !repoStamp) {
      sameDetail = '有一边读不到 build-stamp.json';
    } else if (pubStamp.inputsHash !== repoStamp.inputsHash) {
      sameDetail = `inputsHash 不一致（发布 ${String(pubStamp.inputsHash).slice(0, 12)}… vs 仓库 ${String(repoStamp.inputsHash).slice(0, 12)}…）`;
    } else {
      sameBuild = true;
      sameDetail = `inputsHash=${String(pubStamp.inputsHash).slice(0, 12)}… head=${String(pubStamp.head || 'n/a').slice(0, 7)}`;
    }
  } catch (e) {
    sameDetail = String((e && e.message) || e);
  }
  check('E6 发布目录与仓库 dist 来自同一次构建（两边指纹一致）', sameBuild, sameDetail);
}

console.log(`发布前预检（${path.basename(DIST)}${isPublish ? ' · 发布目录模式' : ''}）`);
for (const r of rows) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
}
console.log(`\n${fail === 0 ? `可以发布（${pass} 项全过）` : `有 ${fail} 项阻塞，先重建再发布`}`);
process.exit(fail === 0 ? 0 : 1);
