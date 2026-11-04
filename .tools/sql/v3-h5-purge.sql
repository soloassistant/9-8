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
--   3. REVOKE EXECUTE 不需要：默认 PUBLIC 可执行是**刻意的**——这正是「用户注销自己的数据」
--      的合法通道，函数自身按 owner 收敛了边界；但也因此**绝不**在函数里加任何按
--      其他 owner 删除的能力；
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

-- 执行后自检（在控制台手动跑，确认函数以 SECURITY DEFINER 存在且 owner 正确）：
--   SELECT proname, prosecdef FROM pg_proc WHERE proname = 'purge_my_h5_data';
--   -- 期望：prosecdef = t
-- 客户端侧验证：H5 登录 → 「我的」→ 注销 → 返回 json 里三个计数 ≥ 0，且再次登录后
--   这三张表按 owner 查无旧行（控制台 SELECT count(*) ... WHERE owner_id = '<旧uid>'）。
