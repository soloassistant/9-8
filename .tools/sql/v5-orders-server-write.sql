-- v5-orders-server-write.sql —— 订单表写入口收口（A-1，2026-11-05）
--
-- ⚠️ 执行位置：主理人在 WorkBuddy 平台「应用数据库」控制台（service role）手动执行。
--    **本文件尚未执行**；执行前客户端调用 record_promo_order() 会收到 PGRST202，
--    兑换链路会如实提示「未能登记到云端」，不会假装成功（见 membership 页文案）。
--
-- 背景（为什么必须改）：
--   orders 表的 INSERT 策略是 WITH CHECK (owner_id = auth.uid()) ——
--   「插入自己的一行」是**合法写入**，不是伪造 owner。任何已登录 H5 用户都能直插
--   status='paid', months=120 ⇒ 订阅回放成 10 年 PRO。客户端侧堵不住，只能在库里收口。
--
-- 收口方案：
--   1. 收回 authenticated/anon 的 INSERT/UPDATE/DELETE，客户端只保留 SELECT；
--   2. 唯一写入通道是 SECURITY DEFINER 的 record_promo_order(integer)：
--      只接受 1–366 天，订单号/渠道/金额/状态全部由服务端生成；
--   3. 触发器兜底：客户端角色即使有残留策略，也不允许把任何行写成 paid。

-- 1) 客户端只读
REVOKE INSERT, UPDATE, DELETE ON TABLE public.orders FROM anon, authenticated;
GRANT SELECT ON TABLE public.orders TO authenticated;

-- 幂等清理历史 INSERT 策略（如果控制台里手工建过同名策略）
DROP POLICY IF EXISTS orders_own_insert ON public.orders;

-- 2) 唯一写入通道：促销码兑换
CREATE OR REPLACE FUNCTION public.record_promo_order(p_days integer)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     text := auth.uid()::text;
  v_days    integer := COALESCE(p_days, 0);
  v_months  integer;
  v_order_id text;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录：不能登记订单';
  END IF;
  -- 促销码最长 366 天（early-bird 一年）；越界一律拒绝，不接受客户端自定义时长
  IF v_days < 1 OR v_days > 366 THEN
    RAISE EXCEPTION '无效的兑换天数: %', v_days;
  END IF;
  v_months := GREATEST(1, ROUND(v_days / 30.0)::integer);
  v_order_id := 'promo_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.orders (owner_id, order_id, plan_id, channel, amount_cents, months, status, paid_at)
  VALUES (v_uid, v_order_id, 'promo', 'promo', 0, v_months, 'paid', now());

  RETURN json_build_object('order_id', v_order_id, 'months', v_months);
END;
$$;

REVOKE ALL ON FUNCTION public.record_promo_order(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_promo_order(integer) TO authenticated;

-- 3) 触发器兜底：客户端角色不得写入 paid（SECURITY DEFINER 内 current_user 是函数属主，不受影响）
CREATE OR REPLACE FUNCTION public.orders_block_client_paid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NEW.status = 'paid' THEN
    RAISE EXCEPTION '客户端不得写入 paid 订单';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_block_client_paid ON public.orders;
CREATE TRIGGER orders_block_client_paid
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_block_client_paid();

-- 执行后自检（控制台手动跑）：
--   SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('record_promo_order', 'orders_block_client_paid');
--   -- 期望 record_promo_order 的 prosecdef = t
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'orders' AND grantee IN ('authenticated', 'anon');
--   -- 期望 authenticated 只有 SELECT，anon 无任何权限
