-- 用户反馈队列（最新优先）。feedback 列：type / content / contact / page（+ owner_id / created_at）。
-- PII 纪律：contact 是联系方式，结果不外传。
SELECT
  created_at,
  type,
  page,
  content,
  contact
FROM feedback
ORDER BY created_at DESC
LIMIT 50;

-- 本周反馈量按类型分布（观察哪类问题在涨）
SELECT type, count(*) AS n
FROM feedback
WHERE created_at >= now() - interval '7 days'
GROUP BY type
ORDER BY n DESC;
