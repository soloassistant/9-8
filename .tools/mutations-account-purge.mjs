// 变异用例：X10 匿名 SELECT / 注销残余（harness: .tools/verify-account-purge.js）
export default [
  {
    label: 'v2 漏 revoke user_kv 的 anon 权限（匿名仍可批量读）',
    file: '.tools/sql/v2-db-anon-revoke.sql',
    from: 'REVOKE ALL ON TABLE public.user_kv    FROM PUBLIC, anon;',
    to: '-- MUT: user_kv anon grant left open',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    label: 'v3 反馈删除不再按 owner 收敛（可删他人数据）',
    file: '.tools/sql/v3-h5-purge.sql',
    from: '  DELETE FROM feedback      WHERE owner_id = auth.uid();',
    to: '  DELETE FROM feedback      WHERE true; -- MUT',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    // 窄不变式（2026-11-05）：注销完成文案不得宣称「已删除全部数据」。
    // 原来的写法锚 cloudDb 的 PGRST202 分支；该分支仍能命中但已 NOT-CAUGHT：
    // 返回值本身就是状态，删掉「不可用」判定不影响用户可见或落库结果。
    // 注销流程正在改成页内工单，断言必须锚在文案（i18n 键）上而不是流程顺序，
    // 这样工单改造落地后仍然成立。
    label: '注销完成文案宣称已删除全部数据（云端记录实际可能仍在）',
    file: 'src/store/language.ts',
    from: "  'mine.deleteDone': '注销已完成，你的账号数据已删除。',",
    to: "  'mine.deleteDone': '注销已完成，已删除全部数据。',",
    cmd: 'node .tools/verify-account-purge.js'
  }
];
