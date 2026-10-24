// 变异用例：verify-all 的判定规则（harness: .tools/verify-all.mjs --self-test）
//
// 为什么靶是 isBad()：它是「一次跑 34 条门禁」这个入口的唯一裁决点。
// 它只要错一点，34 条门禁的输出就全是装饰 —— 绿的会变绿，红的也能变绿。
//
// 这三条对应三种真实形态的假绿（本会话都出现过）：
//   ① 只信退出码，不管输出里写的 FAIL ——「打印了 ✗ 却 exit 0」永久通过；
//   ② 把非零退出码写成 `> 1`（认为 1 是"正常失败"之类），退出码 1 被放过；
//   ③ 只认英文 FAIL，中文「失败 2」解析不出来 → 计数恒为 null → 附加约束失效。
//
// 注意：`cmd` 用 --self-test（毫秒级），不用整跑。
// 整跑一次 2 分钟 × (基线 + 每条变异 + 恢复复跑) 会把这组变异拖到 8 分钟以上，
// 而且整跑的输出里夹着别的门禁的红，会掩盖"到底是哪条变了"。
export default [
  {
    // 行为后果：门禁打印 `PASS 6 / FAIL 1` 却忘了让退出码非零时，CI 仍然绿灯。
    // 哪条变红：self-test 里 `isBad(0, 3)` 期望 true。
    label: 'isBad 只认退出码，不再把「打印了 FAIL 却 exit 0」算失败',
    file: '.tools/verify-all.mjs',
    from: "  if (typeof fails === 'number' && fails > 0) return true;",
    to: "  if (typeof fails === 'number' && fails > 99) return true;",
    cmd: 'node .tools/verify-all.mjs --self-test'
  },
  {
    // 行为后果：退出码 1 是绝大多数门禁失败时的取值；放过它等于放过全部失败。
    // 哪条变红：self-test 里 `isBad(1, null)` 与 `isBad(1, 0)` 期望 true。
    label: 'isBad 把非零退出码收窄成 code > 1（退出码 1 被当成通过）',
    file: '.tools/verify-all.mjs',
    from: '  if (code !== 0) return true;',
    to: '  if (code > 1) return true;',
    cmd: 'node .tools/verify-all.mjs --self-test'
  },
  {
    // 行为后果：中文输出的门禁（verify-legal 等混用中英）计数解析不出来，
    //          fails 恒为 null，上面那条附加约束即失效。
    // 哪条变红：self-test 里 `parseCounts("失败 2 通过 9")` 期望 fails=2。
    label: 'parseCounts 只认英文 FAIL，解析不出中文「失败 2」',
    file: '.tools/verify-all.mjs',
    from: '/(?:FAIL|失败)\\s*[:：]?\\s*(\\d+)\\b/',
    to: '/(?:FAIL)\\s*[:：]?\\s*(\\d+)\\b/',
    cmd: 'node .tools/verify-all.mjs --self-test'
  },
  {
    // 行为后果：checks.yml 顶部那一段「**故意不放进这里**」的说明里就写着
    //          `npm run verify:boards 要联网`。不剥注释 → 「故意不跑」被读成「已经在跑」，
    //          于是这个门禁从没进过 CI 却永远查不出来。
    // 哪条变红：self-test「bb 只在注释里被提到，不算接进」期望 missing 含 verify:bb。
    label: 'CI 一致性不剥 YAML 注释（注释里的命令被当成真的在跑）',
    file: '.tools/verify-all.mjs',
    from: '    .filter((l) => !/^\\s*#/.test(l))',
    to: '    .filter(() => true)',
    cmd: 'node .tools/verify-all.mjs --self-test'
  },
  {
    // 行为后果：CI 里 verify:intel 是用冻结夹具直调 `node .tools/analyze-intel.js` 的。
    //          只认 gate 名 → 它被判成"没接进 CI"，让人以为要重复加一步。
    // 哪条变红：self-test「用脚本路径直调」期望 missing 不含 verify:bb。
    label: 'CI 一致性只认 npm run 名、不认脚本路径直调',
    file: '.tools/verify-all.mjs',
    from: '    return !(p && body.includes(p));',
    to: '    return !(p && body.includes(g));',
    cmd: 'node .tools/verify-all.mjs --self-test'
  },
  {
    // 行为后果：豁免表里躺着已经接进 CI 的条目，会掩盖"这个门禁其实有人跑过了"，
    //          也会让真正被豁免的那几个混在噪声里（= 豁免表开始腐烂而无人知）。
    // 哪条变红：self-test「豁免了的门禁其实已接进 CI」期望 stale 含 verify:boards。
    label: 'CI 豁免表不再检查「其实已接进 CI」',
    file: '.tools/verify-all.mjs',
    from: '    (g) => !gates.includes(g) || referenced.has(g) || (pathOf(g) && body.includes(pathOf(g)))',
    to: '    (g) => !gates.includes(g) || (pathOf(g) && body.includes(pathOf(g)))',
    cmd: 'node .tools/verify-all.mjs --self-test'
  }
];
