/**
 * mutations-h5-purge.mjs —— 证明 verify-h5-purge.mjs 有判别力（2026-11-01）。
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标必须先提交 / 恢复后字节级一致。
 */
export default [
  {
    // 灰度分支被删 = SQL 未上线时注销直接 failed 报错（零破坏灰度设计被破坏）
    label: 'PGRST202 灰度分支被删（not-deployed 变 failed）',
    file: 'src/services/cloudDb.ts',
    from: "    if (res.error.code === 'PGRST202') return 'not-deployed';",
    to: '',
    cmd: 'node .tools/verify-h5-purge.mjs'
  },
  {
    // 窄不变式（2026-11-05）：注销完成文案不得宣称「数据已删除」。
    // 为什么不再锚 cloudDb：purge 失败分支已被更强的状态机覆盖（返回值本来就是状态），
    // 删掉那句 console.error 不再产生可观察行为差异；而注销流程正在改成页内工单，
    // 断言必须锚在**用户可见文案**上，工单改造落地后仍然成立。
    label: '注销完成文案宣称已删除全部数据（H5 云端残留仍在）',
    file: 'src/store/language.ts',
    from: "  'mine.deleteDoneH5': '注销已完成：本地数据已立即清除；云端三类记录请到「提交注销工单」提交请求，客服将在 15 个工作日内删除。',",
    to: "  'mine.deleteDoneH5': '注销已完成，已删除全部数据。',",
    cmd: 'node .tools/verify-h5-purge.mjs'
  },
];
