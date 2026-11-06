/**
 * mutations-question-bank.mjs —— 证明题库查询/判分/状态映射的断言有判别力。
 *
 * 每条都把「已修的正确写法」改回「静默失效的缺陷写法」，对应 test: 脚本必须由 PASS 变 FAIL。
 * 改不红 = 门禁是假绿的。逐条覆盖用户点名的三条：
 *   ① 筛选条件失效（返回全量）         → test-question-bank-query
 *   ② 读取失败被渲染成「题库 0 题」      → test-question-bank-query
 *   ③ 判分把错判成对                    → test-question-bank-grading
 */
export default [
  {
    label: '① 体系筛选失效：任何体系都返回全量',
    file: 'src/data/questionBankQuery.ts',
    from: "  if (filter.examSystem && q.examSystem !== filter.examSystem) return false;",
    to: '  // MUT: 体系筛选被跳过，返回全量',
    cmd: 'node .tools/test-question-bank-query.mjs'
  },
  {
    label: '② 读取失败降级成空题库（把「读不出来」渲染成「题库 0 题」）',
    file: 'src/data/questionBankQuery.ts',
    from: "    return { status: 'error', code, message };",
    to: "    return { status: 'ok', questions: [] };",
    cmd: 'node .tools/test-question-bank-query.mjs'
  },
  {
    label: '③ 判分把错判成对：单选永远返回 true',
    file: 'src/utils/questionBankGrading.ts',
    from: "      return typeof response === 'string' && typeof expected === 'string' && norm(response) !== '' && norm(response) === norm(expected);",
    to: '      return true;',
    cmd: 'node .tools/test-question-bank-grading.mjs'
  }
];
