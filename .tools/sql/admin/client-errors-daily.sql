-- 崩溃按日聚合（近 14 天）：发版后 24h 必看。client_errors 列：message / stack / page / channel / ua。
-- 该表只能管理端读（RLS 已 REVOKE，匿名/普通用户读不到——这正是 2026-10-23 的安全设计）。
SELECT
  date_trunc('day', created_at) AS day,
  channel,
  count(*) AS n
FROM client_errors
WHERE created_at >= now() - interval '14 days'
GROUP BY 1, 2
ORDER BY day DESC, n DESC;

-- 最新 20 条明细（看 message 归类；stack 只取首行，避免刷屏）
SELECT
  created_at,
  channel,
  page,
  split_part(message, E'\n', 1) AS message_head
FROM client_errors
ORDER BY created_at DESC
LIMIT 20;

-- 同类错误 Top 5（message 首行聚类，定位「哪一种错在批量发生」）
SELECT
  split_part(message, E'\n', 1) AS message_head,
  count(*) AS n,
  max(created_at) AS last_seen
FROM client_errors
WHERE created_at >= now() - interval '7 days'
GROUP BY 1
ORDER BY n DESC
LIMIT 5;
