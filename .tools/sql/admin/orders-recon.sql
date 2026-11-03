-- 订单对账（有支付工单时执行）。orders 表由 weapp 云函数 createOrder 写入（按 openid 归属）。
-- 列名以云函数实际写入为准（首次执行报错时，以控制台真实结构修正并回提交本文件）。
SELECT
  created_at,
  plan_id,
  amount,
  status,
  channel,
  out_trade_no
FROM orders
ORDER BY created_at DESC
LIMIT 50;

-- 按状态/渠道对账汇总（近 30 天）
SELECT
  status,
  channel,
  count(*) AS n,
  sum(amount) AS amount_sum
FROM orders
WHERE created_at >= now() - interval '30 days'
GROUP BY 1, 2
ORDER BY n DESC;
