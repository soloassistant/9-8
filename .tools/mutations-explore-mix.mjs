/**
 * mutations-explore-mix.mjs —— 证明 verify-explore-mix.mjs 有判别力（2026-11-02）。
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标必须先提交 / 恢复后字节级一致。
 */
export default [
  {
    // 追加而不是替换 = limit=3 的情报区变 4 条，直接撑破版式（routes 门禁之外的第二道）
    label: '追加而不是替换席位（结果变长）',
    file: 'src/utils/exploreMix.ts',
    from: '  const result = out.slice();',
    to: '  const result = out.concat(picked);',
    cmd: 'node .tools/verify-explore-mix.mjs'
  },
  {
    // 四舍五入回潮 = 20 条按 8% 算出 2 条（10%），越过 5-8% 区间
    label: '比例算回四舍五入（越过 8% 上限）',
    file: 'src/utils/exploreMix.ts',
    from: '  const want = Math.floor(out.length * r);',
    to: '  const want = Math.max(1, Math.round(out.length * r));',
    cmd: 'node .tools/verify-explore-mix.mjs'
  },
  {
    // 首条也被替换 = 用户最关心的那条被探索位顶掉
    label: '允许替换首条',
    file: 'src/utils/exploreMix.ts',
    from: '  for (let i = 1; i < result.length && pi < picked.length; i += step) {',
    to: '  for (let i = 0; i < result.length && pi < picked.length; i += step) {',
    cmd: 'node .tools/verify-explore-mix.mjs'
  },
];
