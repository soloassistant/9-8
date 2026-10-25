const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 兑换码兑换（一码一用版，小程序端 —— 2026-10-25）
 *
 * 与 H5 促销码（utils/promo.ts）的区别：这里靠云数据库做到**一码一用 + 定向发放** ——
 * 码表 redeemCodes 由运营在云开发控制台手动录入，每码限量 maxUses 份，先到先得。
 *
 * 数据形状（collection: redeemCodes，控制台手工建）：
 *   { code: 'PRO-XXXX-XXXX', planDays: 30, maxUses: 50, usedBy: [], createdAt }
 *
 * 竞争安全：并发兑换可能两个请求同时读到 usedCount < maxUses —— 用「读出的文档
 * _id + update 带 where 条件（usedBy 数组长度）」无法原子表达，所以用
 * db.startTransaction 事务包住「读-校验-写」。微信云开发事务在文档级串行，
 * 同一码的并发兑换在事务层被拒（其中一个 throw），客户端提示重试即可。
 *
 * 入参：{ code }；身份只认 OPENID（不接受 event.openid，同仓库其它函数口径）。
 */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { code: -1, message: 'no openid' };

  const code = String((event && event.code) || '').trim().toUpperCase();
  if (!/^PRO-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    return { code: -1, message: 'bad format' };
  }

  const db = cloud.database();
  const _ = db.command;
  try {
    const result = await db.runTransaction(async (transaction) => {
      const docRes = await transaction.collection('redeemCodes').where({ code }).get();
      const doc = docRes.data && docRes.data[0];
      if (!doc) return { ok: false, reason: 'unknown' };
      const usedBy = Array.isArray(doc.usedBy) ? doc.usedBy : [];
      if (usedBy.includes(OPENID)) return { ok: false, reason: 'already' };
      if (usedBy.length >= (doc.maxUses || 1)) return { ok: false, reason: 'soldout' };

      // 发权益：读用户当前到期日，未过期则顺延（与 pay-callback 同口径）
      const userRes = await transaction.collection('users').where({ openid: OPENID }).get();
      const user = userRes.data && userRes.data[0];
      if (!user) return { ok: false, reason: 'no-user' };
      const base = user.expiredAt && new Date(user.expiredAt) > new Date() ? new Date(user.expiredAt) : new Date();
      const expiredAt = new Date(base.getTime() + (doc.planDays || 30) * 86400 * 1000);

      await transaction.collection('users').doc(user._id).update({
        data: { subscribed: true, expiredAt: expiredAt.toISOString() }
      });
      await transaction.collection('redeemCodes').doc(doc._id).update({
        data: { usedBy: _.push([OPENID]) }
      });
      return { ok: true, expiredAt: expiredAt.toISOString() };
    });
    if (result.ok) return { code: 0, message: 'ok', data: result };
    return { code: -1, message: result.reason };
  } catch (err) {
    // 事务冲突（并发兑换同一码）按可重试错误返回，不伪装成功
    console.error('[redeemCode] transaction failed:', err && err.message);
    return { code: -1, message: 'busy, retry' };
  }
};
