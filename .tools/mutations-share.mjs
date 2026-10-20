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
    label: 'briefing 分享调用改回无标识版本',
    file: 'src/pages/briefing/index.tsx',
    from: "    title: t('share.titleAI', { title: t('share.title') }),",
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
