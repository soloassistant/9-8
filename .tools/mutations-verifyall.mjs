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
    from: '/(?:FAIL|失败)\\s*[:：]?\\s*(\\d+)/',
    to: '/(?:FAIL)\\s*[:：]?\\s*(\\d+)/',
    cmd: 'node .tools/verify-all.mjs --self-test'
  }
];
