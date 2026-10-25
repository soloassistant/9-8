/**
 * mutations-interaction.mjs —— 证明 verify-interaction-fixes.mjs 新增组（A/L/M + K）的断言有判别力。
 *
 * 2026-10-25 补：当晚新增的 K（修改密码）/L（文章视频）/M（宫格）断言此前没有反向变异，
 * 违反「改坏必须能 FAIL」铁律 —— 本文件补齐。每条对应一种真实可能犯的错。
 *
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标文件无未提交改动 / 基线绿。
 */
export default [
  {
    // K 组：改密不走旧密码 sudo = 任何人拿到手机都能改密（安全措施被架空）
    label: '修改密码丢掉旧密码参数（绕过 sudo 校验）',
    file: 'src/pages/mine/index.tsx',
    from: 'resetPasswordForOld({ oldPassword: oldPwd, newPassword: newPwd })',
    to: 'resetPasswordForOld({ oldPassword: \'\', newPassword: newPwd })',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // K 组：两次输入一致性校验被删 = 手滑设错把自己锁在外面
    label: '修改密码删掉两次一致性校验',
    file: 'src/pages/mine/index.tsx',
    from: 'if (newPwd !== confirmPwd) {',
    to: 'if (false) {',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // A 组：点卡片不开文章视图（回退到「点了没反应」缺陷形态）
    label: '热点卡片点击不再打开站内文章视图',
    file: 'src/pages/library/index.tsx',
    from: 'setArticle(item);',
    to: 'setArticle(null);',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // A 组：阅读原文的打开动作被删（链接能力的根）
    label: '阅读原文丢掉 openExternalPage 调用',
    file: 'src/pages/library/index.tsx',
    from: 'void openExternalPage(item.url)',
    to: 'void Promise.resolve(item.url)',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // L 组：正文兜底被砍（content 缺失的旧缓存条目会渲染空白）
    label: '站内正文不再退回 summary（content 缺失即空白）',
    file: 'src/pages/library/index.tsx',
    from: '{item.content || item.summary}',
    to: '{item.content}',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // L 组：视频板块空数组也渲染（假加载态回归）。锚点带 ScrollView 行 —— 该条件串在本页出现 2 次
    //（sectionBar 与 ScrollView），不带上下文会被唯一性检查拦下
    label: '视频板块空数组也渲染（丢失条件隐藏）',
    file: 'src/pages/library/index.tsx',
    from: '{!searchMode && videos.length > 0 ? (\n            <ScrollView scrollX className={styles.videoScroll}',
    to: '{!searchMode ? (\n            <ScrollView scrollX className={styles.videoScroll}',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // L 组：两条管线的 content 上限被改小（站内阅读退化回卡片摘要长度）
    label: 'webSearch content 上限 1000 退回 120',
    file: 'cloudfunctions/webSearch/index.js',
    from: 'content: clampSummary(summary, 1000),',
    to: 'content: clampSummary(summary, 120),',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // M 组：宫格被拆（功能入口回到散落状态）
    label: '功能宫格容器类名被改（宫格断言失锚）',
    file: 'src/pages/mine/index.tsx',
    from: '<View className={styles.featureGrid}>',
    to: '<View className={styles.featureGridOld}>',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // M 组：宫格搜索入口被删（少一个一等入口）
    label: '宫格搜索入口路由被删',
    file: 'src/pages/mine/index.tsx',
    from: "          { icon: '🔍', label: t('mine.gridSearch'), url: '/pages/search/index' }\n",
    to: '',
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // M7：H5 端不再开独立服务（服务外放退化成跳原生简化页）
    label: '省心买 H5 分支退化成页内跳转（独立服务不再外放）',
    file: 'src/pages/mine/index.tsx',
    from: "    if (isH5) {\n      void openExternalPage(SXM_ENTRY_URL).then((r) => {",
    to: "    if (false) {\n      void openExternalPage(SXM_ENTRY_URL).then((r) => {",
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  },
  {
    // M7：小程序端不再进原生页（退回复制外链的旧形态）
    label: '省心买小程序分支退回复制外链',
    file: 'src/pages/mine/index.tsx',
    from: "    Taro.navigateTo({ url: '/pages/sxm/index' });\n  };",
    to: "    Taro.navigateTo({ url: '/pages/shopping/index' });\n  };",
    cmd: 'node .tools/verify-interaction-fixes.mjs'
  }
];
