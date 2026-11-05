// 变异用例：权益回滚对账（harness: .tools/verify-entitlement-rollbacks.mjs）
// 每个 from 都必须在目标文件里**正好出现一次**。
export default [
  {
    label: '去掉失败重试计数（永远到不了 manual_required）',
    file: 'cloudfunctions/reconcileEntitlementRollbacks/index.js',
    from: '  const attempts = (Number(order.entitlementRollbackAttempts) || 0) + 1;',
    to: '  const attempts = (Number(order.entitlementRollbackAttempts) || 0) + 0;',
    cmd: 'node .tools/verify-entitlement-rollbacks.mjs'
  },
  {
    label: '去掉「已扣到位只补状态」的幂等判断（会二次扣减/误转人工）',
    file: 'cloudfunctions/reconcileEntitlementRollbacks/index.js',
    from: '  if (current <= targetMs) {',
    to: '  if (false && current <= targetMs) {',
    cmd: 'node .tools/verify-entitlement-rollbacks.mjs'
  }
];
