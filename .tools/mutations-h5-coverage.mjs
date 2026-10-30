/**
 * mutations-h5-coverage.mjs —— 「H5 功能覆盖面」门禁的变异用例（2026-10-30）
 *
 * 每条变异都对应一种**真实退化**，且都必须让 `verify:h5-coverage` 变红。
 *
 * 特别提醒（2026-10-30 实测踩过的两个坑）：
 *   ① 判据要匹配**调用**而不是标识符 —— 只判 `listCollections` 会连 import 行一起命中，
 *      于是「把降级模块改成硬编码编造数据」这种最该抓住的退化反而蒙混过关。
 *   ② 判据匹配前必须**剥注释** —— 本门禁 C1 判据涉及的组件，其注释里就写着旧写法，
 *      不剥会被注释自己点亮。
 */
export default [
  {
    label: '社区动态不上云（learnCommunityStore 移出 SYNC_KEYS ⇒ 换设备社区归零）',
    file: 'src/services/cloudSync.ts',
    from: "  'learnCommunityStore',",
    to: "  // 'learnCommunityStore',",
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '早鸟锁价不上云（mb_locked_price 移出 SYNC_KEYS ⇒ 换设备权益消失）',
    file: 'src/services/cloudSync.ts',
    // 锚点要**唯一**：只写 `'mb_locked_price'` 会在 REMOVE_PLACEHOLDER 里再命中一次
    // ⇒ 框架报「锚点出现 2 次」直接拒绝执行这条变异（实测踩过）。
    from: "  'mb_locked_price'       // 早鸟终身锁价",
    to: "  // 'mb_locked_price'       // 早鸟终身锁价",
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '屏蔽词不上云（mb_news_blocklist 移出 SYNC_KEYS ⇒ 换设备被屏蔽的内容复活）',
    file: 'src/services/cloudSync.ts',
    from: "  'mb_news_blocklist',",
    to: "  // 'mb_news_blocklist',",
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '合规同意上云（privacy-consent 混进 SYNC_KEYS ⇒ 隐私红线）',
    file: 'src/services/cloudSync.ts',
    from: "  'mb_news_blocklist',",
    to: "  'privacy-consent',\n  'mb_news_blocklist',",
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '删除动作同步不出去（mb_locked_price 没了 REMOVE_PLACEHOLDER）',
    file: 'src/services/cloudSync.ts',
    from: "  'mb_locked_price': {},",
    to: "  // 'mb_locked_price': {},",
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '降级表不再豁免真实本地数据（markDegraded 去掉短路 ⇒ 横幅把真实数据说成演示数据）',
    file: 'src/services/cloud.ts',
    from: 'if (REAL_LOCAL_ACTIONS.has(name) || degradedActions.has(name)) return',
    to: 'if (degradedActions.has(name)) return',
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '收藏夹降级改成硬编码编造（getLibrary 不读本地存储 ⇒ 假数据却不告知）',
    file: 'src/data/getLibrary.ts',
    from: '  return listCollections();',
    to: "  return [{ id: 'mock-1', title: 'mock item', summary: '', source: '', url: '', tags: [], createTime: '' }];",
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '空数组又被当成「没传」（actions={[]} ⇒ 本页把全局横幅拉过来）',
    file: 'src/components/DemoDataHint/index.tsx',
    from: 'const hit = scope === undefined ? degraded : degraded.filter((a) => scope.indexOf(a) >= 0);',
    to: 'const hit = scope && scope.length ? degraded.filter((a) => scope.indexOf(a) >= 0) : degraded;',
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '横幅清单里混进「永不降级」的 action（getUsage 在 REAL_LOCAL_ACTIONS 里）',
    file: 'src/pages/mine/index.tsx',
    from: "<DemoDataHint actions={['updateSettings', 'deleteAccount']} />",
    to: "<DemoDataHint actions={['updateSettings', 'getUsage', 'deleteAccount']} />",
    cmd: 'node .tools/verify-h5-coverage.mjs'
  },
  {
    label: '页面不声明 actions（别的页面的降级横幅会串到这一页）',
    file: 'src/pages/library/index.tsx',
    from: "<DemoDataHint actions={['webSearch', 'getHotspot']} />",
    to: '<DemoDataHint />',
    cmd: 'node .tools/verify-h5-coverage.mjs'
  }
];
