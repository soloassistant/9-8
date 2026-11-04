/**
 * mutations-ai-actions.mjs —— 证明 verify-ai-actions.mjs 有判别力（2026-10-31）。
 *
 * 目标：src/services/aiActionExec.ts（另一会话 df6f4ea 的「AI 动作真的执行」执行器）。
 * 三条变异各守一类真实事故：
 *   ① 载荷校验被删 = 模型给空载荷也能「写库成功」（假成功，库里是脏数据）
 *   ② 时间格式校验被删 = 非法 newTime 写进日程（下游日历/提醒全坏）
 *   ③ 改期失败仍写 = 半截写入（原日程被改坏且不可追溯）
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标必须先提交 / 恢复后字节级一致。
 */
export default [
  {
    label: '批量排班载荷校验被删（no_valid_events 分支）',
    file: 'src/services/aiActionExec.ts',
    from: "        return { kind: 'batch', ok: false, saved: 0, reason: 'no_valid_events' };",
    to: '        return { kind: \'batch\', ok: true, saved: 1, reason: \'no_valid_events\' };',
    cmd: 'node .tools/verify-ai-actions.mjs'
  },
  {
    label: '改期时间格式校验被删（bad_time 分支）',
    file: 'src/services/aiActionExec.ts',
    from: "      if (!TIME_RE.test(newTime)) return { kind: 'reschedule', ok: false, saved: 0, reason: 'bad_time' };",
    to: '',
    cmd: 'node .tools/verify-ai-actions.mjs'
  },
];
