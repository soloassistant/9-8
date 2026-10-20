// 变异用例：云同步冲突检测（harness: .tmp-verify/sync-conflict/verify.mjs）
// 每个 case 的 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: 'classifyPull 去掉 conflict 分支（回到静默覆盖）',
    file: 'src/utils/syncConflict.ts',
    from: "  return 'conflict';",
    to: "  return 'overwrite';",
    cmd: 'node .tmp-verify/sync-conflict/verify.mjs'
  },
  {
    label: 'valueHash 改回键序敏感的 JSON.stringify',
    file: 'src/utils/syncConflict.ts',
    from: '    s = stableStringify(value);',
    to: '    s = JSON.stringify(value);',
    cmd: 'node .tmp-verify/sync-conflict/verify.mjs'
  },
  {
    label: 'collectLocal 不再跳过未裁决冲突键',
    file: 'src/services/cloudSync.ts',
    from: '    if (conflicted.has(k)) continue;',
    to: '    if (conflicted.has(k)) { /* MUT: no skip */ }',
    cmd: 'node .tmp-verify/sync-conflict/verify.mjs'
  },
  {
    label: '删掉一个同步键的中文标签',
    file: 'src/store/language.ts',
    from: "  'sync.key.ledgerEntries': '记账条目',",
    to: '',
    cmd: 'node .tmp-verify/sync-conflict/verify.mjs'
  }
];
