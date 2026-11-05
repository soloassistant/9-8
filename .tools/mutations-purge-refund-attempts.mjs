// 变异用例：refund_attempts 清理策略（harness: .tools/verify-refund-attempts-purge.mjs）
// 每个 case 的 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '去掉 status 过滤（会把 pending 锁与 accepted 审计一起删掉）',
    file: 'cloudfunctions/purgeRefundAttempts/index.js',
    from: "  const cond = { status: 'failed', createTime: db.command.lt(cutoff) };",
    to: '  const cond = { createTime: db.command.lt(cutoff) };',
    cmd: 'node .tools/verify-refund-attempts-purge.mjs'
  }
];
