/**
 * 变异用例：云函数**行为层**验证（harness: .tools/verify-cloudfunctions-flow.mjs）
 *
 * 目的：证明 flow 测试里的断言**真的有判别力**。
 *   每条用例把某个云函数的关键逻辑改回「错误版本」，然后重跑 flow 测试，
 *   期望由 PASS 变 FAIL（= CAUGHT）。如果改坏了还是全绿，说明那条断言是摆设。
 *
 * 运行方式（两种都支持）：
 *   node .tools/mutation-verify.mjs .tools/mutations-cloudflow.mjs   # 统一 runner
 *   node .tools/mutations-cloudflow.mjs                             # 本文件内置 wrapper
 *
 * 统一 runner（mutation-verify.mjs）负责的全部安全措施（本文件不重复实现）：
 *   ⓪ 基线先行：干净状态下先跑一次 cmd，必须退出码 0（否则判 ERROR，绝不变异）；
 *   ① 锚点必须正好出现 1 次；
 *   ② 目标文件必须 `git status --porcelain` 干净（有未提交改动 → ERROR，不硬改）；
 *   ③ 替换后回读校验（确认 to 已写入、from 已消失）；
 *   ④ 跑 cmd，非零退出码 = CAUGHT；
 *   ⑤ try/finally 语义的恢复 + sha256 逐字节校验（失配 → 退出码 3，明示仓库被留在变异态）；
 *   ⑥ 全部跑完后在恢复态**复跑**一次 cmd，必须退出码 0（= 恢复后回到全绿）。
 * 直接运行本文件时，wrapper 会把 runner 的退出码翻译成 `restored_green=true|false`。
 *
 * ⚠️ 锚点里**不要带换行符**：本仓工作区是 CRLF（core.autocrlf=true），带 \n 的锚点匹配 0 次。
 *
 * 覆盖的「事故模式」与真实历史对应关系：
 *   · openid 守卫缺失 → 本项目真实发生过「建出 openid 为 undefined 的共享用户」；
 *   · where 只带 _id 不带 openid → 越权改他人待办；
 *   · 无归属查询（where({})）→ 收藏夹/清单对所有人敞开；
 *   · 幂等分支缺失 → 重复点击重复写库、updateTime 被刷新；
 *   · serverDate 写成 ISO 字符串 → 时间字段类型漂移，按时间范围查询失准；
 *   · 配额守卫缺失 → 免费额度形同虚设（成本与合规风险）。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FLOW_CMD = 'node .tools/verify-cloudfunctions-flow.mjs';

export default [
  {
    // 守 flow「login 缺 OPENID 抛错 / 不得建用户」两条。
    // 删掉守卫后：where({openid: undefined}) 退化成全表匹配（匹配 0 条），
    // add 出来的是一条**没有 openid** 的共享用户 —— 正是本项目历史上的真实事故。
    label: 'login 删掉 openid 守卫（缺身份照样建无主用户档案）',
    file: 'cloudfunctions/login/index.js',
    from: "  if (!OPENID) throw new Error('no openid');",
    to: '',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「B 改 A 的待办 → not_found 且文档未变」。
    label: 'todoStatus 的 where 去掉 openid（越权改他人待办）',
    file: 'cloudfunctions/todoStatus/index.js',
    from: 'const where = { _id: id, openid: OPENID };',
    to: 'const where = { _id: id };',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「nickname 超 12 字落库被截断」。
    label: 'updateSettings 去掉 nickname 的 slice(0,12)（超长昵称原样落库）',
    file: 'cloudfunctions/updateSettings/index.js',
    from: 'update.nickname = payload.nickname.trim().slice(0, 12);',
    to: 'update.nickname = payload.nickname.trim();',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「重复设置同一状态 → unchanged:true 且不写库」。
    label: 'todoStatus 去掉幂等分支（重复设置仍写库并刷新 updateTime）',
    file: 'cloudfunctions/todoStatus/index.js',
    from: '  if (doc.status === status) return { ok: true, unchanged: true };',
    to: '  if (false) return { ok: true, unchanged: true };',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「getLibrary 只返回自己的 items」：去掉 openid 条件 = 无归属查询。
    label: 'getLibrary 去掉 openid 条件（收藏夹对所有人敞开）',
    file: 'cloudfunctions/getLibrary/index.js',
    from: '.where({ openid: OPENID })',
    to: '.where({})',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「created_at 落库是 Date 实例」：改成 ISO 字符串后类型漂移，
    // 按时间范围/排序查询会失真（errors 集合的排查能力直接受影响）。
    label: 'reportError 把 db.serverDate() 写成 ISO 字符串（时间字段类型漂移）',
    file: 'cloudfunctions/reportError/index.js',
    from: 'created_at: db.serverDate(),',
    to: 'created_at: new Date().toISOString(),',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「deleteAccount 不碰别人的数据」：去掉 openid 条件 = 注销时清空全库。
    label: 'deleteAccount 的 remove 去掉 openid 条件（一个用户注销清空全库）',
    file: 'cloudfunctions/deleteAccount/index.js',
    from: 'db.collection(name).where({ openid: OPENID }).remove()',
    to: 'db.collection(name).where({}).remove()',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「refundOrder 越权退款被拒」：归属校验失效 = 谁都能退别人的订单（直接资损）。
    label: 'refundOrder 去掉订单归属校验（任何人可退他人订单）',
    file: 'cloudfunctions/refundOrder/index.js',
    from: '  if (order.openid !== OPENID) {',
    to: '  if (false) {',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「收藏满 50 条 → 抛错」：配额守卫失效 = 免费档无上限。
    label: 'confirmItem 去掉收藏配额守卫（免费档可无限收藏）',
    file: 'cloudfunctions/confirmItem/index.js',
    from: 'if (countRes.total >= FREE_COLLECTION_QUOTA) {',
    to: 'if (false) {',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「免费额度用尽 → 抛错且不扣额度」：守卫失效 = 语音额度无上限。
    label: 'chat 去掉语音额度守卫（免费档可无限调用 LLM）',
    file: 'cloudfunctions/chat/index.js',
    from: 'if (usage.voiceUsed >= FREE_VOICE_QUOTA) {',
    to: 'if (false) {',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「订阅用户额度为 -1」：把订阅判定写死 = 付费用户被当免费用户限流。
    label: 'getUsage 把订阅额度写死成免费额度（付费用户被限流）',
    file: 'cloudfunctions/getUsage/index.js',
    from: 'voiceQuota: isSubscribed ? -1 : FREE_VOICE_QUOTA,',
    to: 'voiceQuota: FREE_VOICE_QUOTA,',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「briefingTime="25:99"/"24:00" 不落库、23:59 正常」。
    // 退回旧的 /^\d{2}:\d{2}$/ 后 25:99 会被判合法 → 脏时间落库（getBriefing 分桶时被静默吞掉）。
    label: 'updateSettings 把时间正则退回 /^\\d{2}:\\d{2}$/（放过 25:99）',
    file: 'cloudfunctions/updateSettings/index.js',
    from: 'const TIME_RE = /^([01]\\d|2[0-3]):[0-5]\\d$/;',
    to: 'const TIME_RE = /^\\d{2}:\\d{2}$/;',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「applyPlan 越权改期 saved=0 且他人日程不变」：
    // 归属校验失效 = 拿到别人的 eventId 就能改别人的日程时间。
    label: 'chat applyPlan 去掉日程归属校验（可改他人日程）',
    file: 'cloudfunctions/chat/index.js',
    from: 'if (!doc.data || doc.data.openid !== openid) continue;',
    to: 'if (!doc.data) continue;',
    cmd: FLOW_CMD
  },

  /* ---- 2026-10 缺陷修复的守卫（每条都对应一个刚修掉的真实缺陷）---- */
  {
    // 守 flow「注销后 errors 里该 openid 为 0 / 别人的 errors 保留 / removed=5」。
    // 同时守静态对齐断言：从清单删掉 errors 后「所有按 openid 写入的集合都已登记」必须红。
    label: 'deleteAccount 把 errors 从注销清单里删掉（崩溃上报的 openid 留在云端）',
    file: 'cloudfunctions/deleteAccount/index.js',
    from: "    'errors',",
    to: '',
    cmd: FLOW_CMD
  },
  {
    // 专守**静态对齐检查本身**：newsFeedback 在运行时用例里没有任何数据（删掉不触发运行时失败），
    // 只有「注销清单 ⊇ 按 openid 写入点」这条静态断言能抓到它 —— 证明它不是摆设。
    label: 'deleteAccount 把 newsFeedback 从注销清单里删掉（只有静态对齐能抓）',
    file: 'cloudfunctions/deleteAccount/index.js',
    from: "    'newsFeedback',",
    to: '',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「配额超限时 events/todos 零写入 + 没有任何 add 调用」。
    // 让配额预检恒不生效 = 退回「超限照样写库」。
    label: 'confirmItem 让配额预检失效（超限仍然写库）',
    file: 'cloudfunctions/confirmItem/index.js',
    from: '    if (countRes.total >= FREE_COLLECTION_QUOTA) {',
    to: '    if (false) {',
    cmd: FLOW_CMD
  },
  {
    // 守同一条断言的**顺序**属性：在配额预检之前插入一次写库，
    // 复现旧的「先写 events/todos 再检查配额」非原子顺序 —— 超限时 items 会多一条、且有 add 流水。
    label: 'confirmItem 在配额预检之前插入写库（旧的非原子顺序）',
    file: 'cloudfunctions/confirmItem/index.js',
    from: '  const wantsCollection = !!(collection && collection.title && collection.summary);',
    to: "  const wantsCollection = !!(collection && collection.title && collection.summary); await db.collection('items').add({ data: { openid: OPENID, title: 'quota-bypass' } });",
    cmd: FLOW_CMD
  },
  {
    // 守 flow「无本人档案 → 抛 user not found（不返回 undefined）」。
    label: 'updateSettings 去掉 stats.updated 检查（无档案时静默返回 undefined）',
    file: 'cloudfunctions/updateSettings/index.js',
    from: "if (updatedCount === 0) throw new Error('user not found');",
    to: "if (false) throw new Error('user not found');",
    cmd: FLOW_CMD
  },
  {
    // 守 flow「reportError 无参调用不抛错且仍然落库」。
    label: 'reportError 把 err.TARO_ENV 改回 event.TARO_ENV（无参调用抛 TypeError）',
    file: 'cloudfunctions/reportError/index.js',
    from: "channel: String(err.channel || err.TARO_ENV || (APPID ? 'weapp' : 'unknown')),",
    to: "channel: String(err.channel || event.TARO_ENV || (APPID ? 'weapp' : 'unknown')),",
    cmd: FLOW_CMD
  },
  {
    // 守 flow「首次 login 返回也带 _id，且与库内一致」。
    label: 'login 首次创建退回 return profile（响应形状不一致，首次无 _id）',
    file: 'cloudfunctions/login/index.js',
    from: '    return { _id: added._id, ...profile };',
    to: '    return profile;',
    cmd: FLOW_CMD
  },
  {
    // 守 flow「当月首轮对话不抛错 / voiceUsed 1→2」。
    // 退回 return doc（无 _id）后，调用方 doc(undefined).update 必抛错。
    label: 'chat 的 getUsage 退回 return doc（新建 usage 文档不带 _id）',
    file: 'cloudfunctions/chat/index.js',
    from: '  return { _id: added._id, ...doc };',
    to: '  return doc;',
    cmd: FLOW_CMD
  }
];

/* ------------------------------------------------------------------ *
 * 直接执行时的 wrapper：委托给统一 runner，并把结果翻译成 restored_green
 * （作为 case 文件被 import 时不会触发 —— 见下面的 main 判断）
 * ------------------------------------------------------------------ */

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch (e) {
    return false;
  }
})();

if (isMain) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const self = path.relative(repo, fileURLToPath(import.meta.url)).split(path.sep).join('/');
  const res = spawnSync(process.execPath, ['.tools/mutation-verify.mjs', self], {
    cwd: repo,
    stdio: 'inherit'
  });
  const green = res.status === 0;
  // runner 最后一步是「恢复态复跑 cmd，必须退出码 0」；这里把它显式打出来，
  // 避免"变异全部 CAUGHT 但恢复后一直是红的"这种更糟的状态被忽略。
  console.log(`restored_green=${green}`);
  process.exitCode = green ? 0 : res.status || 1;
}
