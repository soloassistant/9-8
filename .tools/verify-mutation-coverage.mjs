// 门禁自身的「变异覆盖」审计。
//
// 为什么需要它：
//   2026-10-23/24 这两轮里，我写坏判据的次数比写坏代码的次数多 —— 四次同类错误
//   （indexOf 命中超串 / \b 在 - 前也成立 / '.x' 拼成 '../x' / 按整个文件判 openid）
//   全部发生在**我自己的检查器**里，而且当场都是"PASS"，是后来的变异测试才把它们揪出来。
//   结论：一条断言如果从来没有**变红过**，它等于没写。变异测试就是判据判别力的唯一证据。
//
// 所以这个门禁不检查产品，只检查「上面那 40 多个 verify 脚本，有哪些从没被变异碰过」。
//   · 被某个 mutations-*.mjs 的 cmd 指向 → COVERED
//   · 依赖 Chrome / dev server，变异框架无法离线驱动 → BROWSER（必须真实含浏览器依赖，否则算假豁免）
//   · 纯静态但暂时没配变异 → DEBT（登记在册，且**数量不许增长**）
//
// 新增一个 verify 脚本时：要么给它配一条变异，要么明确登记成 BROWSER/DEBT。漏登记就红。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// ⚠️ 不能用 new URL(import.meta.url).pathname：仓库路径含中文，得到的是 %E6%99%A8%E6%8A%A5
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(ROOT, '.tools');

let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond === true) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${detail ? ' → ' + detail : ''}`); }
};

// ── 结构性豁免：需要浏览器/静态服务器，变异框架（只改源码 + 跑 node 脚本）无法驱动 ──
const BROWSER = new Map([
  ['verify-layout.mjs', 'cdp-probe 驱动真 Chrome 量布局'],
  ['verify-layout-pages.mjs', '同上，逐页量'],
  ['verify-visual-patrol.mjs', '起 http.server + CDP 抽色/截图'],
  ['verify-compress.mjs', '起本地静态服务 + cdp-probe 驱动真 Chrome 验 canvas 压缩（剪贴板/位图 API 变异框架驱动不了）'],
  ['verify-hotkeys-live.mjs', 'cdp-probe 驱动真 Chrome 在 dist 上 dispatch 合成 keydown（KeyboardEvent 在 Node 里造不出来）'],
  ['verify-inbox-extract.mjs', 'CDP 进内页做提取'],
  ['verify-search-back.mjs', 'CDP 测返回栈'],
  ['verify-ledger-briefing.mjs', 'CDP 渲染后断言'],
  ['verify-ledger-page.mjs', 'CDP 渲染后断言'],
  ['verify-login-consent.mjs', 'CDP 走同意弹窗'],
  ['verify-remember-login.mjs', 'CDP 走登录开关'],
]);

// ── 承认的缺口：纯静态、可变异，但还没配。**上限锁死**，只许减不许增 ──
// （verify-interaction-fixes 已于 2026-10-25 配齐 mutations-interaction.mjs，从缺口表移出）
const DEBT_CAP = 14;
const DEBT = new Map([
  ['verify-prelaunch-fixes.js', '上线前清单，43 条静态断言，一条变异都没有'],
  ['verify-trust-wiring.js', '22 条静态断言'],
  ['verify-todo-status.js', '19 条静态断言'],
  ['verify-auth-wiring.js', '静态接线断言'],
  ['verify-boards.js', '静态'],
  ['verify-cloudllm-timeout.mjs', '静态'],
  ['verify-external-link.js', '静态'],
  ['verify-extract-coerce.mjs', '静态'],
  ['verify-ledger-aggregate.mjs', '静态'],
  ['verify-login-bind-gate.mjs', '静态'],
  ['verify-sources.js', '静态'],
  ['verify-summary-quality.js', '静态'],
  ['verify-sxm-decision.mjs', '静态'],
]);

const BROWSER_SIG = /cdp-probe|chrome|http\.server|puppeteer|playwright|--remote-debugging/i;

console.log('\n── A. 变异文件本身是否合规 ──');

const mutFiles = fs.readdirSync(TOOLS).filter((f) => /^mutations-.*\.mjs$/.test(f)).sort();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const mutCmd = pkg.scripts?.['verify:mutation'] || '';

const allCases = [];
const badCmd = [];
const badShape = [];
for (const f of mutFiles) {
  const mod = await import(pathToFileURL(path.join(TOOLS, f)).href);
  const cases = mod.default;
  if (!Array.isArray(cases) || cases.length === 0) continue;
  for (const c of cases) {
    allCases.push({ file: f, ...c });
    // ⚠️ to 允许是**空串**（表示删掉这一行），不能按 truthy 判。
    //    第一版写成 `!c.to` → 9 条合法的「删除型变异」被判成字段缺失，
    //    和 R 组那批「判据写松」是同一类错：拿 truthy 当"存在"。
    const shapeOk =
      typeof c.label === 'string' && c.label.length > 0 &&
      typeof c.from === 'string' && c.from.length > 0 &&
      typeof c.to === 'string' &&
      typeof c.cmd === 'string' && c.cmd.length > 0 &&
      c.from !== c.to;
    if (!shapeOk) badShape.push(`${f}: ${c.label || '(无 label)'}`);
    const target = (String(c.cmd || '').match(/\.tools\/[\w.-]+\.(mjs|js)/) || [])[0];
    if (!target || !fs.existsSync(path.join(ROOT, target))) badCmd.push(`${f}: ${c.label} → ${c.cmd}`);
  }
}

ok(badShape.length === 0, `A1 每条变异都有 label/from/to/cmd 且 from !== to（${allCases.length} 条）`, badShape.join('; '));
ok(badCmd.length === 0, 'A2 每条变异的 cmd 都指向真实存在的 harness', badCmd.join('; '));

const notInMutCmd = mutFiles.filter((f) => !mutCmd.includes(f));
ok(notInMutCmd.length === 0, 'A3 每个 mutations-*.mjs 都被 package.json 的 verify:mutation 引用', notInMutCmd.join(', '));

// 覆盖表：harness 文件名 → 指向它的变异条数
const cover = new Map();
for (const c of allCases) {
  const target = (String(c.cmd || '').match(/\.tools\/([\w.-]+\.(mjs|js))/ ) || [])[1];
  if (target) cover.set(target, (cover.get(target) || 0) + 1);
}

console.log('\n── B. 每个 verify 脚本要么被变异覆盖，要么登记豁免 ──');

const verifyFiles = fs.readdirSync(TOOLS)
  .filter((f) => /^verify-.*\.(mjs|js)$/.test(f))
  // 检查器自己不算被检查对象（它没法检查自己是不是有判别力）
  .filter((f) => f !== 'verify-mutation-coverage.mjs')
  .sort();
const unregistered = [];
const fakeBrowser = [];
const staleEntry = [];
let nBrowser = 0, nDebt = 0, nCovered = 0;

for (const f of verifyFiles) {
  const n = cover.get(f) || 0;
  const isB = BROWSER.has(f);
  const isD = DEBT.has(f);
  const src = fs.readFileSync(path.join(TOOLS, f), 'utf8');

  if (n > 0) { nCovered++; continue; }
  if (isB) {
    nBrowser++;
    if (!BROWSER_SIG.test(src)) fakeBrowser.push(f);
    continue;
  }
  if (isD) { nDebt++; continue; }
  unregistered.push(f);
}

ok(unregistered.length === 0, `B1 没有「零变异且未登记」的门禁脚本（共 ${verifyFiles.length} 个）`, unregistered.join(', '));
ok(fakeBrowser.length === 0, 'B2 BROWSER 豁免必须真的含浏览器依赖（防假豁免）', fakeBrowser.join(', '));

console.log('\n── C. 豁免表不许腐烂 ──');

for (const k of [...BROWSER.keys(), ...DEBT.keys()]) {
  if (!verifyFiles.includes(k)) staleEntry.push(`${k}（文件已不存在）`);
  else if ((cover.get(k) || 0) > 0) staleEntry.push(`${k}（已被变异覆盖，应从豁免表移出）`);
}
ok(staleEntry.length === 0, 'C1 豁免表里没有「已删除」或「已被覆盖」的残留条目', staleEntry.join('; '));

ok(
  nDebt <= DEBT_CAP,
  `C2 债务上限：零变异纯静态门禁 ${nDebt} 个 ≤ ${DEBT_CAP}（新增必须先补变异）`,
  `超了 ${nDebt - DEBT_CAP} 个`
);

console.log('\n── D. 覆盖概况 ──');
console.log(`  被变异覆盖 ${nCovered} 个 / 浏览器类 ${nBrowser} 个 / 承认缺口 ${nDebt} 个 / 合计 ${verifyFiles.length} 个`);
console.log(`  变异用例 ${allCases.length} 条，分布在 ${mutFiles.length} 个文件里`);

console.log('\n' + '─'.repeat(58));
console.log(`PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
console.log('─'.repeat(58) + '\n');
process.exit(fail > 0 ? 1 : 0);
