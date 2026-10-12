const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  // 取不到微信上下文就拒绝：否则会建出 openid 为 undefined 的「用户」，随后所有人的
  // 查询都命中这一条共享档案（昵称、订阅状态、偏好全部串在一起）。
  if (!OPENID) throw new Error('no openid');
  const users = db.collection('users');

  try {
    const existing = await users.where({ openid: OPENID }).limit(1).get();
    if (existing.data.length > 0) {
      return existing.data[0];
    }
  } catch (err) {
    console.error('[login] query failed:', err);
    throw err;
  }

  const profile = {
    openid: OPENID,
    nickname: '晨友',
    briefingTime: '07:30',
    preferences: [],
    subscribed: false,
    expiredAt: null,
    isEarlyBird: false,
    createdAt: new Date().toISOString()
  };

  try {
    await users.add({ data: profile });
  } catch (err) {
    console.error('[login] create user failed:', err);
    throw err;
  }
  return profile;
};
