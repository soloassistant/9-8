/**
 * mutations-util.mjs —— 证明 verify-util-logic.mjs 的断言有判别力。
 *
 * 每条把「已修的写法」改回「有缺陷的写法」，`node .tools/verify-util-logic.mjs`
 * 必须由 PASS 变 FAIL。改不红 = 门禁是假绿的。
 *
 * 两条缺陷都是「不报错、不崩溃、功能静默失效」类型 —— 没有变异用例兜着，
 * 下次有人"顺手重构"就会无声退回去。
 */
export default [
  {
    label: 'computeBufferMinutes 退回「初值 0 + Math.min 收缩」（留白分恒 0，buffer 规则失效）',
    file: 'src/utils/schedule.ts',
    from: '  let prevGap: number | null = null;',
    // 关键：初值改成 DEFAULT_EDGE_BUFFER_MINUTES(=0)，后续 Math.min 会把间隔压成 0
    to: '  let prevGap: number | null = DEFAULT_EDGE_BUFFER_MINUTES as unknown as null;',
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: 'authorizeWeapp 重新在内部记一次拒绝（一次拒绝计 2 次，降级门槛提前触发）',
    file: 'src/utils/permission.ts',
    from: "    console.error('[permission] authorize denied:', name, err);\n    return false;",
    to: "    console.error('[permission] authorize denied:', name, err);\n    recordPermissionResult(name, false);\n    return false;",
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: '系统侧撤销退回 unknown（诱导再次拉起系统授权弹窗）',
    file: 'src/utils/permission.ts',
    from: 'return granted ? \'granted\' : record.deniedCount > 0 || record.agreed ? \'denied\' : \'unknown\';',
    to: 'return granted ? \'granted\' : record.deniedCount > 0 ? \'denied\' : \'unknown\';',
    cmd: 'node .tools/verify-util-logic.mjs'
  }
];
