/**
 * mutations-fetch-guard.mjs —— 证明 verify-fetch-guard.mjs 有判别力（2026-10-31）。
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标必须先提交 / 恢复后字节级一致。
 */
export default [
  {
    // 格式维度被删 = 旧格式兜底继续压住新格式抓取（D2 发布门禁必然红的那个盲区复活）
    label: '格式放行规则被删（旧格式上一份重新靠条数赢）',
    file: '.tools/fetch-data.js',
    from: '  if (newRatio > 0 && prevRatio === 0) return null;',
    to: '',
    cmd: 'node .tools/verify-fetch-guard.mjs'
  },
  {
    // 阈值被改成 0.01 = 回归闸整体失效（任何抖动劣化都会覆盖好数据）
    label: 'REGRESS_RATIO 0.7 改 0.01（回归闸失效）',
    file: '.tools/fetch-data.js',
    from: 'const REGRESS_RATIO = 0.7;',
    to: 'const REGRESS_RATIO = 0.01;',
    cmd: 'node .tools/verify-fetch-guard.mjs'
  },
];
