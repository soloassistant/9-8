// 变异用例：四个「行为守门人」harness（batch1 / paid / pref / honesty）
//
// 与 mutations-crash.mjs 同一套契约：
//   · from 必须在目标文件里**正好出现一次**（否则框架判 ERROR，不动文件）；
//   · 目标文件必须没有未提交改动（先 commit 再跑）；
//   · cmd 指向的 harness 基线必须为绿（否则判 ERROR —— 跑不起来不能被当成"抓住了"）。
//
// 选靶原则（本项目实际踩过的教训）：
//   每条断言背后可能有一道主防线 + 若干道冗余防线。变异必须打在**真正产生该行为**的那一道上；
//   打冗余防线（比如只改注释、只改一个没人读的常量副本）时行为不变，框架会正确判 NOT-CAUGHT，
//   那不是校验器的洞，是变异选错了靶子。下面每个 case 都注明「改这里 → 哪条断言变红」。
export default [
  /* ==================================================================
   * 1) verify-batch1.js —— B 订阅分叉
   * ================================================================== */
  {
    // 改这里：续费二次确认的阻断语句消失后，用户点「取消」仍会继续走到 setPaying(true) → 下单。
    // 哪条变红：verify-batch1.js 的 B/tsx/confirmBlocks —— 它要求 `if (!ok) return;`
    //   必须落在 `if (profile?.subscribed) { ... }` 这个块内，且整块在 setPaying(true) 之前闭合。
    // 为什么不是冗余防线：B/tsx/confirmOrder 只比三个 indexOf 的先后，阻断语句没了它照样 PASS，
    //   所以这条变异专门证明「阻断」本身有判别力。
    label: '续费确认取消后不再阻断（会重复下单扣费）',
    file: 'src/pages/mine/index.tsx',
    from: '      if (!ok) return;',
    to: '      // 变异：取消后不再阻断，继续往下扣费',
    cmd: 'node .tools/verify-batch1.js'
  },
  {
    // 改这里：把 60s 新鲜窗口的比较符取反。行为后果是「每次切回 tab 都重拉」——
    //   正是 2026-10 P0 回归的形态（数据没变却闪骨架 + 白耗一次热点请求）。
    // 哪条变红：C/library/freshWindow 断言源码里必须存在 `< LOAD_FRESH_MS) return;` 这一行；
    //   取反后字符串不再存在 → 直接 FAIL。这不是「常量存在性」检查，而是守卫表达式本身。
    label: 'tab 新鲜窗口比较符取反（每次切回都重拉）',
    file: 'src/pages/library/index.tsx',
    from: 'if (Date.now() - lastLoadedAt.current < LOAD_FRESH_MS) return;',
    to: 'if (Date.now() - lastLoadedAt.current >= LOAD_FRESH_MS) return;',
    cmd: 'node .tools/verify-batch1.js'
  },

  /* ==================================================================
   * 2) verify-paid-entitlement.js —— 两条对账路径
   * ================================================================== */
  {
    // 改这里：queryOrder 对账前的「权益接收方必须存在」预检被短路。
    // 行为后果：users 里没有该 openid 时，orders 仍会被置 paid，权益永远发不出去；
    //   而 main() 的「本地已 paid 早退」会让后续重试也不再补发 —— 用户付钱后永久丢权益。
    // 哪条变红：QUERY/缺用户/订单未被置 paid（orderUpdates.length 从 0 变 1）。
    // 为什么不是冗余防线：reconcileOrder 里没有第二道「用户不存在」检查，这里就是主防线；
    //   且它必须在置 paid **之前**执行，顺序本身就是被守的语义。
    label: 'queryOrder 去掉「用户不存在」预检（订单已 paid 但权益发不出去）',
    file: 'cloudfunctions/queryOrder/index.js',
    from: '  if (!payerSnap.data || payerSnap.data.length === 0) {',
    to: '  if (false) {',
    cmd: 'node .tools/verify-paid-entitlement.js'
  },
  {
    // 改这里：微信回调的幂等早退分支被短路。第二次同一 outTradeNo 的回调会再走一遍
    //   订单置 paid + extendUserExpiredAt，expiredAt 叠加、用户被重复延期。
    // 哪条变红：PAY/幂等/第二次走 alreadyPaid（返回值不再有 alreadyPaid:true），
    //   连带 PAY/幂等/用户不再更新、expiredAt 不叠加、订单只更新一次一起变红。
    // 为什么不是冗余防线：confirmOrderPaid 里的 `order.status === 'paid'` 是唯一幂等闸门，
    //   外层 handleWeChat 没有任何二次判重。
    label: 'pay-callback 去掉幂等早退（重复回调会重复延期）',
    file: 'cloudfunctions/pay-callback/index.js',
    from: "  if (order.status === 'paid') {",
    to: '  if (false) {',
    cmd: 'node .tools/verify-paid-entitlement.js'
  },

  /* ==================================================================
   * 3) verify-pref-selection.js —— 偏好改变「集合」
   * ================================================================== */
  {
    // 改这里：selectForUser 在解析出偏好 tag 之后直接返回纯时间倒序 —— 偏好完全失效。
    // 行为后果：用户设了「科学/健康」，看到的仍是全池最新 10 条（健康恒为 0 条）。
    // 哪条变红：prefs=['健康'] 健康条数 >= 1、prefs=['科学'] 科学条数 >= 3、
    //   prefs=['科学','文化'] 两个偏好都 >= 3 条（健康在池里占比最低，最能暴露）。
    // 为什么是主防线：这一行是「有偏好 → 进入选位算法」的唯一分叉点；下面的分桶/保底
    //   只在通过它之后才会执行，改别处都绕不开它。
    label: 'selectForUser 忽略偏好（退回纯时间倒序）',
    file: 'cloudfunctions/webSearch/index.js',
    from: '  if (!prefTags.length) return sorted.slice(0, max);',
    to: '  return sorted.slice(0, max);',
    cmd: 'node .tools/verify-pref-selection.js'
  },
  {
    // 改这里：缓存池宽度从 60 退回 10。行为后果：缓存写入时就把池截到出口条数，
    //   偏好只能在「已经截断的 10 条」里重排 —— 健康这类低占比 tag 提前被砍光。
    // 哪条变红：缓存池宽度 >= 出口条数的 3 倍（10 >= 30 为 false）；
    //   连带「按配置池宽截取后 prefs=['科学'] 仍能选到 >=3 条」也会变红。
    // 为什么是主防线：HOTSPOT_POOL_SIZE 同时喂给 selectWithQuota 的缓存写入（第 687 行）
    //   和 harness 的池宽断言，没有第二处等价的宽度配置。
    label: '热点缓存池宽度 60 → 10（偏好只能在已截断集合里重排）',
    file: 'cloudfunctions/webSearch/index.js',
    from: 'const HOTSPOT_POOL_SIZE = 60;',
    to: 'const HOTSPOT_POOL_SIZE = 10;',
    cmd: 'node .tools/verify-pref-selection.js'
  },

  /* ==================================================================
   * 4) verify-honesty-sample.js —— 条目级标注 / H5 不 mock 不扣额度
   * ================================================================== */
  {
    // 改这里：条目渲染的 sample 门控恒假 —— 三条内置示例动态不再挂「示例」徽章，
    //   和真实用户动态混排、用户无从分辨（PRD.md:25 明确禁止的行为）。
    // 哪条变红：A5 条目渲染引用 community.sampleBadge 且以 p.sample 为条件
    //   （正则要求 `p.sample && ... <Text`）；A7 的样式类断言仍会 PASS —— 说明这条
    //   变异精确打在「渲染条件」而不是「样式存在」这道冗余防线上。
    label: '示例动态不再渲染「示例」徽章（与真实动态混排）',
    file: 'src/pages/learnCommunity/index.tsx',
    from: '                {p.sample && (',
    to: '                {false && (',
    cmd: 'node .tools/verify-honesty-sample.js'
  },
  {
    // 改这里：H5 守卫恒假。行为后果：H5（无语音转写能力）会继续走
    //   checkVoiceQuota() → bumpVoiceUsage()，既消耗真实额度、又用预置文案冒充用户输入。
    // 哪条变红：C2 H5 守卫存在（`if (!isWeapp)` 消失）；
    //   同时 C3/C4 的 guardAt = -1 也一起变红（守卫行号早于 bump/checkQuota 不再成立）。
    // 为什么是主防线：handleVoiceResult 内没有第二处 isWeapp 判断，
    //   守卫的提前 return 是唯一拦住记账的路径。
    label: 'H5 语音守卫被短路（无能力仍扣额度）',
    file: 'src/pages/briefing/index.tsx',
    from:
      "    if (!isWeapp) {\n      Taro.showToast({ title: t('briefing.voiceWeappOnly'), icon: 'none' });\n      return;\n    }",
    to:
      "    if (false) {\n      Taro.showToast({ title: t('briefing.voiceWeappOnly'), icon: 'none' });\n      return;\n    }",
    cmd: 'node .tools/verify-honesty-sample.js'
  }
];
