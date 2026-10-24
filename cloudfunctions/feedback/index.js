/**
 * feedback —— 用户主动反馈（功能建议 / 数据错误 / 账号与扣费 / 其他）
 *
 * 与 reportError 的分工：
 *   · reportError 是**被动**通道（崩溃/未捕获异常自动上报）；
 *   · feedback 是**主动**通道（用户自己说的），是「有问题怎么办」的最后一块拼图。
 *   两者都落独立集合，互不覆盖。
 *
 * 隐私边界：只收用户主动填写的内容 + 页面路径 + openid（归属用）；
 *   不采集设备信息、不采集行为轨迹 —— 反馈是对我们说的，不是给我们画像的。
 *
 * ⚠️ 需随云函数一起部署才生效：本环境缺 WX_APPID / WX_PRIVATE_KEY_PATH / WX_CLOUD_ENV，
 *    无法执行部署。H5 端没有本函数的 RPC 通道（应用库未注册对应 PG 函数），
 *    前端会如实提示并转为「复制内容 + 邮件」路径，不会假成功。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 类型白名单：前端只传这四类，越界一律归入 other（不拒单，避免用户白填） */
const TYPES = ['suggestion', 'data', 'account', 'other'];
const MAX_CONTENT = 2000;
const MAX_CONTACT = 120;
const MAX_PAGE = 120;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  // 与 reportError 同风格：结构化拒绝（门禁 isExplicitRejection 认「失败标记 + 原因字段」）。
  // 没有身份就不落库 —— 否则 where 退化成「只按 _id」，反馈无法归属，也无法回复。
  if (!OPENID) return { ok: false, skip: true, reason: 'no openid' };

  const e = event || {};
  const content = String(e.content || '').trim().slice(0, MAX_CONTENT);
  // 空内容是唯一的硬拒绝：没有内容的反馈没有处理价值，收下只会污染工单池
  if (!content) return { ok: false, error: 'content required' };

  const type = TYPES.indexOf(String(e.type)) >= 0 ? String(e.type) : 'other';
  const contact = String(e.contact || '').trim().slice(0, MAX_CONTACT);
  const page = String(e.page || '').slice(0, MAX_PAGE);

  const doc = {
    openid: OPENID,
    type,
    content,
    contact,
    page,
    // status 供后续工单流转（new → handling → resolved），当前只写 new，不假装有处理进度
    status: 'new',
    created_at: db.serverDate()
  };

  try {
    await db.collection('feedback').add({ data: doc });
    return { ok: true };
  } catch (err) {
    // 写库失败必须让前端知道（前端会转邮件兜底），不能返回 ok:true 吞掉
    return { ok: false, error: 'write failed' };
  }
};
