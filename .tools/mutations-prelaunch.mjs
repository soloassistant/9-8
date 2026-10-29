/**
 * mutations-prelaunch.mjs —— 证明 verify-prelaunch-fixes.js 的 C2 组断言有判别力。
 *
 * 2026-10-29 审计新增：C2 组（截断口径唯一事实源 / 句边界 / 未来时间护栏）。
 * 起因是本仓库第三次出现「同一件事两份口径」：
 *   · 云函数 2026-10-22 已改成句边界截断
 *   · .tools/fetch-data.js（**H5 线上数据就是它产的**）只做硬切 → 实测 274/414 条半句话
 *   · .tools/static-server.js 更老：裸 slice(0, 80)
 * 新断言若没有反向变异，就是「从没变红过的断言」＝没写。
 *
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标文件无未提交改动 / 基线绿。
 * ⚠️ 目标文件（text-clamp.js / static-server.js / webSearch/index.js / fetch-data.js）
 *    必须**先提交**再跑本文件 —— 变异框架拒绝变异「有未提交改动」的目标文件。
 */
export default [
  {
    // C2：句边界逻辑被删 = 摘要重新变回半句话（用户直接看到「…该公司在」）
    label: '截断退化为硬切（句边界逻辑被删）',
    file: 'cloudfunctions/webSearch/text-clamp.js',
    from: 'const cut = strong >= 0 ? strong : findWeak(head, minCut);',
    to: 'const cut = -1;',
    cmd: 'node .tools/verify-prelaunch-fixes.js'
  },
  {
    // C2：本地预览链路退回裸 slice = 口径发散（也切坏代理对）
    label: 'static-server 退回裸 slice(0,80) 当摘要',
    file: '.tools/static-server.js',
    from: 'summary: clampText(desc || title, 80),',
    to: 'summary: (desc || title).slice(0, 80),',
    cmd: 'node .tools/verify-prelaunch-fixes.js'
  },
  {
    // C2：未来时间护栏被删 = 源站时钟超前时用户看到「未来的时间」
    label: '未来时间护栏被删（时间戳原样透传）',
    file: 'cloudfunctions/webSearch/index.js',
    from: 'if (ts > Date.now() + FUTURE_SKEW_MS) ts = Date.now();',
    to: '',
    cmd: 'node .tools/verify-prelaunch-fixes.js'
  },
  {
    // C2：H5 链路不再用共享实现 = 第三份口径（这正是这次要消灭的东西）
    label: 'fetch-data 不再用共享截断实现（自带一份）',
    file: '.tools/fetch-data.js',
    from: "const { clampText } = require('../cloudfunctions/webSearch/text-clamp.js');",
    to: "const clampText = (s, max) => String(s == null ? '' : s).slice(0, max);",
    cmd: 'node .tools/verify-prelaunch-fixes.js'
  }
];
