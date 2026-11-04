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
    // 失败被说成成功 = 用户以为三表清了，实际还在（I3b 的原始事故形态）
    label: '真失败被谎报成 ok',
    file: 'src/services/cloudDb.ts',
    from: "    console.error('[cloudDb] purge_my_h5_data failed:', res.error.code || '', res.error.message || '');\n    return 'failed';",
    to: "    return 'ok';",
    cmd: 'node .tools/verify-h5-purge.mjs'
  },
];
