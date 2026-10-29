/**
 * mutations-boot.mjs —— 首屏骨架门禁的变异用例（2026-10-29）
 *
 * 每条都对应一种「骨架会重新变成白屏 / 白闪 / 转圈死路」的真实退化。
 * 目标文件是**片段源**（src/assets/boot-skeleton.html）与注入/移除的接线，
 * 不是 dist 产物 —— 产物是构建出来的，变异只能改源。
 */
export default [
  {
    label: '骨架节点被改名（产物里没有骨架，冷启动回到纯白）',
    file: 'src/assets/boot-skeleton.html',
    from: 'id="boot-skeleton" role="status"',
    to: 'id="boot-skeleton-v2" role="status"',
    cmd: 'node .tools/verify-boot-skeleton.mjs --no-browser'
  },
  {
    label: '深色适配被删（深色系统下白底闪一下）',
    file: 'src/assets/boot-skeleton.html',
    from: '@media (prefers-color-scheme: dark) {',
    to: '@media (min-width: 99999px) {',
    cmd: 'node .tools/verify-boot-skeleton.mjs --no-browser'
  },
  {
    label: '减动效适配被删（前庭功能敏感用户被强制看动画）',
    file: 'src/assets/boot-skeleton.html',
    from: '@media (prefers-reduced-motion: reduce) {',
    to: '@media (min-width: 99998px) {',
    cmd: 'node .tools/verify-boot-skeleton.mjs --no-browser'
  },
  {
    label: '慢加载兜底被延到 27 小时（网络差时无限转圈，用户无路可走）',
    file: 'src/assets/boot-skeleton.html',
    from: '        }, 10000);',
    to: '        }, 99999999);',
    cmd: 'node .tools/verify-boot-skeleton.mjs --no-browser'
  },
  {
    label: '注入被跳过（dist/index.html 里没有骨架）',
    file: '.tools/copy-assets.js',
    from: 'injectBootSkeleton();',
    to: 'if (false) injectBootSkeleton();',
    cmd: 'node .tools/verify-boot-skeleton.mjs --no-browser'
  },
  {
    label: '挂载后不移除骨架（骨架盖住整个界面）',
    file: 'src/app.tsx',
    from: '    dismissBootSkeletonAfterPaint();',
    to: '    if (false) dismissBootSkeletonAfterPaint();',
    cmd: 'node .tools/verify-boot-skeleton.mjs --no-browser'
  }
];
