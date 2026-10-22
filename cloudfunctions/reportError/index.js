/**
 * 崩溃/异常上报云函数
 *
 * 前端通过 Taro.onError / 各页面 catch 块调用 cloud.callFunction('reportError')
 * → 写入 errors 集合，字段包含来源、错误信息、堆栈、页面、用户标识。
 *
 * 集合结构（errors）：
 *   - openid        string     用户 openid
 *   - channel       string     来源通道 weapp/h5/alipay/tt
 *   - page          string     出错页面路径
 *   - message       string     错误消息
 *   - stack         string     堆栈（可选，截前 2000 字防溢出）
 *   - extra         object     扩展字段（业务上下文，可选）
 *   - created_at    Date       记录时间
 *
 * 无返回值安全——前端 fire-and-forget，上报失败不影响用户体验。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_STACK_LEN = 2000;
const MAX_MSG_LEN = 500;
const MAX_EXTRA_LEN = 4000;

exports.main = async (event) => {
  const { OPENID, APPID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, skip: true, reason: 'no openid' };

  const err = event || {};
  const doc = {
    openid: OPENID,
    channel: String(err.channel || event.TARO_ENV || (APPID ? 'weapp' : 'unknown')),
    page: String(err.page || err.route || ''),
    message: String(err.message || err.msg || err.error || 'unknown error').slice(0, MAX_MSG_LEN),
    stack: err.stack ? String(err.stack).slice(0, MAX_STACK_LEN) : '',
    extra: err.extra ? truncateExtra(err.extra) : null,
    created_at: db.serverDate(),
    appid: APPID || ''
  };

  try {
    await db.collection('errors').add({ data: doc });
    // 异步：不等待，也不阻塞返回
    return { ok: true };
  } catch (writeErr) {
    // 写 errors 集合失败不能让前端再崩溃
    console.error('[reportError] 写入 errors 集合失败:', writeErr.message);
    return { ok: false, reason: writeErr.message };
  }
};

function truncateExtra(extra) {
  try {
    const str = JSON.stringify(extra);
    if (str.length <= MAX_EXTRA_LEN) return extra;
    return { _truncated: true, _originalLen: str.length, _head: str.slice(0, MAX_EXTRA_LEN) };
  } catch {
    return { _unserializable: true };
  }
}
