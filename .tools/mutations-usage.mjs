// 变异用例：功能记账 + 续费管理（harness: .tools/verify-usage-renewal.mjs）
//
// 与其它 mutations-*.mjs 同一套契约：
//   · from 必须在目标文件里**正好出现一次**（否则框架判 ERROR，不动文件）；
//   · 目标文件必须没有未提交改动（先 commit 再跑）；
//   · cmd 指向的 harness 基线必须为绿。
//
// 选靶原则：每一条都打在「真正产生该行为」的那一行。特别是记账的两条 ——
// 「mock 分支也记账」必须打在那条 warn 之后的**同一段**里，因为 harness 的反向断言
// 用 slice 划定了 mock 分支的边界，打在边界外就变成了"改了个没人管的地方"。
export default [
  /* ---------------- 记账口径：不许把降级/失败算成消耗 ---------------- */
  {
    // 行为后果：H5 在真 AI 不可用时落到 src/data/* 示例数据，用户在「功能记账」里
    // 看到的是"用了几次 AI"，而实际上一次都没调通 —— 虚报用量，且越用越离谱。
    // 哪条变红：C1 mock 降级分支内没有任何 recordUsage。
    label: 'AI 降级到示例数据时也记账（虚报用量）',
    file: 'src/services/cloud.ts',
    from: '      console.warn(`[Cloud] all AI paths unavailable, fallback to mock: ${name}`)',
    to: '      console.warn(`[Cloud] all AI paths unavailable, fallback to mock: ${name}`)\n      recordUsage(name === \'chat\' ? \'chat\' : \'extract\')',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },
  {
    // 行为后果：搜索失败（RSS 挂了 / 超时）也被记成一次消耗，用户会以为额度被白扣。
    // 哪条变红：C3 搜索失败/异常分支不记账。
    label: '全网搜索失败也记账（失败不是消耗）',
    file: 'src/services/api.ts',
    from: "    console.warn('[api] newsSearch failed:', err);",
    to: "    console.warn('[api] newsSearch failed:', err);\n    recordUsage('search');",
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },
  {
    // 行为后果：AI 成功分支不记账 → 账本永远是空的，用户看到"近 7 天无消耗"但额度在掉。
    // 哪条变红：C1 recordUsage 落在 if(ai) 分支内、且在 mock 分支之前（recIdx=-1）。
    label: 'AI 成功分支漏记（账本永远为空）',
    file: 'src/services/cloud.ts',
    from: "        recordUsage(name === 'chat' ? 'chat' : 'extract')",
    to: '        // 变异：成功也不记账',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },
  {
    // 行为后果：流式对话在拿到空回包时也计一次 —— 用户重试几次就把额度记满了。
    // 哪条变红：C2 流式对话在 if(!res) return null 之后才记账。
    label: '流式对话在拿到回包前就记账（空回包也算消耗）',
    file: 'src/services/cloud.ts',
    from: '  if (!res) return null',
    to: "  recordUsage('chat')\n  if (!res) return null",
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },

  /* ---------------- 账本纯逻辑 ---------------- */
  {
    // 行为后果：设备时钟被调到未来时记账写进"明天"，不裁的话"今天"永远查不到新记录，
    // 看起来就像记账坏了（这是最难排查的一类）。
    // 哪条变红：A3 未来日期被裁掉。
    label: '裁剪不删未来日期（"今天"永远查不到记录）',
    file: 'src/utils/featureUsage.ts',
    from: 'if (idx < minIdx || idx > todayIdx) continue;',
    to: 'if (idx < minIdx) continue;',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },
  {
    // 行为后果：脏数据（云同步写回来的非数字）被当真，展示成 NaN 或固定值。
    // 哪条变红：A1 未知功能字段与负数/非数字被丢弃。
    label: '洗数据时不再过滤非数字/负数（脏值进账本）',
    file: 'src/utils/featureUsage.ts',
    from: 'if (Number.isFinite(n) && n > 0) clean[f] = Math.floor(n);',
    to: 'clean[f] = n;',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },

  /* ---------------- 续费判定 ---------------- */
  {
    // 行为后果：到期日当天就显示"已过期"（多数平台当天仍有效），用户会以为被提前掐了。
    // 哪条变红：B5 今天到期 → expiring 而不是 expired。
    label: '到期当天判成已过期（提前一天掐断）',
    file: 'src/utils/renewal.ts',
    from: "  if (diff < 0) return { status: 'expired'",
    to: "  if (diff <= 0) return { status: 'expired'",
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },
  {
    // 行为后果：没有订阅标记也照日期算出"还剩 N 天"—— 用一个不可信的字段冒充事实。
    // 哪条变红：B1 未订阅 → status=none / daysLeft=null。
    label: '未订阅也按日期编出到期状态（猜事实）',
    file: 'src/utils/renewal.ts',
    from: '  if (!args.subscribed || !day) {',
    to: '  if (!day) {',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },
  {
    // 行为后果：每次进「我的」页都弹一次到期提醒，一天能弹十几次。
    // 哪条变红：B8 同一天重复进页面只提醒一次。
    label: '提醒不再做一天一次节流（进页面就弹）',
    file: 'src/utils/renewal.ts',
    from: "  return String(lastRemindDay || '') !== today;",
    to: '  return true;',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },

  /* ---------------- UI / 配色 ---------------- */
  {
    // 行为后果：删掉"不自动续费"这句，用户会默认以为到期自动扣款 —— 恰好相反的事实。
    // 哪条变红：D2 续费块有状态徽标 + 到期日 + 提醒开关 + 不自动续费说明。
    label: '删掉「不做自动续费」的说明（暗示会自动扣款）',
    file: 'src/pages/mine/index.tsx',
    from: "            <Text className={styles.renewNote}>{t('mine.renewNoAuto')}</Text>",
    to: '            {null}',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  },
  {
    // 行为后果：到期日小字掉到 75% 白 = 3.58:1，12px 正文过不了 AA（这个值上一轮刚踩过）。
    // 哪条变红：D4 到期日小字 ≥4.5。
    label: '到期日小字改回 75% 白（深底 3.58:1）',
    file: 'src/pages/mine/index.module.scss',
    from: '  color: rgba(255, 255, 255, 0.92);\n}\n\n.renewWarn',
    to: '  color: rgba(255, 255, 255, 0.75);\n}\n\n.renewWarn',
    cmd: 'node .tools/verify-usage-renewal.mjs'
  }
];
