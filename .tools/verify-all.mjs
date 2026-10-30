// 一次跑完所有静态门禁，**成功时不刷屏**。
//
// 为什么需要它（实测数据，不是猜的）：
//   本会话实测每次请求平均背 185,105 token，其中
//     · 固定开销（系统提示词+工具定义） 45,101（24.4%）
//     · 工具输出重发                    131,419（71.0%）
//     · 真正推进任务的内容               8,584（ 4.6%）
//   ⇒ 「一轮能跑完的事分成 6 轮跑」和「每条门禁都打 119 行断言」都会被后续每一轮重发。
//     verify:contrast 全量输出约 9.5K 字符 ≈ 3.8K token，乘上后续轮数就是纯浪费。
//
// 设计取舍（三处刻意为之）：
//   1. **不手写脚本清单**。清单会腐烂：第一版写死 15 条，而 package.json 里当时有 40 个
//      verify:*，也就是说它自称「跑完所有静态门禁」却漏了 25 个 —— 一句谎话。
//      现在从 package.json 自动发现，只维护两张「例外表」。
//   2. **成功一行、失败全量**。失败时把完整输出打出来（这时细节才有用，
//      省字省到把失败信息也吞掉就是自欺）。
//   3. **退出码 0 但打印了 FAIL n(n>0) 必须算失败**。这是本会话反复踩到的假绿形态：
//      门禁自己算对了、打印了红，却忘了 let 它影响退出码。这条规则单独抽成 isBad()
//      并用 --self-test 真值表钉住（有变异用例守着，见 .tools/mutations-verifyall.mjs）。
//
// 用法：
//   node .tools/verify-all.mjs                   # 静默模式（默认），只跑静态门禁
//   node .tools/verify-all.mjs --verbose         # 成功也打全量输出（调试用）
//   node .tools/verify-all.mjs --with-browser    # 带上需要 Chrome 的门禁
//   node .tools/verify-all.mjs --mutation        # 带上变异测试（会临时改源码，排最后跑）
//   node .tools/verify-all.mjs --live            # 带上直连外网的门禁（结果天生不确定）
//   node .tools/verify-all.mjs --only=legal,docs # 只跑指定的几条
//   node .tools/verify-all.mjs --self-test       # 毫秒级自查判定规则真值表，不跑任何门禁
//
// 退出码：0 全通过；1 有失败 / 例外表腐烂 / 疑似空跑；2 --self-test 失败。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 一条门禁算不算失败。
 *
 * 只有两个入参，刻意保持纯函数：便于用 --self-test 钉真值表、便于变异测试打靶。
 *   code  —— 子进程退出码（-1 表示被信号杀死/超时）
 *   fails —— 输出里解析出的 FAIL 条数；解析不到传 null
 *
 * 为什么 `fails > 0` 也要算失败（而不只看退出码）：
 *   本会话实测出现过「断言打印 ✗、汇总行写 FAIL 1，但 process.exit 传了 0」的门禁变体。
 *   只信退出码的话，这种门禁会永久假绿 —— 它看起来在报错，CI 却一直过。
 */
export function isBad(code, fails) {
  if (code !== 0) return true;
  if (typeof fails === 'number' && fails > 0) return true;
  return false;
}

// ── 例外表：这几张表之外，所有 verify:* 都在默认列表里跑 ────────────────────
// 需要真 Chrome（起浏览器、慢、且 CI 里另开阶段跑）。
const BROWSER = new Map([
  ['verify:layout', 'cdp-probe 驱动真 Chrome 量布局'],
  ['verify:routes', 'cdp-probe 驱动真 Chrome 把 19 个路由 × 3 档视口全渲染一遍'],
  ['verify:visual', 'cdp-probe 驱动真 Chrome 跑视觉巡检'],
  ['verify:compress', 'cdp-probe 驱动真 Chrome 验头像压缩（canvas 位图，jsdom 测不了）'],
  ['verify:hotkeys-live', 'cdp-probe 驱动真 Chrome 在 dist 上按一遍快捷键（合成 keydown + 真实事件路径）'],
  ['verify:site-live', 'cdp-probe 驱动真 Chrome 量落地页的计算样式（CSS 级联覆盖只有渲染后才看得见）']
]);
// 会临时改写源码，必须排在所有只读门禁之后（否则后面的门禁验的是被变异过的代码）。
const MUTATING = new Map([['verify:mutation', '临时改写源码跑变异测试']]);
// 直连外网 —— 不是"代码有 bug"，是这类门禁**天生不确定**：对方一慢就红。
// 把它放进确定性套件里，红的含义就从「我改坏了东西」退化成「今天网络不好」，
// 门禁一旦开始"经常红但没事"，人们就会开始忽略红 —— 这比没有门禁更坏。
// 它仍然该跑，只是该在单独的「线上数据源体检」阶段跑：--with-live。
const EXTERNAL = new Map([
  ['verify:boards', '直连 9 个热榜源（微博/知乎/百度/抖音/B站/HelloGitHub/果壳/数字尾巴/豆瓣），单源 6s 超时']
]);
// 依赖「构建产物比源码新」的门禁：改完 src 还没重建时它**必然**红，
// 而红的含义是「产物过期」不是「代码坏了」。放进确定性套件会让每次改代码都先红一遍，
// 门禁一旦开始"经常红但没事"就会被人忽略。它该在发布前单独跑（见 verify:deploy-fresh 头注释）。
const ARTIFACT = new Map([
  ['verify:deploy-fresh', '依赖新鲜 dist 产物：改完 src 未重建时必然红，发布前单独跑'],
  // 2026-10-29 审计复检新增：验**发布目录**（D:\Agent\dist，产品入口 = 用户真正拿到的那份）。
  // 它同样是产物类：发布目录没同步时必然红，而红的含义是「该同步了」不是「代码坏了」。
  ['verify:publish-preflight', '依赖发布目录已同步（D:\\Agent\\dist）：未同步时必然红，发布前单独跑']
]);
// 自身（递归跑会无限循环）。
const SELF = new Set(['verify:all']);

// ── 第三类命名空间：**没有前缀**但确实是门禁的脚本 ────────────────────────
// `verify:*` / `audit:*` 两个前缀之外还有 `selfcheck`（27 条全量验收断言）。
// 它在 CI 里是**独立一步**（`node .tools/selfcheck.js`），但因为没有前缀，
// 一直不在 verify:all 的发现范围里 ⇒ 「本地全绿 / CI 红」的又一个实例：
// 开发者跑 `npm run verify:all` 全绿，CI 那一步照样可能红，而且没人知道差在哪。
// 这就是 2026-10-29 审计记下的那条元教训：**换个前缀命名 = 从某个门禁的视野里消失**。
const EXTRA_GATES = ['selfcheck'];

// 退出码 2 = 「无 FAIL 但有 SKIP」，不等于失败（selfcheck 的约定，与 CI 步骤里的处理一致）。
// 只对白名单里的门禁放行；其余门禁的退出码 2 一律算失败。
const SKIP_TOLERANT = new Set(['selfcheck']);

// 「已登记组」= 本地默认集合之外的分组，每组都带可核查的理由。
// parity 的新断言就靠它判断「CI 跑的某个门禁在本地属于哪一组」。
const LOCAL_GROUPS = new Map([
  ...BROWSER.entries(),
  ...MUTATING.entries(),
  ...EXTERNAL.entries(),
  ...ARTIFACT.entries(),
  ...[...SELF].map((k) => [k, '自身，递归跑会无限循环'])
]);

// ── 解析输出里的 PASS/FAIL 计数（仅用于那一行展示与上面的 isBad 附加约束）────
//
// ⚠️ `(\d+)\b` 里的 `\b` 不是装饰。真实事故（2026-10-24 首次整跑）：
//    verify:boards 输出 `HelloGitHub hellogithub  ✗ 失败 14016ms（2 次尝试均失败）`，
//    原来的 `(\d+)` 把**耗时 14016ms 当成失败条数 14016**，于是 fails=14016。
//    那次门禁本来就该红，所以没露馅；但同一个 bug 完全可以在一条绿灯门禁上
//    把耗时读成"一堆失败"，把绿判红 —— 判据的错不比代码的错轻。
//    `14016\b` 不成立（`6` 与 `m` 都是 \w，中间没有词边界），回溯到 `1401\b` 也不成立，
//    所以整条匹配不上。**不要改用 `(?!\s*ms)` 这类负向断言**：贪婪的 `\d+` 会回溯缩短
//    成 `1401` 从而绕过它（负向断言挡不住回溯，词边界挡得住）。
function parseCounts(out) {
  const failMatch = out.match(/(?:FAIL|失败)\s*[:：]?\s*(\d+)\b/);
  const passMatch = out.match(/(?:PASS|通过)\s*[:：]?\s*(\d+)\b/);
  return {
    fails: failMatch ? Number(failMatch[1]) : null,
    passN: passMatch ? Number(passMatch[1]) : null
  };
}

// ── CI 入口一致性：新加的门禁不许"写好了却没人跑" ──────────────────────────
//
// 为什么需要：2026-10-24 审计发现 `verify:contrast` 和 `verify:util` 都曾写好但没接 CI，
// 「没接 CI 就等于没写」。而 CI 里的步骤是**手写清单**，必然继续腐烂。
//
// 匹配口径刻意放宽到「脚本路径」而不只是 `npm run <name>`：
//   CI 里 `verify:intel` 是用冻结夹具直调 `node .tools/analyze-intel.js .tools/fixtures/...` 的，
//   只认 npm run 会把它误判成"没接"。判据宽一点换来零误报，但**不能宽到认不出来**：
//   只认「npm run <gate>」或「该 gate 脚本的真实路径」，不含通配、不做子串模糊。
const CI_EXEMPT = new Map([
  ['verify:all', '自身，CI 里没有递归跑的必要'],
  ['verify:layout', '需真 Chrome，CI 不跑浏览器门禁'],
  ['verify:routes', '同上（真 Chrome 全路由渲染巡检）'],
  ['verify:visual', '同上'],
  ['verify:compress', '同上（真 Chrome 验 canvas 压缩）'],
  ['verify:hotkeys-live', '同上（真 Chrome 在 dist 上按快捷键）'],
  ['verify:site-live', '同上（真 Chrome 量落地页计算样式）'],
  ['verify:boards', '需外网（9 个热榜源），CI 明确不跑'],
  // 2026-10-29 新增：读 dist 产物 + git 历史（指纹是否过期、入口引用是否齐全、SDK 是否被复制）。
  // checks 工作流**不构建产物**，所以它在这里既没法跑也不该跑；它的执行位置是发布前
  // （`npm run verify:deploy-fresh`，见该脚本头注释的 A/B/C/D 四查）。
  ['verify:deploy-fresh', '需 dist 产物，checks 不构建产物；发布前手动执行'],
  // 2026-10-29 审计复检新增：验发布目录（D:\Agent\dist）—— checks 跑在 CI 上，
  // 那里根本没有这个目录（它是本机 WorkBuddy 面板的发布目录），所以只能发布前本地跑。
  ['verify:publish-preflight', '需本机发布目录 D:\\Agent\\dist（面板按目录认 app），CI 上不存在；发布前本地执行']
]);

export function checkCiParity(ciText, scripts, exempt = CI_EXEMPT) {
  // ⚠️ 必须先剥掉 YAML 注释再匹配。checks.yml 顶部有一整段「**故意不放进这里**」的说明，
  //    里面写着 `npm run verify:boards 要联网…` —— 第一版没剥注释，于是这个从未接进 CI
  //    的门禁被判成"已接进"，而它的豁免条目反被判成失效。
  //    这与 verify-docs B3 被自己的解释性注释误杀是同一个坑：**判据不能把注释当事实**。
  const body = ciText
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  // ⚠️ 命名空间盲区（2026-10-29 审计）：只枚举 `verify:*` ⇒ `audit:*` 脚本整个不在视野里。
  //   真实后果：`audit:identity`（唯一能抓到「注销没删数据」的检测器）长期 exit=1，
  //   而 CI 一直绿 —— 因为 parity 只数 verify:*，没人要求它进 CI。
  //   三个命名空间都要算门禁，否则「换个前缀命名」就等于「从某个门禁的视野里消失」。
  const gates = Object.keys(scripts).filter(
    (k) => k.startsWith('verify:') || k.startsWith('audit:') || EXTRA_GATES.includes(k)
  );
  const referenced = new Set([...body.matchAll(/npm run ((?:verify|audit):[\w-]+)/g)].map((m) => m[1]));
  // 每个 gate 的脚本路径（取第一条 .tools/ 路径，够用且不受多脚本影响）
  const pathOf = (g) => (String(scripts[g] || '').match(/\.tools\/[\w./-]+\.(mjs|js|cjs)/) || [])[0] || null;
  const missing = gates.filter((g) => {
    if (exempt.has(g)) return false;
    if (referenced.has(g)) return false;
    const p = pathOf(g);
    return !(p && body.includes(p));
  });
  // 反向：CI 引用了 package.json 里不存在的 gate —— 步骤会直接失败，且说明有人删了脚本没删步骤
  const orphan = [...referenced].filter((g) => !gates.includes(g));
  // 豁免表腐烂：豁免了但 gate 已不存在 / 或其实已经接进 CI 了
  const stale = [...exempt.keys()].filter(
    (g) => !gates.includes(g) || referenced.has(g) || (pathOf(g) && body.includes(pathOf(g)))
  );
  // ★ 2026-10-29 新增（CI-only 脚本）：CI 里**直调** `.tools/xxx.mjs` 的步骤，
  //   必须能追溯到一个 package.json 入口 —— 否则这条门禁只在 CI 上跑，
  //   开发者本地永远碰不到它 ⇒ 又一个「本地全绿 / CI 红」的藏身处。
  //   口径只认 `.tools/` **下一层**的脚本：`.tools/fixtures/xxx.json` 是夹具不是脚本。
  const ciPaths = [...new Set([...body.matchAll(/\.tools\/[\w-]+\.(?:mjs|js|cjs)/g)].map((m) => m[0]))];
  const entryOf = (p) => Object.keys(scripts).find((k) => String(scripts[k] || '').includes(p)) || null;
  const ciOnly = ciPaths.filter((p) => !entryOf(p));
  return { gates, missing, orphan, stale, ciOnly };
}

// ── 自查：判定规则的真值表 ──────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  let extraCases = 0;
  const cases = [
    // [code, fails, 期望, 说明]
    [0, 0, false, '正常通过'],
    [0, null, false, '通过且解析不到计数'],
    [0, 3, true, '打印了 FAIL 3 却退出 0 —— 假绿，必须算失败'],
    [1, 0, true, '非零退出要算失败'],
    [1, null, true, '非零退出且无计数'],
    [-1, null, true, '被信号杀死 / 超时'],
    [0, -1, false, '负数不是合法条数，不能当成失败（防脏解析把绿判红）']
  ];
  let bad = 0;
  for (const [code, fails, want, desc] of cases) {
    const got = isBad(code, fails);
    const okc = got === want;
    if (!okc) bad++;
    console.log(`  ${okc ? '✓' : '✗'} isBad(${code}, ${fails}) = ${got}（期望 ${want}）—— ${desc}`);
  }
  const pc = [
    ['PASS 34 / FAIL 0', { passN: 34, fails: 0 }],
    ['PASS 6 / FAIL 1（共 7 条断言）', { passN: 6, fails: 1 }],
    ['没有任何计数', { passN: null, fails: null }],
    ['失败 2 通过 9', { passN: 9, fails: 2 }],
    // ↓ 这两条是 2026-10-24 首次整跑时**真实发生过**的误判（耗时被读成失败条数）
    ['HelloGitHub hellogithub  ✗ 失败 14016ms（2 次尝试均失败）— timeout of 6000ms exceeded', { passN: null, fails: null }],
    ['✗ hellogithub — timeout of 6000ms exceeded', { passN: null, fails: null }]
  ];
  for (const [input, want] of pc) {
    const got = parseCounts(input);
    const okc = got.passN === want.passN && got.fails === want.fails;
    if (!okc) bad++;
    console.log(`  ${okc ? '✓' : '✗'} parseCounts(${JSON.stringify(input)}) = ${JSON.stringify(got)}`);
  }
  // ── CI 一致性判据的真值表（喂合成输入，不读真文件）──────────────────────────
  // 没有这一组，「PARITY PASS」只说明当前仓库没缺口，说明不了判据抓得住缺口。
  const syn = {
    'verify:aa': 'node .tools/aa.mjs',
    'verify:bb': 'node .tools/bb.mjs',
    // 用真实的豁免名，才能测「豁免表失效」那条
    'verify:boards': 'node .tools/verify-boards.js'
  };
  const pq = [
    // [说明, CI 文本, 期望的 missing, 期望的 orphan, 期望的 stale]
    ['两条都接进 CI', '  - run: npm run verify:aa\n  - run: npm run verify:bb', [], [], []],
    ['bb 漏接', '  - run: npm run verify:aa', ['verify:bb'], [], []],
    // ↓ 核心：本仓库 checks.yml 顶部真的写着「npm run verify:boards 要联网」这句说明。
    //   判据若把注释当事实，就会把「故意不跑」读成「已经跑了」。
    ['bb 只在注释里被提到，不算接进', '# 故意不跑 npm run verify:bb\n  - run: npm run verify:aa', ['verify:bb'], [], []],
    ['用脚本路径直调（CI 里 verify:intel 就是这么跑的）', '  - run: node .tools/bb.mjs .tools/fixtures/x.json', ['verify:aa'], [], []],
    ['CI 引用了不存在的门禁', '  - run: npm run verify:zz', ['verify:aa', 'verify:bb'], ['verify:zz'], []],
    ['豁免了的门禁其实已接进 CI → 豁免表失效', '  - run: npm run verify:boards', ['verify:aa', 'verify:bb'], [], ['verify:boards']]
  ];
  for (const [desc, ci, wMissing, wOrphan, wStale] of pq) {
    // 用**合成豁免表**而不是模块级 CI_EXEMPT：后者登记的是真实门禁名，
    // 拿合成 scripts 去跑会把它们全判成「已删除」。判据要能脱离真实数据被测试。
    const r = checkCiParity(ci, syn, new Map([['verify:boards', '测试用']]));
    const okc =
      JSON.stringify(r.missing) === JSON.stringify(wMissing) &&
      JSON.stringify(r.orphan) === JSON.stringify(wOrphan) &&
      JSON.stringify(r.stale) === JSON.stringify(wStale);
    if (!okc) bad++;
    console.log(
      `  ${okc ? '✓' : '✗'} parity[${desc}] → missing=${JSON.stringify(r.missing)} orphan=${JSON.stringify(r.orphan)} stale=${JSON.stringify(r.stale)}`
    );
  }

  // ★ 2026-10-29 新增：命名空间盲区必须有判别力 —— `audit:` 前缀的脚本过去完全不在
  //   CI 视野里（`audit:identity` 红了很久而 CI 全绿）。这条自测锁住「audit:* 也算门禁」，
  //   免得以后有人把过滤条件改回只认 verify:*。
  {
    const r = checkCiParity('  - run: npm run verify:aa', { ...syn, 'audit:cc': 'node .tools/cc.mjs' },
      new Map([['verify:boards', '测试用']]));
    const okc = r.missing.includes('audit:cc');
    if (!okc) bad++;
    console.log(
      `  ${okc ? '✓' : '✗'} parity[audit: 前缀也算门禁，没接 CI 要判 missing] → missing=${JSON.stringify(r.missing)}`
    );
    extraCases++;
  }

  // ★ 2026-10-29 新增：第三类命名空间（无前缀但确实是门禁，如 `selfcheck`）。
  //   过去 verify:all 只认 verify:* / audit:*，于是 `selfcheck`（CI 里是独立一步）
  //   在本地默认集合里**完全不存在** ⇒ 本地全绿而 CI 红，且没人知道差在哪。
  {
    const r = checkCiParity('  - run: node .tools/selfcheck.js', { ...syn, selfcheck: 'node .tools/selfcheck.js' },
      new Map([['verify:boards', '测试用']]));
    const okc = r.gates.includes('selfcheck');
    if (!okc) bad++;
    console.log(
      `  ${okc ? '✓' : '✗'} parity[无前缀门禁（selfcheck）也要进门禁集合] → gates=${JSON.stringify(r.gates)}`
    );
    extraCases++;
  }

  // ★ 2026-10-29 新增：CI-only 脚本必须有本地入口（本地永远碰不到它 = 另一种藏身处）。
  //   这一条必须有判别力：直调一个 package.json 里没有入口的脚本，必须被判成 ciOnly。
  {
    const withEntry = checkCiParity('  - run: node .tools/aa.mjs', syn, new Map([['verify:boards', '测试用']]));
    const okOk = withEntry.ciOnly.length === 0;
    if (!okOk) bad++;
    console.log(`  ${okOk ? '✓' : '✗'} parity[CI 直调的脚本有本地入口 → 不算 ciOnly] → ciOnly=${JSON.stringify(withEntry.ciOnly)}`);
    const noEntry = checkCiParity('  - run: node .tools/orphan-gate.mjs', syn, new Map([['verify:boards', '测试用']]));
    const okBad = noEntry.ciOnly.includes('.tools/orphan-gate.mjs');
    if (!okBad) bad++;
    console.log(`  ${okBad ? '✓' : '✗'} parity[CI 直调本地无入口的脚本 → 判 ciOnly] → ciOnly=${JSON.stringify(noEntry.ciOnly)}`);
    // 夹具不是脚本，不能被当成 CI-only
    const fixture = checkCiParity('  - run: node .tools/aa.mjs .tools/fixtures/x.json', syn,
      new Map([['verify:boards', '测试用']]));
    const okFix = fixture.ciOnly.length === 0;
    if (!okFix) bad++;
    console.log(`  ${okFix ? '✓' : '✗'} parity[.tools/fixtures 下的夹具不算 CI-only 脚本] → ciOnly=${JSON.stringify(fixture.ciOnly)}`);
    extraCases += 3;
  }

  const totalCases = cases.length + pc.length + pq.length + extraCases;
  console.log(`\nSELF-TEST ${totalCases - bad}/${totalCases}`);
  process.exit(bad === 0 ? 0 : 2);
}
// ── 只查 CI 一致性（静态，不执行任何门禁；毫秒级，CI 里单独一步）──────────────
if (process.argv.includes('--parity')) {
  const pkgP = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const ciPath = path.join(ROOT, '.github/workflows/checks.yml');
  if (!fs.existsSync(ciPath)) {
    console.error('✗ 找不到 .github/workflows/checks.yml');
    process.exit(1);
  }
  const { gates, missing, orphan, stale, ciOnly } = checkCiParity(fs.readFileSync(ciPath, 'utf8'), pkgP.scripts || {});
  let bad = 0;
  if (missing.length) {
    bad++;
    console.log(`✗ ${missing.length} 个门禁既没接进 CI、也没登记豁免：`);
    for (const g of missing) console.log(`      · ${g} → ${pkgP.scripts[g]}`);
    console.log('    接进 checks.yml，或在 CI_EXEMPT 里给出可核查的理由。');
  } else {
    console.log(`  ✓ 全部 ${gates.length} 个门禁（verify:*/audit:*/无前缀）都有归属（接进 CI 或登记豁免）`);
  }
  if (orphan.length) {
    bad++;
    console.log(`✗ CI 引用了 package.json 里不存在的门禁：${orphan.join('、')}`);
  } else {
    console.log('  ✓ CI 里没有指向已删除门禁的残留步骤');
  }
  if (stale.length) {
    bad++;
    console.log(`✗ CI_EXEMPT 里有失效条目（门禁已删，或其实已接进 CI）：${stale.join('、')}`);
  } else {
    console.log('  ✓ CI_EXEMPT 没有失效条目');
  }
  // ★ 2026-10-29 新增：CI 直调的脚本必须在本地有入口。
  //   只在 CI 上跑的门禁 = 开发者永远看不到它红 ⇒ 「本地全绿 / CI 红」且无从查起。
  if (ciOnly.length) {
    bad++;
    console.log(`✗ CI 直调了 ${ciOnly.length} 个本地没有入口的脚本（只在 CI 上跑，开发者无法本地复现）：`);
    for (const p of ciOnly) console.log(`      · ${p}`);
    console.log('    在 package.json 里给它一个入口（如 verify:xxx），它就会被 verify:all 自动收录。');
  } else {
    console.log('  ✓ CI 里直调的脚本都有本地入口（能被 npm run verify:all 覆盖）');
  }
  // ★ 2026-10-29 新增：例外表腐烂检查搬进 parity。
  //   原来它只在 verify:all 的主流程里，而 **CI 只跑 verify:parity** ⇒
  //   门禁被删、例外表没清这件事，CI 永远抓不到（本地跑 verify:all 才看得到）。
  const staleTables = [...BROWSER.keys(), ...MUTATING.keys(), ...EXTERNAL.keys(), ...ARTIFACT.keys(), ...SELF]
    .filter((k) => !pkgP.scripts || !pkgP.scripts[k]);
  if (staleTables.length) {
    bad++;
    console.log(`✗ 例外表腐烂：以下门禁在 package.json 里已不存在 → ${staleTables.join('、')}`);
  } else {
    console.log('  ✓ 例外表（BROWSER/MUTATING/EXTERNAL/ARTIFACT/SELF）没有失效条目');
  }
  console.log(`\nPARITY ${bad === 0 ? 'PASS' : `FAIL ${bad}`}`);
  process.exit(bad === 0 ? 0 : 1);
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const VERBOSE = has('--verbose');
const WITH_BROWSER = has('--with-browser');
const WITH_MUTATION = has('--mutation');
const WITH_LIVE = has('--live');
const ONLY = (() => {
  const a = argv.find((x) => x.startsWith('--only='));
  return a ? a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean) : null;
})();

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
// 门禁集合：verify:*、audit:* 与**无前缀但确实是门禁**的脚本（EXTRA_GATES）都算。
// 命名空间盲区，2026-10-29 审计 —— audit: 前缀的脚本过去完全不在 CI 视野里，
// `audit:identity` 红了很久而 CI 一直绿；`selfcheck` 则是**没有前缀**的另一种盲区：
// 它在 CI 里是独立一步（node .tools/selfcheck.js），本地 `verify:all` 却完全看不见它。
const allVerify = Object.keys(scripts).filter(
  (k) => k.startsWith('verify:') || k.startsWith('audit:') || EXTRA_GATES.includes(k)
);

// 例外表腐烂检查：登记了、package.json 里却没有 → 表本身过期。
const exempted = [BROWSER, MUTATING, EXTERNAL, ARTIFACT];
const staleTables = exempted.flatMap((m) => [...m.keys()]).concat([...SELF]).filter((k) => !scripts[k]);

// --only 时**不预排除**特殊组（否则 --only=mutation 会因先排除后过滤而空跑 0 组、
// 还退出 0 假绿 —— 2026-10-24 实测踩到）；此时 WITH_* 追加也不再需要。
let list = ONLY
  ? [...allVerify]
  : allVerify.filter((k) => !BROWSER.has(k) && !MUTATING.has(k) && !EXTERNAL.has(k) && !ARTIFACT.has(k) && !SELF.has(k));
if (WITH_BROWSER) list = [...list, ...BROWSER.keys()];
if (WITH_MUTATION) list = [...list, ...MUTATING.keys()];
if (WITH_LIVE) list = [...list, ...EXTERNAL.keys()];
// --only 要能点名跑被跳过的类别（否则等于"点名了却跑不到"，静默空跑）
if (ONLY) list = [...list, ...ARTIFACT.keys()].filter((k) => ONLY.some((o) => k === `verify:${o}` || k === o));
if (ONLY && list.length === 0) {
  console.error(`--only 没匹配到任何门禁（${ONLY.join(', ')}），拒绝空跑假绿。可用名见 package.json 的 verify:*`);
  process.exit(2);
}
// 变异性门禁永远排最后：它会改源码，跑完必须让源码复原。
list.sort((a, b) => Number(MUTATING.has(a)) - Number(MUTATING.has(b)));

// ── 逐条执行 ────────────────────────────────────────────────────────────────
const results = [];
for (const name of list) {
  const cmd = scripts[name];
  const t0 = Date.now();
  const r = spawnSync(cmd, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    // 变异组单独放宽（2026-10-24 实测定标）：133 条变异 × 每条「变异→跑门禁→还原→复跑」
    // 实测约 4.3s/条（mutations-verifyall 3 条 12.9s 基线）≈ 5.7 分钟，硬 300s 会把
    // 最后一口气掐死在还原前 → 退出码 -1 看起来像变异逃逸。900s ≈ 实测 × 1.6。
    timeout: MUTATING.has(name) ? 900000 : 300000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' }
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // 变异组**不走 parseCounts**（2026-10-24 实测）：mutations-verifyall 的变异标签
  // 「parseCounts 只认英文 FAIL，解析不出中文『失败 2』」被回显进输出，parseCounts
  // 会把标签里的「失败 2」抠成 fails=2 → 好端端的 133/133 被判失败。
  // 变异运行器的退出码本身就是完整契约：0 ⇔ 全部 CAUGHT 且 restored_green。
  const { fails, passN } = MUTATING.has(name) ? { fails: null, passN: null } : parseCounts(out);
  const code = r.status === null ? -1 : r.status;
  // 疑似空跑：退出 0 但一个字都没输出 —— 通常意味着脚本提前 return 了。
  // 这是自动发现模式下的真实风险：一个什么都不做的门禁看起来和通过一模一样。
  const silent = code === 0 && out.trim() === '';
  // SKIP 容忍：白名单门禁的退出码 2 = 「无 FAIL 但有 SKIP」（selfcheck 的约定，
  // 与 CI 步骤里的处理一致）⇒ 算通过但要在摘要里说出来，不能悄悄咽掉。
  const skipOnly = code === 2 && SKIP_TOLERANT.has(name) && !(typeof fails === 'number' && fails > 0);
  results.push({
    name,
    code,
    passN,
    fails,
    out,
    ms: Date.now() - t0,
    silent,
    skipOnly,
    bad: skipOnly ? false : isBad(code, fails) || silent
  });
}

// ── 输出 ────────────────────────────────────────────────────────────────────
let badN = 0;
for (const r of results) {
  const tag = r.passN === null && r.fails === null ? '—' : `${r.passN ?? '?'}/${r.fails ?? '?'}`;
  if (!r.bad) {
    console.log(`  ✓ ${r.name.padEnd(26)} ${String(tag).padStart(9)}  ${(r.ms / 1000).toFixed(1)}s`);
    if (r.skipOnly) console.log('     ↑ 退出码 2 = 无 FAIL 但有 SKIP（受限环境跑不了），按通过计；SKIP 需人工确认原因');
    if (VERBOSE) console.log(r.out.trimEnd().split('\n').map((l) => '      ' + l).join('\n'));
  } else {
    badN++;
    const why = r.silent ? '疑似空跑：退出 0 且无任何输出' : `退出码 ${r.code}`;
    console.log(`\n  ✗ ${r.name} ${tag}（${why}，${(r.ms / 1000).toFixed(1)}s）`);
    if (r.fails !== null && r.fails > 0 && r.code === 0) {
      console.log('     ↑ 打印了 FAIL 却退出 0 —— 这本身就是假绿，isBad() 已按失败处理');
    }
    if (r.out.trim()) {
      console.log(r.out.trimEnd().split('\n').map((l) => '      ' + l).join('\n'));
    }
  }
}

const total = results.length;
const okN = total - badN;
const line = '─'.repeat(58);
console.log('\n' + line);
if (staleTables.length) {
  console.log(`✗ 例外表腐烂：以下条目在 package.json 里已不存在 → ${staleTables.join('、')}`);
}
console.log(
  badN === 0 && staleTables.length === 0
    ? `全部通过：${okN}/${total} 组门禁`
    : `有 ${badN} 组失败（${okN}/${total} 通过）`
);
const skippedBrowser = WITH_BROWSER ? [] : [...BROWSER.keys()];
const skippedMutation = WITH_MUTATION ? [] : [...MUTATING.keys()];
const skippedLive = WITH_LIVE ? [] : [...EXTERNAL.keys()];
if (skippedBrowser.length) console.log(`未跑（需 Chrome，--with-browser 可带上）：${skippedBrowser.join('、')}`);
if (skippedMutation.length) console.log(`未跑（会改源码，--mutation 可带上）：${skippedMutation.join('、')}`);
if (skippedLive.length) {
  for (const [k, why] of EXTERNAL) if (!WITH_LIVE) console.log(`未跑（需外网，--live 可带上）：${k} —— ${why}`);
}
// 产物类门禁也必须在"未跑"里显式出现，否则会从摘要里静默消失（等于假装跑过）
for (const [k, why] of ARTIFACT) console.log(`未跑（需新鲜产物，--only=${k.replace('verify:', '')} 可单独跑）：${k} —— ${why}`);
const covered = allVerify.filter((k) => !SELF.has(k)).length;
console.log(`入口普查：package.json 里 ${allVerify.length} 个门禁入口（verify:*/audit:*/无前缀，本次覆盖 ${covered} 个，自身 1 个）`);
console.log(line);

process.exit(badN === 0 && staleTables.length === 0 ? 0 : 1);
