#!/usr/bin/env node
/**
 * mutations-db-contract.mjs —— 「应用数据库契约」门禁的变异用例（2026-10-31 新增）
 *
 * 背景：2026-10-31 线上实测查出两件事实——
 *   ① `src/services/dataSource.ts` 的 RPC_ALLOWLIST 里放着 `chat` / `extract`，
 *      而它们是**微信云函数**，应用数据库里**没有同名 PG 函数**
 *      （探针：404 PGRST202「Could not find the function public.chat(messages)」）。
 *   ② 匿名访客对 `feedback` / `user_kv` / `llm_events` **有 SELECT 权限**，
 *      而这三张表里装着用户数据（feedback.contact 是联系方式 PII，
 *      user_kv.value 是 AI 记忆/聊天记录/购物清单…）。
 *
 * 下面每一条变异都必须被 `.tools/verify-db-contract.mjs` **打红**。
 * 一条 NOT-CAUGHT = 对应判据没有判别力 = 覆盖率缺口（不是噪音）。
 *
 * ⚠️ 锚点纪律：`from` 必须**在当前源码里恰好出现 1 次**。
 *   锚点漂移（出现 0 次）= 这条变异**根本没跑** = 静默失去覆盖。
 */
export default [
  {
    label: '把 webSearch 放回 RPC_ALLOWLIST（应用库无此 PG 函数 ⇒ H5 每次白发一发 404）',
    file: 'src/services/dataSource.ts',
    from: 'const RPC_ALLOWLIST = new Set<string>([])',
    to: "const RPC_ALLOWLIST = new Set<string>(['webSearch'])",
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '把 chat 放回 RPC_ALLOWLIST（微信云函数，应用库里不存在 ⇒ 同上）',
    file: 'src/services/dataSource.ts',
    from: 'const RPC_ALLOWLIST = new Set<string>([])',
    to: "const RPC_ALLOWLIST = new Set<string>(['chat'])",
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '白名单写法改成门禁解析不了的样子（判据必须能发现自己失灵，而不是默默放行）',
    file: 'src/services/dataSource.ts',
    from: 'const RPC_ALLOWLIST = new Set<string>([])',
    to: 'const RPC_ALLOWLIST = makeAllowlist([])',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '白名单闸被短路（未放行的名字也会发网络请求）',
    file: 'src/services/dataSource.ts',
    from: 'if (!RPC_ALLOWLIST.has(name)) {',
    to: 'if (false) {',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '收紧迁移里去掉 feedback 的 ENABLE ROW LEVEL SECURITY（只留 GRANT 收口）',
    file: '.tools/sql/v2-db-anon-revoke.sql',
    from: 'ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;',
    to: '-- ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '收紧迁移里去掉 feedback 的 REVOKE anon（⇒ RLS 一旦失守，匿名可读全表含 contact）',
    file: '.tools/sql/v2-db-anon-revoke.sql',
    from: 'REVOKE ALL ON TABLE public.feedback  FROM PUBLIC, anon;',
    to: '-- REVOKE ALL ON TABLE public.feedback  FROM PUBLIC, anon;',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '收紧迁移里把 feedback 的插入策略改成授予 anon',
    file: '.tools/sql/v2-db-anon-revoke.sql',
    from: 'CREATE POLICY feedback_insert_own ON public.feedback\n  FOR INSERT TO authenticated',
    to: 'CREATE POLICY feedback_insert_own ON public.feedback\n  FOR INSERT TO anon',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '收紧迁移里把 feedback 的读取策略改成授予 anon',
    file: '.tools/sql/v2-db-anon-revoke.sql',
    from: 'CREATE POLICY feedback_select_own ON public.feedback\n  FOR SELECT TO authenticated',
    to: 'CREATE POLICY feedback_select_own ON public.feedback\n  FOR SELECT TO anon',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '收紧迁移里删掉 service_role 的显式授权（收紧 anon 会顺手把管理端一起收掉）',
    file: '.tools/sql/v2-db-anon-revoke.sql',
    from: 'GRANT ALL ON TABLE public.feedback  TO service_role;',
    to: '-- GRANT ALL ON TABLE public.feedback  TO service_role;',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '收紧迁移里去掉 llm_events 的「不给 UPDATE/DELETE」（用量计数可被伪造清零）',
    file: '.tools/sql/v2-db-anon-revoke.sql',
    from: 'REVOKE UPDATE, DELETE ON TABLE public.llm_events FROM PUBLIC, anon, authenticated;',
    to: '-- REVOKE UPDATE, DELETE ON TABLE public.llm_events FROM PUBLIC, anon, authenticated;',
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '客户端开始 SELECT feedback（⇒ 收紧 SELECT 权限会弄坏功能，迁移就不该执行）',
    file: 'src/services/cloudDb.ts',
    from: 'export async function feedbackInsert(input: FeedbackInput): Promise<boolean> {',
    to:
      'export async function feedbackInsert(input: FeedbackInput): Promise<boolean> {\n' +
      "  const _leak = await getCloudDatabase();\n" +
      "  if (_leak) await _leak.from('feedback').select('content, contact');",
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: '同步键写入从 db.rpc 改走 invoke（两条通道被混在一起 ⇒ 空白名单会把同步打死）',
    file: 'src/services/cloudDb.ts',
    from: "const res = await db.rpc<number>('kv_set_many', { p_items: payload });",
    to: "const res = await invoke('kv_set_many', { p_items: payload });",
    cmd: 'node .tools/verify-db-contract.mjs'
  },
  {
    label: 'cloud.ts 的注释改回「白名单放行 webSearch」的陈旧现状陈述（注释会骗下一个人）',
    file: 'src/services/cloud.ts',
    from: '*  **当前为空** —— 应用数据库里没有任何面向客户端的 PG 函数），拿不到就走 src/data/* 的',
    to: '*  只放行 webSearch / chat / extract），拿不到就走 src/data/* 的',
    cmd: 'node .tools/verify-db-contract.mjs'
  }
];
