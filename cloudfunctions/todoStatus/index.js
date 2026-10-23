/**
 * todoStatus —— 待办状态的确定性写入口。
 *
 * ⚠️ 需随云函数一起部署才生效：本环境缺 WX_APPID / WX_PRIVATE_KEY_PATH / WX_CLOUD_ENV，
 *    无法执行部署。未部署时前端调用会得到 call_failed，页面会 toast「保存失败」而不是假成功。
 *
 * 为什么需要它：旧实现靠 chat 云函数理解「完成了『xxx』」再改状态，写哪一条由 LLM 解析决定，
 * 可能标错条目；而且失败时前端已经先把 UI 勾上了。状态变更只应由确定性接口承担，
 * LLM 只负责理解自然语言指令。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const ALLOWED_STATUS = ['done', 'confirmed'];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 与 confirmItem 一致：没有微信上下文直接拒绝。openid 缺失时 where 会退化成「只按 _id」，
  // 等于任何调用方都能改别人的待办。
  if (!OPENID) throw new Error('no openid');

  const id = String((event && event.id) || '');
  const status = event && event.status;
  if (!id) throw new Error('id required');
  if (!ALLOWED_STATUS.includes(status)) throw new Error('invalid status');

  // 条件必须同时带 _id 与 openid：只按 _id 更新会越权修改他人待办
  const where = { _id: id, openid: OPENID };

  const found = await db.collection('todos').where(where).limit(1).get();
  const doc = found && Array.isArray(found.data) ? found.data[0] : null;
  if (!doc) return { ok: false, reason: 'not_found' };

  // 幂等：已是目标状态不写库
  if (doc.status === status) return { ok: true, unchanged: true };

  const res = await db
    .collection('todos')
    .where(where)
    .update({ data: { status, updateTime: new Date().toISOString() } });
  const updated = res && res.stats && typeof res.stats.updated === 'number' ? res.stats.updated : 0;
  // 更新影响 0 行说明没写进去（并发删除/权限异常）：抛错让前端拿到 call_failed，
  // 而不是回一个看起来成功的 { ok:true }。
  if (updated === 0) throw new Error('update failed');

  return { ok: true };
};
