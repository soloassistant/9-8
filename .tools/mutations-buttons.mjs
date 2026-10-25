/**
 * mutations-buttons.mjs —— 证明 verify-button-disabled.mjs 的断言有判别力。
 *
 * 每条把「已修的写法」改回「有缺陷的写法」，那条静态门禁必须由 PASS 变 FAIL。
 * 改不红 = 门禁是假绿的（本项目对断言的基本要求）。
 */
export default [
  {
    label: '订阅按钮退回 disabled={paying}（Taro 会渲染 disabled="false" → 白底白字）',
    file: 'src/pages/mine/index.tsx',
    from: 'disabled={disabledAttr(paying)}',
    to: 'disabled={paying}',
    cmd: 'node .tools/verify-button-disabled.mjs'
  },
  // history .clearButton 的变异条目已随该页并入热点页移除（2026-10-25）
  {
    label: 'helper 退化成 ? true : false（等于没修，属性照样渲染）',
    file: 'src/utils/buttonDisabled.ts',
    from: '? true : undefined',
    to: '? true : false',
    cmd: 'node .tools/verify-button-disabled.mjs'
  }
];
