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
    // 2026-10-30 修锚点：慢加载兜底从「setTimeout(..., 10000)」改写成
    // 「elapsed > 10000」的轮询判断（boot 重构：别再数节点，改看 .taro_page），
    // 旧锚点在新源码里出现 0 次 ⇒ 这条变异**根本没跑**（框架报「锚点出现 0 次」）
    // ⇒ 「慢加载兜底被延到 27 小时」这个退化当时无人看守。
    // 现在锚点跟着源码改，阈值仍由门禁 A5（frag 必须含 10000）守着。
    label: '慢加载兜底被延到 27 小时（网络差时无限转圈，用户无路可走）',
    file: 'src/assets/boot-skeleton.html',
    from: "if (elapsed > 10000) skel.classList.add('is-slow');",
    to: "if (elapsed > 99999999) skel.classList.add('is-slow');",
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
  },
  {
    // 2026-10-29 线上事故的原始形态：片段里写回挂载点占位，产物出现两个 id="app"，
    // Taro 取第一个（空的）→ 界面正常但真挂载点留在 body 当一屏高空壳 → 滚到底整片空白。
    // 这条变异只改**片段源**，A15 必须当场抓住（A14 读产物，重新构建前不会变）。
    label: '骨架片段又写回 <div id="app"> 占位（产物两个 #app → 滚到底整屏空白）',
    file: 'src/assets/boot-skeleton.html',
    from: '    <script>',
    to: '    <div id="app"></div>\n    <script>',
    cmd: 'node .tools/verify-boot-skeleton.mjs --no-browser'
  }
];
