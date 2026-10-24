// 变异用例：extract 降级路径不得编造提取结果（harness: .tools/verify-honesty-sample.js）
//
// 背景（2026-10-24 P0）：src/data/extract.ts 是 AI 提取的第三级兜底
//   （① cloud.llm → ② 本地 LLM 代理 → ③ 本地 mock）。
// 修正前它对**任何输入**都返回固定的「产品评审会 / 3 号会议室 / 评审前更新演示文稿」，
// 图片通道则是「季度复盘会（来自截图）」，并把用户原文贴成 source，
// 再由 inbox 套上「— 由 AI 提取整理，请核对 —」标识 —— 用户点确认就写进真实日历。
//
// 一并修的还有三处「不告知就消失」：#27 login 透出 SDK 英文 error.message、
// #23 H5 订阅记录静默空、#24 昵称清空静默 return、#25 偏好截断静默丢、
// #29 去设置失败仍收提示条、#20 点搜索结果只有 toast。
// 这条 case 文件只覆盖 P0（extract），其余几条是文案/交互，由人工复核。
//
// 契约同其它 mutations-*.mjs：from 必须在目标文件里**正好出现一次**；
// 目标文件必须无未提交改动；cmd 基线必须为绿。
export default [
  {
    // 行为后果：假结果被套上「AI 提取」标识，用户点确认就写进真实日历。
    // 哪条变红：E1（不含编造的内容串）
    label: 'mock 的说明文字里塞回编造的内容串（产品评审会）',
    file: 'src/data/extract.ts',
    from: "    note: 'AI 提取当前不可用，未解析你的内容。可稍后重试，或手动新建日程与待办。'",
    to: "    note: 'AI 提取当前不可用，未解析你的内容。可稍后重试，或手动新建日程与待办。产品评审会'",
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 行为后果：降级时凭空给出日程，用户以为是自己粘贴内容里解析出来的。
    // 哪条变红：E2（events 必须为空）
    label: 'mock 又开始返回编造的日程',
    file: 'src/data/extract.ts',
    from: '    events: [],',
    to: "    events: [{ title: 'x' }],",
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 行为后果：同上，编造待办。
    // 哪条变红：E3（todos 必须为空）
    label: 'mock 又开始返回编造的待办',
    file: 'src/data/extract.ts',
    from: '    todos: [],',
    to: "    todos: [{ title: 'x' }],",
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 行为后果：把用户原文切成 source 贴上去，让假结果看起来「是从你的内容里提取的」。
    // 这是编造里最坏的一种 —— 伪造了数据的**来源**。
    // 哪条变红：E4（不许 content.slice / substring / substr）
    //
    // ⚠️ 这条 case 是**把 E4 打回原形**的那条：第一版断言只认 `content.slice`，
    //    而这里注入的是 `content?.slice`（可选链）→ 断言 NOT-CAUGHT，白跑一轮。
    //    所以下面再加一条 plain `content.slice` 的变体，两种形态都要被抓住。
    label: '把用户原文回贴成 source（可选链形态）',
    file: 'src/data/extract.ts',
    from: 'export default function extract(_data?: { content?: string; images?: string[] }): ExtractResult {',
    to: 'export default function extract(_data?: { content?: string; images?: string[] }): ExtractResult {\n  const _s = _data?.content?.slice(0, 50);',
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 同上，但是**原缺陷的真实形态**（plain 点号）。两种都要被抓住，才算 E4 有判别力。
    label: '把用户原文回贴成 source（plain 点号形态，即原缺陷写法）',
    file: 'src/data/extract.ts',
    from: 'export default function extract(_data?: { content?: string; images?: string[] }): ExtractResult {',
    to: 'export default function extract(_data?: { content?: string; images?: string[] }): ExtractResult {\n  const _s = _data?.content.slice(0, 50);',
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 行为后果：降级不留原因，只剩一条笼统 toast，
    //          用户看不出「没解析出东西」与「提取能力不可用」的区别。
    // 哪条变红：E5（必须给出 note）
    label: '降级不说明原因（note: undefined）',
    file: 'src/data/extract.ts',
    from: "    note: 'AI 提取当前不可用，未解析你的内容。可稍后重试，或手动新建日程与待办。'",
    to: '    note: undefined',
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 行为后果：结果卡不再受 drafts 门控 → 没有任何提取结果时，
    //          也显示「— 由 AI 提取整理，请核对 —」。对非 AI 内容作 AI 标识。
    // 哪条变红：E6（AI 标识必须在 drafts.length > 0 守卫内）
    label: '去掉结果卡的 drafts 门控（空结果也显示「由 AI 提取整理」）',
    file: 'src/pages/inbox/index.tsx',
    from: '      {drafts.length > 0 ? (',
    to: '      {true ? (',
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 行为后果：cloud.ts 的 `import(\`../data/${name}\`)` 取不到 default，
    //          降级路径当场抛错 —— 修完诚实性却把兜底修没了。
    // 哪条变红：E7（必须是默认导出）
    label: '摘掉 default 导出（降级路径直接崩）',
    file: 'src/data/extract.ts',
    from: 'export default function extract(_data?: { content?: string; images?: string[] }): ExtractResult {',
    to: 'function extract(_data?: { content?: string; images?: string[] }): ExtractResult {',
    cmd: 'node .tools/verify-honesty-sample.js'
  }
];
