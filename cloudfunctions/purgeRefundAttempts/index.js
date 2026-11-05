/**
 * refund_attempts 保留策略清理（每日定时）
 *
 * refund_attempts._id 同时是退款并发闸门，清理必须**只碰失败记录**：
 *   · accepted —— 永久保留（退款审计凭据，量极小），绝不删
 *   · pending  —— 永不按龄删（它就是锁；删掉会让同一退款重新拿到「发起权」）
 *   · failed   —— 保留 180 天后分批删除（每轮 100 条，余下留到下一轮）
 *
 * 不用数据库 TTL：云开发控制台没有 TTL 索引选项，只能靠定时任务。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ATTEMPTS = 'refund_attempts';
const BATCH = 100;
const FAILED_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

exports.main = async () => {
  const now = Date.now();
  const cutoff = new Date(now - FAILED_RETENTION_MS).toISOString();
  // 只删 failed：漏掉 status 条件会把 pending（并发锁）和 accepted（审计）一起删掉
  const cond = { status: 'failed', createTime: db.command.lt(cutoff) };
  let data = [];
  try {
    ({ data } = await db.collection(ATTEMPTS).where(cond).limit(BATCH).get());
  } catch (err) {
    // 全新环境里第一次退款发生前集合还不存在（云开发 -502005），无需清理
    if (err && err.errCode === -502005) return { ok: true, cutoff, scanned: 0, deleted: 0, skipped: 'collection-not-exist' };
    throw err;
  }

  let deleted = 0;
  for (const doc of data) {
    try {
      await db.collection(ATTEMPTS).doc(doc._id).remove();
      deleted += 1;
    } catch (err) {
      console.error('[purgeRefundAttempts] 删除失败:', doc._id, err && err.message);
    }
  }

  return { ok: true, cutoff, scanned: data.length, deleted, remainingInBatch: data.length - deleted };
};
