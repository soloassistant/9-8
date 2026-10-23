// 变异用例：云函数离线门禁（harness: .tools/verify-cloudfunctions.mjs）
//
// 运行方式：
//   node .tools/mutation-verify.mjs .tools/mutations-cloud.mjs
//
// 注意：mutation-verify 要求目标文件**在 git 里是干净的**（没有未提交改动）。
// 云函数源码有未提交改动时会以 ERROR 拒绝变异 —— 这是既有机制，不是本文件的 bug。
//
// 每条用例守的都是「门禁里某一条断言」的判别力。特别是最后两条：
//   · getBriefing 的 openid 守卫是 2026-10-23 门禁第一次跑出来的真实缺陷（原本缺守卫，
//     缺 OPENID 时会 where({openid: undefined}) 并写入 openid 为空的脏记录）；
//   · 硬编码环境 ID 那条用于证明 C4「不留硬编码凭据」不是永远绿的摆设。
export default [
  {
    // 守 B 段「exports.main 是函数」：改掉导出名后模块仍能加载，但入口消失。
    // 这类错误在真部署前完全不可见（上传成功、调用 404 或 500）。
    label: 'todoStatus 把 exports.main 改名（入口消失但模块仍可加载）',
    file: 'cloudfunctions/todoStatus/index.js',
    from: 'exports.main = async',
    to: 'exports.MAIN = async',
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },
  {
    // 守 C2 段「缺 OPENID 必须明确拒绝」：拿掉登录函数的守卫，
    // 会退化成「建出 openid 为 undefined 的共享用户」——项目历史事故。
    label: 'login 删掉 openid 守卫（缺身份照样建用户档案）',
    file: 'cloudfunctions/login/index.js',
    from: "  if (!OPENID) throw new Error('no openid');",
    to: '',
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },
  {
    // 守 C3 段「where 查询不得用 _openid」：云函数写记录时 SDK 才注入 _openid，
    // 读查询用它恒空 —— 症状是「数据在库里有，就是查不到」，极难排查。
    label: 'login 把 openid 查询改成 _openid（云函数读查询恒空）',
    file: 'cloudfunctions/login/index.js',
    from: 'where({ openid: OPENID })',
    to: 'where({ _openid: OPENID })',
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },
  {
    // 守 A 段「相对 require 目标存在」：本地模块改名/漏提交时，
    // 只在云端运行时才炸，本地所有前端构建都不受影响。
    label: 'chat 引用一个不存在的本地模块（部署后才会炸）',
    file: 'cloudfunctions/chat/index.js',
    from: "require('./llm')",
    to: "require('./llm-missing')",
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },
  {
    // 守 A 段「timer cron 必须 7 段」：微信定时触发器是 7 段（秒 分 时 日 月 周 年），
    // 写成 5 段标准 cron 时控制台不会报错，只是永远不触发 —— 晨报推送整体消失。
    label: 'getBriefing 定时 cron 写成 5 段（永不触发）',
    file: 'cloudfunctions/getBriefing/config.json',
    from: '"0 30 5 * * * *"',
    to: '"0 30 5 * *"',
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },
  {
    // 守 A 段「dependencies 声明 wx-server-sdk」：漏声明时云端安装依赖会失败，
    // 函数上传成功但一调用就 Cannot find module。
    // 锚点不带换行：本仓工作区是 CRLF（core.autocrlf=true），写 \n 会匹配不到。
    label: 'todoStatus 漏声明 wx-server-sdk 依赖',
    file: 'cloudfunctions/todoStatus/package.json',
    from: '"wx-server-sdk": "~2.6.3"',
    to: '"wx-server-sdk-disabled": "~2.6.3"',
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },
  {
    // 守 C4 段「不得硬编码环境 ID」：写死后切环境必然打到旧库，
    // 而且源码进 git 后环境名对外暴露。
    label: 'todoStatus 硬编码云开发环境 ID',
    file: 'cloudfunctions/todoStatus/index.js',
    from: 'cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });',
    to: "cloud.init({ env: 'cloud1-2gabcdef12345678' });",
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },
  {
    // ★ 反向验证本轮的真实修复：把新增的守卫改回去，门禁必须重新变红。
    // 没有这条，「getBriefing 已修好」就只是我的一句话。
    label: 'getBriefing 退回无 openid 守卫（本轮修复前的状态）',
    file: 'cloudfunctions/getBriefing/index.js',
    from: "  if (!OPENID) throw new Error('no openid');",
    to: '',
    cmd: 'node .tools/verify-cloudfunctions.mjs'
  },

  /* ---- 以下三条守部署预检（harness: .tools/verify-deploy-preflight.mjs）---- *
   * 预检分支原本从没被执行过一次：唯一验证过的是「缺配置 → exit 2」。
   * 而配置错的代价发生在「上传到一半」，会留下前几个函数成功、后面全挂的半残环境。 */
  {
    label: '预检不再校验 AppID 格式（gh_ 原始 ID 会被当成 AppID 上传）',
    file: '.tools/deploy-cloud.mjs',
    from: "if (!/^wx[0-9a-fA-F]{16}$/.test(appid)) {",
    to: 'if (false) {',
    cmd: 'node .tools/verify-deploy-preflight.mjs'
  },
  {
    label: '预检不再校验密钥是 RSA（EC 私钥会被当成上传密钥）',
    file: '.tools/deploy-cloud.mjs',
    from: "        if (key.asymmetricKeyType !== 'rsa') {",
    to: '        if (false) {',
    cmd: 'node .tools/verify-deploy-preflight.mjs'
  },
  {
    label: '预检不再打印待配环境变量清单（部署完只剩静默降级）',
    file: '.tools/deploy-cloud.mjs',
    from: "  printEnvPlan('—— 部署后必须在控制台配置的环境变量 ——');",
    to: '',
    cmd: 'node .tools/verify-deploy-preflight.mjs'
  }
];
