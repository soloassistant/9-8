const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 24 小时制 HH:mm（与 chat/index.js 的 PREF_TIME_RE 同口径）。
 * 原来的 /^\d{2}:\d{2}$/ 会放过 25:99 / 99:99 —— 脏时间落库后 getBriefing 的
 * resolveUserHour() 解析不出合法小时，会静默把用户退回默认 07:30（用户设的时间被吞）。
 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 取不到微信上下文就拒绝：否则 update/查询会命中 `where({ openid: undefined })`，
  // 变成「任意无上下文调用方都能改到同一条记录」。
  if (!OPENID) throw new Error('no openid');
  const payload = event || {};
  const update = {};

  if (typeof payload.nickname === 'string' && payload.nickname.trim()) {
    update.nickname = payload.nickname.trim().slice(0, 12);
  }
  if (typeof payload.briefingTime === 'string' && TIME_RE.test(payload.briefingTime)) {
    update.briefingTime = payload.briefingTime;
  }
  if (Array.isArray(payload.preferences)) {
    update.preferences = payload.preferences.slice(0, 10).map(String);
  }
  if (Object.keys(update).length === 0) {
    throw new Error('no valid fields to update');
  }
  update.updatedAt = new Date().toISOString();

  let updatedCount = 0;
  try {
    const updRes = await db.collection('users').where({ openid: OPENID }).update({ data: update });
    updatedCount = updRes && updRes.stats && typeof updRes.stats.updated === 'number' ? updRes.stats.updated : 0;
  } catch (err) {
    console.error('[updateSettings] failed:', err);
    throw err;
  }

  // 命中 0 行 = 该 openid 没有用户档案（档案应由 login 创建）。
  // 旧实现不检查，随后 res.data[0] 为 undefined 直接返回：前端拿到一个非对象、这次修改也永久丢失。
  // 这里如实报错（不改成 upsert —— 静默建号会掩盖身份问题）。
  if (updatedCount === 0) throw new Error('user not found');

  const res = await db.collection('users').where({ openid: OPENID }).limit(1).get();
  return res.data[0];
};
