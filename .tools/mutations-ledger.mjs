// 变异用例：记账导出（harness: .tools/verify-ledger-export.mjs）
// 每个 case 的 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '去掉 RFC4180 转义',
    file: 'src/utils/ledgerExport.ts',
    from: '  if (/[",\\n\\r]/.test(value)) {',
    to: '  if (false && /[",\\n\\r]/.test(value)) {',
    cmd: 'node .tools/verify-ledger-export.mjs'
  },
  {
    label: '去掉 CSV 公式注入前置',
    file: 'src/utils/ledgerExport.ts',
    // 源码含反引号模板与 \- 转义，用双引号字符串承载，\\- 表示字面反斜杠+连字符
    from: "  if (/^[=+\\-@]/.test(value)) return `'${value}`;",
    to: "  if (false && /^[=+\\-@]/.test(value)) return `'${value}`;",
    cmd: 'node .tools/verify-ledger-export.mjs'
  },
  {
    label: '排序 date 比较翻转成升序',
    file: 'src/utils/ledgerExport.ts',
    from: '      if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? 1 : -1;',
    to: '      if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? -1 : 1;',
    cmd: 'node .tools/verify-ledger-export.mjs'
  }
];
