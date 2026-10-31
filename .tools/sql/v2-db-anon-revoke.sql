-- =====================================================================
-- v2-db-anon-revoke.sql —— 收紧应用数据库的匿名（anon）访问面（2026-10-31）
--
-- 背景（全部来自线上实测，不是推断）：
--   用**匿名**身份（只带 publishable key，无登录态）探应用数据库的 REST 端点：
--     GET    /.cloud/database/rest/feedback     → 200 []
--     GET    /.cloud/database/rest/user_kv       → 200 []
--     GET    /.cloud/database/rest/llm_events    → 200 []
--     GET    /.cloud/database/rest/orders        → 401 DATABASE_42501（已收口 ✅）
--     GET    /.cloud/database/rest/client_errors → 401 DATABASE_42501（已收口 ✅）
--     INSERT /.cloud/database/rest/feedback     → 401 DATABASE_42501（anon 无写权限 ✅）
--     DELETE /.cloud/database/rest/feedback     → 401 DATABASE_42501（anon 无删权限 ✅）
--   ⇒ **anon 对 feedback / user_kv / llm_events 持有 SELECT 权限**。
--
-- 为什么这是要修的：这三张表里有**用户数据**。
--   · feedback.contact —— 用户主动留的联系方式（PII）。
--   · user_kv.value    —— 同步键的**全部**用户数据：AI 记忆、聊天记录、购物清单、日程…
--   · llm_events       —— 每个用户的 LLM 用量事件。
--   anon 能读 ⇒ 「知道有哪些用户 + 拿到他们的联系方式/内容」。
--
--   三张表都有 `owner_id` 列（PostgREST schema cache 实测：
--   feedback(id,owner_id,type,content,contact,page,created_at)、
--   user_kv(key,value,owner_id,client_ts,updated_at)、
--   llm_events(id,kind,owner_id,created_at)）⇒ **可以用 owner_id = auth.uid() 做 RLS 隔离**。
--
--   现状之所以「看起来安全」，只是因为表是空的：表空 ⇒ SELECT 恒返回 []，
--   与「RLS 把行全挡住」在外部**完全无法区分**（两者都是 200 + []）。
--   这正是「注释不能当事实」的典型：src/services/cloudDb.ts 的注释写着
--   「匿名访客对表无 GRANT，实测 42501 拒绝」—— 那条 42501 说的是 **INSERT**，
--   而 **SELECT 是 200**。注释没说错，只是漏了另一半。
--
-- 本迁移做**双重收口**（两条都上，任一条失守另一条仍在）：
--   ① 表级 GRANT 收口：REVOKE 掉 anon（以及 PUBLIC 的默认授权）。
--      ⇒ 即使将来某条 RLS 策略被误删，anon 也**读不到行**（42501）。
--   ② 行级 RLS 兜底：策略只 TO authenticated，条件 owner_id = auth.uid()。
--      ⇒ 已登录用户也只能看自己的行。
--
-- ⚠️ 执行前置：
--   · 本会话**没有**数据库执行工具（平台侧 `workbuddy_cloudservice_db_exec_sql` 不可用），
--     故本文件是**待执行**的迁移，不是「已修复」。执行需要一条语句一次调用。
--   · 执行前请确认：客户端只会 INSERT feedback（src/services/cloudDb.ts 的 feedbackInsert），
--     **从不 SELECT** ⇒ 收掉 anon 的 SELECT 不影响任何现有功能。
--     （这条由 .tools/verify-db-contract.mjs 的断言守着。）
--
-- 执行方式（与 v1-h5-cloud.sql 同款，一条语句一次调用）：
--   node .tools/sql-split.mjs .tools/sql/v2-db-anon-revoke.sql          # 列出语句
--   node .tools/sql-split.mjs .tools/sql/v2-db-anon-revoke.sql --strip-comments <i>   # 取第 i 条的 base64
--   → 交给平台的 exec_sql 通道执行。
--
-- 幂等性：全部语句可重复执行（ALTER/DROP IF EXISTS/CREATE/REVOKE/GRANT）。
-- 函数体内注释一律英文 ASCII（中文进 base64 是高风险字符区，且原样存入 prosrc）。
-- =====================================================================

-- ---------- 1. feedback：开 RLS ----------
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

-- ---------- 2. feedback：行级策略（只 TO authenticated，且只本人） ----------
DROP POLICY IF EXISTS feedback_insert_own ON public.feedback;

-- ---------- 3. ----------
CREATE POLICY feedback_insert_own ON public.feedback
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- ---------- 4. ----------
DROP POLICY IF EXISTS feedback_select_own ON public.feedback;

-- ---------- 5. ----------
CREATE POLICY feedback_select_own ON public.feedback
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

-- ---------- 6. feedback 表注释 ----------
COMMENT ON TABLE public.feedback IS 'User feedback (PII: contact); RLS owner_id = auth.uid(); anon revoked';

-- ---------- 7. anon / PUBLIC 全面收口（三张表） ----------
-- ⚠️ 必须连 PUBLIC 一起 revoke：Postgres 里 PUBLIC 是**默认授权来源**，
--    只 revoke 某个具体角色**不会**移除它从 PUBLIC 继承来的权限。
--    （这正是 client_errors / orders 当年收口时踩过的那条路。）
REVOKE ALL ON TABLE public.feedback  FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.user_kv    FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.llm_events FROM PUBLIC, anon;

-- ---------- 8. service_role 显式授权（管理端不受影响：BYPASSRLS + 显式表权限） ----------
-- 收掉 PUBLIC 之后，必须把管理端要用的权限**显式**补回来，
-- 否则「收紧 anon」会顺手把「运营看不到反馈」也一起收紧。
GRANT ALL ON TABLE public.feedback  TO service_role;
GRANT ALL ON TABLE public.user_kv    TO service_role;
GRANT ALL ON TABLE public.llm_events TO service_role;

-- ---------- 9. authenticated 显式授权（与 v1-h5-cloud.sql 同口径，幂等重授） ----------
GRANT SELECT, INSERT ON TABLE public.feedback TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_kv TO authenticated;
GRANT SELECT, INSERT ON TABLE public.llm_events TO authenticated;

-- ---------- 10. 兜底：user_kv / llm_events 的 RLS 必须处于开启态 ----------
ALTER TABLE public.user_kv    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_events ENABLE ROW LEVEL SECURITY;

-- ---------- 11. 行级策略补齐（与 v1-h5-cloud.sql 一致；v1 若已执行则等价于重放） ----------
DROP POLICY IF EXISTS user_kv_own_all ON public.user_kv;

-- ---------- 12. ----------
CREATE POLICY user_kv_own_all ON public.user_kv
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ---------- 13. ----------
DROP POLICY IF EXISTS llm_events_own_select ON public.llm_events;

-- ---------- 14. ----------
CREATE POLICY llm_events_own_select ON public.llm_events
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

-- ---------- 15. ----------
DROP POLICY IF EXISTS llm_events_own_insert ON public.llm_events;

-- ---------- 16. ----------
CREATE POLICY llm_events_own_insert ON public.llm_events
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- ---------- 17. llm_events 保持「只增不改」：不给 authenticated UPDATE/DELETE ----------
-- 计数不可被改、不可被清零（配额防伪造）。上面第 9 步刻意只授 SELECT + INSERT。
REVOKE UPDATE, DELETE ON TABLE public.llm_events FROM PUBLIC, anon, authenticated;

-- ---------- 18. 收口后的期望行为（执行后用这三条核对） ----------
--   匿名 GET  /.cloud/database/rest/feedback → 401 DATABASE_42501（不再是 200）
--   匿名 GET  /.cloud/database/rest/user_kv  → 401 DATABASE_42501
--   匿名 GET  /.cloud/database/rest/llm_events → 401 DATABASE_42501
--   已登录 INSERT feedback                    → 201（RLS insert-own 放行本人行）
