/**
 * mutations-aiquota.mjs —— AI 对话额度闸门的变异用例（2026-10-29）
 *
 * 每条都对应一个**真实可能发生的退化**，不是凑数：
 *   · 取大改成只信云端 → 本地刚发完、云端还没落库时低估用量（用户能多发）
 *   · 云端取不到当 0 → 断网即绕过限制（最危险的失败方式：静默放开）
 *   · 订阅判定被短路 → 付费用户被拦（投诉来源）
 *   · 闸门被挪走/删掉 → 回到"llm_events 只写不读"
 */
export default [
  {
    label: '额度取大改成只信云端（本地刚 +1、云端未落库时低估用量）',
    file: 'src/services/aiQuotaRules.ts',
    from: 'const used = cloud === null ? localUsed : Math.max(cloud, localUsed);',
    to: 'const used = cloud === null ? localUsed : cloud;',
    cmd: 'node .tools/verify-ai-quota.mjs'
  },
  {
    label: '云端取不到当 0（断网即绕过额度限制）',
    file: 'src/services/aiQuotaRules.ts',
    from: 'const used = cloud === null ? localUsed : Math.max(cloud, localUsed);',
    to: 'const used = cloud === null ? 0 : Math.max(cloud, localUsed);',
    cmd: 'node .tools/verify-ai-quota.mjs'
  },
  {
    label: '订阅判定被短路（付费用户被额度拦住）',
    file: 'src/services/aiQuotaRules.ts',
    from: 'if (input.subscribed) return { unlimited: true, limit: -1, used, remaining: -1, source };',
    to: 'if (false) return { unlimited: true, limit: -1, used, remaining: -1, source };',
    cmd: 'node .tools/verify-ai-quota.mjs'
  },
  {
    label: '闸门被绕过（发送前不再查额度，回到 llm_events 只写不读）',
    file: 'src/components/AiAssistant/index.tsx',
    from: 'const quota = await getAiQuota();',
    to: 'const quota = { unlimited: true, limit: -1, used: 0, remaining: -1, source: \'cloud\' as const };',
    cmd: 'node .tools/verify-ai-quota.mjs'
  },
  {
    label: '订阅回放从启动链移除（换设备后付费用户退回免费版）',
    file: 'src/app.tsx',
    from: '  void restoreSubscriptionFromOrders().catch((err) => {',
    to: '  if (false) void restoreSubscriptionFromOrders().catch((err) => {',
    cmd: 'node .tools/verify-ai-quota.mjs'
  },
  {
    label: '记账挪到失败分支之外（失败也扣额度）',
    file: 'src/components/AiAssistant/index.tsx',
    from: `          // 记账口径与云端一致：**只计成功回复**（cloudLlm 也是流式读完才 insert）。
          // 本地镜像的意义是「发完立刻能反映」+ 云端计数不可用时的降级判据。
          bumpLocalUsage();`,
    to: '          // 记账口径被改坏：挪到前面假装的注释，实际不再记账\n          // bumpLocalUsage();',
    cmd: 'node .tools/verify-ai-quota.mjs'
  }
];
