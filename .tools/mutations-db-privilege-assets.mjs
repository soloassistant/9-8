// 变异用例：v3 函数执行权收口（harness: verify-account-purge.js / verify-h5-purge.mjs）
//
// 三种「改坏」各自对应一种真实退化：
//   ① 整条 REVOKE 被删  → 回到 PostgreSQL 默认：EXECUTE 授给 PUBLIC，anon 继承 ⇒ 未登录可调
//   ② anon 从 revoke 列表移除 → 显式给匿名角色留了入口（PUBLIC 被收回也挡不住）
//   ③ GRANT 提到 REVOKE 之前 → 最终 ACL 是「授权被随后的收回抹掉」= 连 authenticated 也调不了
// 每条都分别喂给两个门禁，证明两处断言都有判别力（不是只有一处真在守）。
export default [
  {
    label: 'v3 整条 REVOKE 被删（默认 PUBLIC/anon 可执行）',
    file: '.tools/sql/v3-h5-purge.sql',
    from: 'REVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;\n',
    to: '',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    label: 'v3 REVOKE 漏掉 anon（匿名仍可调用注销函数）',
    file: '.tools/sql/v3-h5-purge.sql',
    from: 'FROM PUBLIC, anon, authenticated;',
    to: 'FROM PUBLIC, authenticated;',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    label: 'v3 GRANT 提到 REVOKE 之前（收回把授权一并抹掉）',
    file: '.tools/sql/v3-h5-purge.sql',
    from: 'REVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.purge_my_h5_data() TO authenticated;',
    to: 'GRANT EXECUTE ON FUNCTION public.purge_my_h5_data() TO authenticated;\nREVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    label: 'v3 整条 REVOKE 被删（h5 门禁也要红）',
    file: '.tools/sql/v3-h5-purge.sql',
    from: 'REVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;\n',
    to: '',
    cmd: 'node .tools/verify-h5-purge.mjs'
  },
  {
    label: 'v3 REVOKE 漏掉 anon（h5 门禁也要红）',
    file: '.tools/sql/v3-h5-purge.sql',
    from: 'FROM PUBLIC, anon, authenticated;',
    to: 'FROM PUBLIC, authenticated;',
    cmd: 'node .tools/verify-h5-purge.mjs'
  },
  {
    label: 'v3 GRANT 提到 REVOKE 之前（h5 门禁也要红）',
    file: '.tools/sql/v3-h5-purge.sql',
    from: 'REVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.purge_my_h5_data() TO authenticated;',
    to: 'GRANT EXECUTE ON FUNCTION public.purge_my_h5_data() TO authenticated;\nREVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;',
    cmd: 'node .tools/verify-h5-purge.mjs'
  },
  // v7 判别力：只查「文本里有 REVOKE」抓不住「收的是哪个主体」。
  // 这三条把 PUBLIC 从 revoke 列表里摘掉（改回 FROM authenticated），
  // 继承通道仍在 ⇒ 门禁必须变红。
  {
    label: 'v7 user_kv 只收回 authenticated（漏掉 PUBLIC，继承权限仍在）',
    file: '.tools/sql/v7-privilege-tighten.sql',
    from: 'public.user_kv    FROM PUBLIC, authenticated;',
    to: 'public.user_kv    FROM authenticated;',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    label: 'v7 feedback 只收回 authenticated（漏掉 PUBLIC，继承权限仍在）',
    file: '.tools/sql/v7-privilege-tighten.sql',
    from: 'public.feedback   FROM PUBLIC, authenticated;',
    to: 'public.feedback   FROM authenticated;',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    label: 'v7 llm_events 只收回 authenticated（漏掉 PUBLIC，继承权限仍在）',
    file: '.tools/sql/v7-privilege-tighten.sql',
    from: 'public.llm_events FROM PUBLIC, authenticated;',
    to: 'public.llm_events FROM authenticated;',
    cmd: 'node .tools/verify-account-purge.js'
  },
  {
    label: 'v7 主体顺序反了（authenticated 在 PUBLIC 之前）',
    file: '.tools/sql/v7-privilege-tighten.sql',
    from: 'public.user_kv    FROM PUBLIC, authenticated;',
    to: 'public.user_kv    FROM authenticated, PUBLIC;',
    cmd: 'node .tools/verify-account-purge.js'
  }
];
