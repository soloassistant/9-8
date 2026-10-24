// 变异用例：晨报首屏结构与状态机（harness: .tools/verify-briefing-structure.js）
//
// 运行方式：
//   node .tools/mutation-verify.mjs .tools/mutations-briefing.mjs
//
// 每条用例把 2026-10-24 修掉的一个缺陷「改回原样」，断言必须变红。
// 改不红 = 那条断言没有判别力，等于没修。
//
// ⚠️ 锚点一律不带换行：本仓工作区是 CRLF（core.autocrlf=true），
//    锚点里写 \n 会匹配 0 次，框架会判 ERROR 而不是 CAUGHT（本轮已踩）。
export default [
  {
    // 守「情报被 hasContent 吃掉」：去掉 hasIntel，pure-intel 用户重新看到空态卡
    // 锚点 2026-10-24 二次校正：并行会话把 hasContent 压行 + optional chaining 空值保护后，
    // 旧锚点（briefing.digest.length > 0 || hasIntel）命中 0 次 → 框架判 ERROR。
    label: 'hasContent 不再统计情报（有情报却显示「今天还没有安排」）',
    file: 'src/pages/briefing/index.tsx',
    from: '(briefing.digest?.length ?? 0) > 0 || hasIntel);',
    to: '(briefing.digest?.length ?? 0) > 0);',
    cmd: 'node .tools/verify-briefing-structure.js'
  },
  {
    // 守「首帧闪空态」：去掉首帧占位态，冷启动重新先闪「今天还没有安排」
    label: '去掉首帧占位态（冷启动先闪一下空态）',
    file: 'src/pages/briefing/index.tsx',
    from: '!briefing && !showSkeleton && !loadError ? null : !briefing && showSkeleton ? (',
    to: '!briefing && showSkeleton ? (',
    cmd: 'node .tools/verify-briefing-structure.js'
  },
  {
    // 守「加载失败伪装成真空态」：不再置 loadError，断网时回到「今天还没有安排」
    label: '加载失败不再进入失败态（断网被说成今天没安排）',
    file: 'src/pages/briefing/index.tsx',
    from: 'if (!briefingRef.current) setLoadError(true);',
    to: '',
    cmd: 'node .tools/verify-briefing-structure.js'
  },
  {
    // 守「勾完的待办重进就复位」
    label: 'doneIds 不再从 todo.status 回填（勾完重进全部复位）',
    file: 'src/pages/briefing/index.tsx',
    from: "(td) => td.status === 'done'",
    to: "(td) => td.status === 'never'",
    cmd: 'node .tools/verify-briefing-structure.js'
  },
  {
    // 守「跳 tabBar 页用了 navigateTo」：weapp 直接抛错，点了没反应。
    // 锚点用 onView={() => {（全文件唯一）—— switchTab 那一行有两处（另一处是
    // handleGoSubscribe），拿它当锚点会「出现 2 次」判 ERROR。
    label: '守护记录入口退回 navigateTo（跳 tabBar 页必然失败）',
    file: 'src/pages/briefing/index.tsx',
    from: 'onView={() => {',
    to: "onView={() => { Taro.navigateTo({ url: '/pages/mine/index' });",
    cmd: 'node .tools/verify-briefing-structure.js'
  },
  {
    // 守「只有天气没有新闻时情报整块消失」
    label: '情报区块门禁退回只看 intelItems（天气与定位一起消失）',
    file: 'src/pages/briefing/index.tsx',
    from: '(briefing.intel.intelItems && briefing.intel.intelItems.length > 0) || briefing.intel.weather',
    to: '(briefing.intel.intelItems && briefing.intel.intelItems.length > 0)',
    cmd: 'node .tools/verify-briefing-structure.js'
  },
  {
    // 守「记账卡被粘进 headerActions」这个结构级回归。原样搬回去代价太大，
    // 这里在 headerActions 内直接引用 ledgerBrief —— 断言判的是「窗口内出现 ledgerBrief」，
    // 与真正搬回去等价地被抓住。
    label: '记账卡重新落进 headerActions（卡片在 flex 行内撑开、压垮问候语列）',
    file: 'src/pages/briefing/index.tsx',
    from: '<View className={styles.headerActions}>',
    to: '<View className={styles.headerActions}>{ledgerBrief ? null : null}',
    cmd: 'node .tools/verify-briefing-structure.js'
  }
];
