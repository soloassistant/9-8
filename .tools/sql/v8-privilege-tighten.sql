-- v8-privilege-tighten.sql —— 收回 PUBLIC 与 authenticated 在用户数据表上的三项非功能权限（2026-11-05）
--
-- 背景（外部审查指出；**本节是待核实线索，不是已实测结论**）：
--   authenticated 对 public.user_kv / feedback / llm_events 可能持有
--   TRUNCATE / REFERENCES / TRIGGER。这三项都不是客户端功能需要的：
--     · TRUNCATE   —— 绕过 RLS（行级策略对 TRUNCATE 不生效），一条语句清空整表；
--     · REFERENCES —— 可在该表上建外键，把行内容以约束冲突的形式试探/外泄；
--     · TRIGGER    —— 可在该表上挂触发器，产生越权副作用。
--   客户端只做行级读写（SELECT/INSERT/UPDATE/DELETE），用不到上面任何一项。
--
-- ⚠️ 执行位置：主理人在 WorkBuddy 平台「应用数据库」控制台（service role）手动执行。
-- ⚠️ 本会话没有数据库执行通道：本文件是**待执行**资产，执行后才有线上效果。
-- ⚠️ 命名：v6 已被 v6-promo-server-codes.sql 占用、v7 已被 v7-support-tickets.sql 占用，
--    故本支取 v8。这两份都要人工去平台执行，共用编号会导致拿错文件（建表 vs 收权限后果不对等）。
--
-- 本文件分成两节，**性质不同，不要混读**：
--   §A 收回三项        —— 脚本已写、**待平台执行**（唯一的写操作，幂等）
--   §B 权项期望值       —— **待线上实测**；只给只读查询，不写「收回后应剩哪些权」的断言

-- ======================================================================
-- §A 收回三项（本文件唯一的写操作；脚本已写、待平台执行）
-- ======================================================================
-- 两个主体都要收回，PUBLIC 写在前面：
--   这三项可能来自 PUBLIC 的默认授权，authenticated 会经 PUBLIC 继承；
--   只写 `FROM authenticated` 是**无效收紧** —— 执行后 authenticated 仍可 TRUNCATE
--   绕过 RLS 清空整表，而门禁只看文本里有 REVOKE 会照样全绿。
-- anon 的行级权限由 v2-db-anon-revoke.sql 处理（该脚本是否已执行同样待核实）；
-- service_role 不受影响（v2 第 8 步显式 GRANT ALL）。
-- 客户端只用行级 SELECT/INSERT/UPDATE/DELETE，上述三项**不** GRANT 回来。
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.user_kv    FROM PUBLIC, authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.feedback   FROM PUBLIC, authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.llm_events FROM PUBLIC, authenticated;

-- ======================================================================
-- §B 权项期望值 —— 待线上实测（以下全部为只读查询，不改任何权限）
-- ======================================================================
-- 为什么不在这一节写「收回后只该剩 SELECT/INSERT/…」：
--   authenticated 手里到底剩哪些权，取决于平台默认 GRANT 的真实历史，**读脚本读不出来**；
--   把猜测写成期望值 = 假绿。下面先观测，再决定要不要追下一笔。
--
-- 已知**仓库意图**（不是线上事实）：v2 第 9 步只授
--   feedback = SELECT, INSERT；user_kv = SELECT, INSERT, UPDATE, DELETE；
--   llm_events = SELECT, INSERT（第 17 步再 REVOKE UPDATE/DELETE）。
--   但 v2 是否已执行过、平台默认授权是否被它覆盖，都还没有实测证据。
--
-- ⚠️ 待实测点 1（最可疑）：**feedback 可能还持有 UPDATE / DELETE**。
--   仓库里客户端只 INSERT feedback、从不改删，v2 也只授 SELECT+INSERT；
--   若实测 can_update / can_delete 为 true，说明平台默认 GRANT ALL 的残留还在，
--   需要另起一笔（不在本文件里顺手扩大改动面）。
-- ⚠️ 待实测点 2：§A 同时收回 PUBLIC 与 authenticated（脚本已写、待平台执行）。
--   执行后若 can_truncate 仍为 true，说明还有别的授权来源（表 owner 隐式权限 /
--   平台额外 GRANT），要用 B2 的 ACL 快照定位，而不是再加一条 REVOKE authenticated。
--
-- B1. 逐表逐权：观测 authenticated 当前**有效持有**的权限（含经 PUBLIC 继承）。
--     t = 持有，f = 不持有。执行 §A 前后各跑一次，对比即可看出 §A 的实际效果。
SELECT
  has_table_privilege('authenticated', 'public.user_kv', 'SELECT')     AS user_kv_select,
  has_table_privilege('authenticated', 'public.user_kv', 'INSERT')     AS user_kv_insert,
  has_table_privilege('authenticated', 'public.user_kv', 'UPDATE')     AS user_kv_update,
  has_table_privilege('authenticated', 'public.user_kv', 'DELETE')     AS user_kv_delete,
  has_table_privilege('authenticated', 'public.user_kv', 'TRUNCATE')   AS user_kv_truncate,
  has_table_privilege('authenticated', 'public.user_kv', 'REFERENCES') AS user_kv_references,
  has_table_privilege('authenticated', 'public.user_kv', 'TRIGGER')    AS user_kv_trigger;

SELECT
  has_table_privilege('authenticated', 'public.feedback', 'SELECT')     AS feedback_select,
  has_table_privilege('authenticated', 'public.feedback', 'INSERT')     AS feedback_insert,
  has_table_privilege('authenticated', 'public.feedback', 'UPDATE')     AS feedback_update,
  has_table_privilege('authenticated', 'public.feedback', 'DELETE')     AS feedback_delete,
  has_table_privilege('authenticated', 'public.feedback', 'TRUNCATE')   AS feedback_truncate,
  has_table_privilege('authenticated', 'public.feedback', 'REFERENCES') AS feedback_references,
  has_table_privilege('authenticated', 'public.feedback', 'TRIGGER')    AS feedback_trigger;

SELECT
  has_table_privilege('authenticated', 'public.llm_events', 'SELECT')     AS llm_events_select,
  has_table_privilege('authenticated', 'public.llm_events', 'INSERT')     AS llm_events_insert,
  has_table_privilege('authenticated', 'public.llm_events', 'UPDATE')     AS llm_events_update,
  has_table_privilege('authenticated', 'public.llm_events', 'DELETE')     AS llm_events_delete,
  has_table_privilege('authenticated', 'public.llm_events', 'TRUNCATE')   AS llm_events_truncate,
  has_table_privilege('authenticated', 'public.llm_events', 'REFERENCES') AS llm_events_references,
  has_table_privilege('authenticated', 'public.llm_events', 'TRIGGER')    AS llm_events_trigger;

-- B2. 授权来源：直接看三张表的 ACL 条目（grantee = 0 表示 PUBLIC）。
--     用途：§A 之后若某权仍为 true，用这张表定位是「直接授给 authenticated」还是「经 PUBLIC」。
--     aclitem 文本里 `=` 开头的条目就是 PUBLIC 的授权；`authenticated=` 是显式授给角色。
SELECT
  c.relname,
  a.grantee,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee_name,
  a.privilege_type,
  a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('user_kv', 'feedback', 'llm_events')
ORDER BY c.relname, grantee_name, a.privilege_type;
