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
    label: 'cloudDb 把「函数未部署」谎报为已清除',
    file: 'src/services/cloudDb.ts',
    from: "    if (res.error.code === 'PGRST202') return 'not-deployed';",
    to: "    if (res.error.code === 'PGRST202') return 'ok'; /* MUT */",
    cmd: 'node .tools/verify-account-purge.js'
  }
];
