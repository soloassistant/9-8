/**
 * mutations-llm-parse.mjs —— 证明 verify-llm-parse.mjs 有判别力（2026-10-31）。
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标必须先提交 / 恢复后字节级一致。
 */
export default [
  {
    // 围栏剥离被删 = 模型输出 ```json 包装时整体降级 mock（用户实测的「AI 不会做事」复活）
    label: '围栏剥离循环被删',
    file: 'src/services/cloudLlm.ts',
    from: '  const fence = /```(?:json)?\\s*([\\s\\S]*?)```/g;\n  for (let m = fence.exec(text); m; m = fence.exec(text)) {\n    const inner = tryParseJson<T>(m[1].trim());\n    if (inner !== null) return inner;\n  }',
    to: '',
    cmd: 'node .tools/verify-llm-parse.mjs'
  },
  {
    // 字符串字面量跳过被删 = 值内含 } 的 JSON 被截断解析（平衡提取名存实亡）
    label: '平衡提取的字符串跳过被删',
    file: 'src/services/cloudLlm.ts',
    from: "    if (ch === '\"') { inStr = '\"'; continue; }",
    to: '',
    cmd: 'node .tools/verify-llm-parse.mjs'
  },
];
