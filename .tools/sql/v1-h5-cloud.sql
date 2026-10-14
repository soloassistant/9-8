-- =====================================================================
-- v1-h5-cloud.sql —— H5 迁移：云数据库表 + RLS（2026-10-13）
--
-- 背景：产品从微信小程序迁到 H5 + WorkBuddy 云后端。此前 H5 的用户数据只有
-- localStorage，/api/user/data 与 /api/user/sync 两个同步端点在静态托管下
-- 恒 404/501（从未真正工作过）。本迁移把同步与 LLM 用量记账落到云数据库。
--
-- 设计要点：
--  ① user_kv —— per-user 键值表，直接对应前端 cloudSync 的 SYNC_KEYS
--     （18 个 localStorage 键）。一行一键，RLS owner_id = auth.uid() 隔离。
--     client_ts 保存客户端写入时间戳，用于「新者赢」跨设备冲突解决
--     （与迁移前 applyRemoteData 的 ts 口径一致，纯函数不变）。
--  ② llm_events —— 只增不改的用量事件表。客户端只能 INSERT/SELECT 自己的行，
--     没有 UPDATE/DELETE 策略 ⇒ 改不了、删不掉历史计数，配额无法被伪造清零。
--     计数走 PostgREST count 查询，不需要 SECURITY DEFINER 函数
--     （本迁移刻意不引入 SECURITY DEFINER：配额只可能被灌大（自伤），不可能被抹小）。
--  ③ kv_set_many 为 SECURITY INVOKER（默认）—— RLS 照常生效，只写自己的行。
--
-- 执行方式：workbuddy_cloudservice_db_exec_sql，一条语句一次调用（见文件末尾清单）。
-- 函数体内注释一律英文 ASCII（中文进 base64 是高风险字符区，且原样存入 prosrc）。
-- =====================================================================

-- ---------- 1. user_kv 表 ----------
CREATE TABLE user_kv (
  key        TEXT        NOT NULL,
  value      JSONB       NOT NULL,
  owner_id   TEXT        NOT NULL DEFAULT auth.uid(),
  client_ts  BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

-- ---------- 2. user_kv 表注释 ----------
COMMENT ON TABLE user_kv IS 'Per-user key-value sync store (app SYNC_KEYS); owner isolated by RLS';

-- ---------- 3. llm_events 表 ----------
CREATE TABLE llm_events (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       TEXT        NOT NULL,
  owner_id   TEXT        NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 4. llm_events 表注释 ----------
COMMENT ON TABLE llm_events IS 'Append-only LLM usage events per user (chat/voice); no update/delete by design';

-- ---------- 5. llm_events 计数索引 ----------
CREATE INDEX llm_events_owner_kind_time ON llm_events (owner_id, kind, created_at DESC);

-- ---------- 6. user_kv 开 RLS ----------
ALTER TABLE user_kv ENABLE ROW LEVEL SECURITY;

-- ---------- 7. user_kv 表级授权（仅已登录用户） ----------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_kv TO authenticated;

-- ---------- 8. user_kv 行级策略：仅本人（读写同一口径，UPDATE 双向 CHECK 防转赠） ----------
DROP POLICY IF EXISTS user_kv_own_all ON public.user_kv;

-- ---------- 9. ----------
CREATE POLICY user_kv_own_all ON public.user_kv
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- ---------- 10. llm_events 开 RLS ----------
ALTER TABLE llm_events ENABLE ROW LEVEL SECURITY;

-- ---------- 11. llm_events 表级授权：只给 SELECT + INSERT（无 UPDATE/DELETE ⇒ 计数不可改） ----------
GRANT SELECT, INSERT ON TABLE public.llm_events TO authenticated;

-- ---------- 12. llm_events 读策略：仅本人 ----------
DROP POLICY IF EXISTS llm_events_own_select ON public.llm_events;

-- ---------- 13. ----------
CREATE POLICY llm_events_own_select ON public.llm_events
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

-- ---------- 14. llm_events 写策略：仅本人（WITH CHECK 防伪造成绩归属） ----------
DROP POLICY IF EXISTS llm_events_own_insert ON public.llm_events;

-- ---------- 15. ----------
CREATE POLICY llm_events_own_insert ON public.llm_events
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- ---------- 16. kv_set_many：批量 upsert（新者赢） ----------
-- 入参 p_items: [{"key":"...","value":<jsonb>,"ts":<epoch ms>}, ...]
-- 语义：每条按 (owner_id, key) upsert；仅当 incoming ts > 已存 ts 才覆盖
--   （旧设备离线后的陈旧推送不会盖掉新设备已写入的新值）。
-- SECURITY INVOKER（默认）：RLS 照常生效，只能写自己的行。
-- value 上限 512KB（pg_column_size 字节数），防单键被撑爆。
CREATE OR REPLACE FUNCTION kv_set_many(p_items jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $fn$
DECLARE
  n integer;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN 0;
  END IF;
  INSERT INTO public.user_kv (key, value, client_ts)
  SELECT it->>'key',
         it->'value',
         COALESCE((it->>'ts')::bigint, 0)
  FROM jsonb_array_elements(p_items) AS it
  WHERE jsonb_typeof(it) = 'object'
    AND it->>'key' IS NOT NULL
    AND it->>'key' <> ''
    AND jsonb_typeof(it->'value') IS NOT NULL
    AND pg_column_size(it->'value') < 524288
  ON CONFLICT (owner_id, key)
  DO UPDATE SET value = EXCLUDED.value,
                client_ts = EXCLUDED.client_ts,
                updated_at = now()
  WHERE EXCLUDED.client_ts > user_kv.client_ts;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

-- ---------- 17. kv_set_many 注释 ----------
COMMENT ON FUNCTION kv_set_many(jsonb) IS 'Batch upsert user_kv rows for the current user; newer client_ts wins';

-- ---------- 18. kv_clear：清空当前用户的全部键（账号注销/清除云端数据用） ----------
CREATE OR REPLACE FUNCTION kv_clear()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.user_kv WHERE owner_id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

-- ---------- 19. kv_clear 注释 ----------
COMMENT ON FUNCTION kv_clear() IS 'Delete all user_kv rows owned by the current user';

-- ---------- 20. 权限收口：函数默认 PUBLIC EXECUTE，必须连根拔掉再按需授 ----------
REVOKE ALL ON FUNCTION public.kv_set_many(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 21. ----------
REVOKE ALL ON FUNCTION public.kv_clear() FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 22. 仅已登录用户可执行 ----------
GRANT EXECUTE ON FUNCTION public.kv_set_many(jsonb) TO authenticated;

-- ---------- 23. ----------
GRANT EXECUTE ON FUNCTION public.kv_clear() TO authenticated;
