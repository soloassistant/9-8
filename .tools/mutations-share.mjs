// 变异用例：分享/剪贴板导出的 AI 标识（harness: .tools/verify-share-ai-label.mjs）
// 每个 case 的 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: 'zh 分享标题去掉 AI 前缀',
    file: 'src/store/language.ts',
    from: "  'share.titleAI': 'AI 整理｜{title}',",
    to: "  'share.titleAI': '{title}',",
    cmd: 'node .tools/verify-share-ai-label.mjs'
  },
  {
    label: 'briefing 分享标题去掉档位门控（付费档也退回中性标题）',
    file: 'src/pages/briefing/index.tsx',
    // 9168386 后源码把 AI 前缀挂在三元真分支上；锚点必须与当前源码逐字一致，
    // 否则 mutation-verify 会判 anchor mismatch（0 次命中）而不是「变异被抓住」。
    from: "    title: t(intelResolved.aiEnabled && !intelResolved.degraded ? 'share.titleAI' : 'share.title', { title: t('share.title') }),",
    to: "    title: t('share.title'),",
    cmd: 'node .tools/verify-share-ai-label.mjs'
  },
  {
    label: 'inbox 复制导出去掉 AI 标识跟随',
    file: 'src/pages/inbox/index.tsx',
    // 注意：源码里是模板字面量，\n 是两个字符（反斜杠 + n），这里要写成 \\n
    from: "    Taro.setClipboardData({ data: `${workResult}\\n\\n${t('ai.labelText')}` });",
    to: '    Taro.setClipboardData({ data: workResult });',
    cmd: 'node .tools/verify-share-ai-label.mjs'
  }
];
