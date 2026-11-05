-- v6-promo-server-codes.sql —— 取代 v5（2026-11-05）
--
-- ⚠️ 本文件尚未执行。执行位置：WorkBuddy 应用数据库控制台（service role）。
--
-- 为什么必须有 v6（v5 的两个致命缺陷，已由资金/订单方案线指出）：
--   1. v5 的函数是 record_promo_order(p_days integer) —— **天数由客户端传**。
--      登录用户调 10 次 p_days=366 就是约 10 年 PRO。等于把「客户端 INSERT」
--      换成「调一个 SECURITY DEFINER 函数」，后门只是换了扇门。
--   2. v5 的 REVOKE 只写了 anon, authenticated，**漏了 PUBLIC**：PUBLIC 继承权限
--      不会被移除（仓库 v2-db-anon-revoke.sql L76-79 已踩过这个坑）。
--
-- v6 的收口：
--   · 唯一写入函数改为 redeem_promo_order(p_code text) —— 只收兑换码；
--     天数由服务端按 promo_codes 查表决定，码的存在/有效期由服务端校验。
--   · 同一用户同一码只能兑一次（promo_redemptions 主键），防止「一码刷十次」。
--   · 表权限一律 REVOKE ... FROM PUBLIC, anon, authenticated。
--   · 即使 v5 已经被执行过，本迁移也会 DROP 掉旧函数并撤销权限（幂等清理）。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) orders 只读（含 PUBLIC —— 关键修正）
REVOKE ALL ON TABLE public.orders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.orders TO authenticated;
DROP POLICY IF EXISTS orders_own_insert ON public.orders;

-- 2) 促销码表（只存哈希；明文永不入库、不进仓）
CREATE TABLE IF NOT EXISTS public.promo_codes (
  code_hash  text    PRIMARY KEY,
  plan_days  integer NOT NULL CHECK (plan_days BETWEEN 1 AND 366),
  good_until date    NOT NULL,
  active     boolean NOT NULL DEFAULT true
);

-- 3) 兑换记录：同一用户同一码只能兑一次（跨用户仍可共用，促销码语义不变）
CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  owner_id   text        NOT NULL,
  code_hash  text        NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, code_hash)
);

-- 新表默认权限一律收回（Supabase 的 default privileges 会给 anon/authenticated 授权）
REVOKE ALL ON TABLE public.promo_codes, public.promo_redemptions FROM PUBLIC, anon, authenticated;

-- 4) 清理 v5 的旧函数（它信任客户端天数；若已执行过，这一步把后门拆掉）
REVOKE ALL ON FUNCTION public.record_promo_order(integer) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.record_promo_order(integer);

-- 5) 唯一写入通道：传码，不传天数
CREATE OR REPLACE FUNCTION public.redeem_promo_order(p_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      text := auth.uid()::text;
  v_hash     text;
  v_days     integer;
  v_months   integer;
  v_order_id text;
  v_inserted integer;
BEGIN
  IF v_uid IS NULL OR v_uid = '' THEN
    RAISE EXCEPTION '未登录：不能登记订单';
  END IF;
  IF p_code IS NULL OR length(trim(p_code)) < 8 THEN
    RAISE EXCEPTION '兑换码格式无效';
  END IF;

  -- 与客户端同一口径：trim + 大写后再 SHA-256；客户端只负责输入，服务端才是判定方
  v_hash := encode(digest(upper(trim(p_code)), 'sha256'), 'hex');

  SELECT plan_days INTO v_days
    FROM public.promo_codes
   WHERE code_hash = v_hash AND active AND good_until >= CURRENT_DATE;
  IF v_days IS NULL THEN
    RAISE EXCEPTION '兑换码无效或已过期';
  END IF;

  -- 一码一人一次（并发下靠主键原子占坑）
  INSERT INTO public.promo_redemptions (owner_id, code_hash) VALUES (v_uid, v_hash)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RAISE EXCEPTION '该兑换码已使用过';
  END IF;

  v_months := GREATEST(1, ROUND(v_days / 30.0)::integer);
  v_order_id := 'promo_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO public.orders (owner_id, order_id, plan_id, channel, amount_cents, months, status, paid_at)
  VALUES (v_uid, v_order_id, 'promo', 'promo', 0, v_months, 'paid', now());

  RETURN json_build_object('order_id', v_order_id, 'months', v_months, 'plan_days', v_days);
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_promo_order(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_promo_order(text) TO authenticated;

-- 6) 触发器兜底：客户端角色不得把任何行写成 paid（SECURITY DEFINER 内 current_user 为函数属主）
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

-- 7) 种子码（与 src/utils/promo.ts 的 PROMO_CODES 同一哈希；明文不进仓库）
INSERT INTO public.promo_codes (code_hash, plan_days, good_until) VALUES
  ('c50a410675acc8f8e689ce23cd3c231c990e81f255e07621afe6c1515cd0b0c5', 30, '2026-12-31'),
  ('d3f960f8e093f102aee5615c9e5b230e0eded015ce939a4edde6844971fcf143', 30, '2027-01-31')
ON CONFLICT (code_hash) DO UPDATE
  SET plan_days = EXCLUDED.plan_days, good_until = EXCLUDED.good_until;

-- 执行后自检：
--   SELECT proname, pronargs, prosecdef FROM pg_proc
--     WHERE proname IN ('redeem_promo_order', 'record_promo_order', 'orders_block_client_paid');
--   -- 期望：只有 redeem_promo_order(text, prosecdef=t)；record_promo_order 零行
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'orders' AND grantee IN ('PUBLIC','authenticated','anon');
--   -- 期望：authenticated 只有 SELECT
