const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  // 取不到微信上下文就拒绝：openid 为 undefined 时 `where({ openid: undefined })` 会把所有
  // 无上下文调用方并成同一个数据桶，等于收藏夹对所有人敞开。
  if (!OPENID) throw new Error('no openid');
  const res = await db
    .collection('items')
    .where({ openid: OPENID })
    .orderBy('createTime', 'desc')
    .limit(100)
    .get();
  return res.data;
};
