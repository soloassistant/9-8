-- v3-h5-purge.sql —— H5 注销残留清偿（I3b）的**上线 SQL**（2026-10-31）
--
-- ⚠️ 执行位置：主理人在 WorkBuddy 平台「应用数据库」控制台（service role）手动执行本文件。
--    执行前不必停机；函数创建是幂等的（CREATE OR REPLACE）。
--    执行完成后，客户端（src/services/cloudDb.ts）的注销链路会自动开始调用它 ——
--    在那之前客户端对该函数的调用会收到 PGRST202，客户端按「函数未部署」静默跳过，
--    线上行为与现在完全一致（这是刻意设计的灰度顺序：先发客户端、再执行 SQL、零破坏）。
--
-- 背景（KNOWN_GAPS I3b）：H5 的「注销」只调 kv_clear（清 user_kv），而 H5 还会直接写
-- llm_events / feedback / client_errors 三张表 ⇒ 注销后这三张表的行原样留在云端。
-- 行的归属列是 owner_id（= auth.uid()），技术上可按 owner 删；但 client_errors 对
-- authenticated/anon 已 REVOKE ALL（2026-10-23 的安全设计），普通用户删不了自己的 ——
-- 所以必须走 SECURITY DEFINER 函数代删。
--
-- 安全设计（四条，缺一不可）：
--   1. SECURITY DEFINER + 显式 SET search_path = public, pg_temp —— 防搜索路径劫持；
--   2. 函数体只删 **owner_id = auth.uid()** 的行，不接受任何 owner 参数（谁调用只删谁的）；
--   3. 执行权显式收紧：函数创建后先 REVOKE ALL FROM PUBLIC, anon, authenticated，
--      再 GRANT EXECUTE TO authenticated。**默认「PUBLIC 可执行」是漏洞不是设计**：
--      匿名访客（anon）与 PUBLIC 都不该摸到这条注销通道，只留已登录用户本人；
--   4. 幂等：重复调用返回同样结果（删完再删 = 0 行），客户端可安全重试。

CREATE OR REPLACE FUNCTION public.purge_my_h5_data()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed_events    bigint := 0;
  removed_feedback  bigint := 0;
  removed_errors    bigint := 0;
BEGIN
  DELETE FROM llm_events    WHERE owner_id = auth.uid();
  GET DIAGNOSTICS removed_events = ROW_COUNT;

  DELETE FROM feedback      WHERE owner_id = auth.uid();
  GET DIAGNOSTICS removed_feedback = ROW_COUNT;

  DELETE FROM client_errors WHERE owner_id = auth.uid();
  GET DIAGNOSTICS removed_errors = ROW_COUNT;

  RETURN json_build_object(
    'purged', true,
    'llm_events', removed_events,
    'feedback', removed_feedback,
    'client_errors', removed_errors
  );
END;
$$;

-- 执行权收口（紧跟函数创建；顺序不能反 —— 先 REVOKE 再 GRANT）：
--   · CREATE OR REPLACE FUNCTION 会保留原有 ACL；新建函数时 PostgreSQL **默认把 EXECUTE
--     授给 PUBLIC**，anon 又从 PUBLIC 继承 —— 不显式收回，未登录访客就能调用本函数；
--   · 三个主体一起收回：PUBLIC（默认授权来源）、anon（匿名角色，显式挡住即使将来 PUBLIC
--     被重授）、authenticated（撤销旧 ACL 里可能已存在的更宽授权），再按最小权限只授回
--     给 authenticated。
REVOKE ALL ON FUNCTION public.purge_my_h5_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_my_h5_data() TO authenticated;

-- 执行后自检（在控制台手动跑，确认函数以 SECURITY DEFINER 存在且 owner 正确）：
--   SELECT proname, prosecdef, proacl FROM pg_proc WHERE proname = 'purge_my_h5_data';
--   -- 期望：prosecdef = t；proacl 里不再有「=X」条目（= PUBLIC 的默认 EXECUTE），
--   --       且 X 只出现在 authenticated 与函数 owner 上。
-- 客户端侧验证：H5 登录 → 「我的」→ 注销 → 返回 json 里三个计数 ≥ 0，且再次登录后
--   这三张表按 owner 查无旧行（控制台 SELECT count(*) ... WHERE owner_id = '<旧uid>'）。
