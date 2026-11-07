// 变异用例：打开态轮询拉取 / 冲突保护 / 打开态刷新（harness: .tools/verify-sync-pull.mjs）
// 每个 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '轮询只推不拉（删掉 pollTick 里的 pullRemote）',
    file: 'src/services/cloudSync.ts',
    from: '    await pullRemote();\n    await pushNow();',
    to: '    await pushNow(); /* MUT: no pull in poll */',
    cmd: 'node .tools/verify-sync-pull.mjs'
  },
  {
    label: '拉取不再区分冲突（conflict 当成 overwrite，静默覆盖本机）',
    file: 'src/utils/syncConflict.ts',
    from: "  return 'conflict';",
    to: "  return 'overwrite'; /* MUT: conflict -> overwrite */",
    cmd: 'node .tools/verify-sync-pull.mjs'
  },
  {
    label: '应用远端后不广播（页面只在 useDidShow 重读）',
    file: 'src/services/cloudSync.ts',
    from: '  emitApplied(appliedKeys);',
    to: '  /* MUT: no applied event */',
    cmd: 'node .tools/verify-sync-pull.mjs'
  }
];
