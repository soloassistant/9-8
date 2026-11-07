/**
 * mutations-question-bank-import.mjs —— 证明导入通道的结构/语义/判重门禁有判别力。
 * 每条都把「已修的正确写法」改回「静默失效的缺陷写法」，test:question-bank-import 必须由 PASS 变 FAIL。
 */
export default [
  {
    label: '① 结构必填失效：缺字段的行被当成合法数据放行',
    file: 'src/data/questionBankImport.ts',
    from: "    if (blank(v)) add(field, 'structure.required', `缺少必填字段 ${field}`);",
    to: '    // MUT: 必填校验被跳过',
    cmd: 'node .tools/test-question-bank-import.mjs'
  },
  {
    label: '② 语义校验短路：体系/大纲/答案落选项的错误全部放过',
    file: 'src/data/questionBankImport.ts',
    from: '    if (!verdict.ok) {',
    to: '    if (false) { // MUT: 语义校验被短路',
    cmd: 'node .tools/test-question-bank-import.mjs'
  },
  {
    label: '③ 既有重复预检失效：库里已有的题被当成新题送进写入',
    file: 'src/data/questionBankImport.ts',
    from: "    else if (existingHash.has(key)) addDuplicate(cand.row, q, existingHash.get(key) as string, 'existing');",
    to: '    // MUT: 既有题库判重被跳过',
    cmd: 'node .tools/test-question-bank-import.mjs'
  },
  {
    label: '④ 外部 stemHash 不再拒绝：导入方可伪造内容指纹',
    file: 'src/data/questionBankImport.ts',
    from: '  if (input.foreignStemHash !== undefined) {',
    to: '  if (false) { // MUT: 外部 stemHash 直接放行',
    cmd: 'node .tools/test-question-bank-import.mjs'
  }
];
