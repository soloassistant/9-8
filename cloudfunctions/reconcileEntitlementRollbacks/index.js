/**
 * 退款后「权益回滚失败」的轻量对账（定时触发）
 *
 * 背景：refundOrder 采用两段提交——退款事实先落库（status=refunded），再扣权益。
 * 扣权益失败时只写 `entitlementRollbackStatus='failed'`，退款状态保持正确。
 * 本函数负责把 failed 收敛成 rolled_back，连续失败 N 次转 manual_required，
 * 只做状态推进，**不提供任何人工操作入口**。
 *
 * 幂等设计：首次尝试先持久化 `entitlementRollbackBase`（当时的到期日）与
 * `entitlementRollbackTarget`（应扣到的绝对值），再对 users 做**绝对赋值**。
 * 因此重试不会重复扣减；若到期日在回滚期间发生变化（新购买/兑换），
 * 绝不覆盖，直接转 manual_required 交人工核对。
 *
 * 触发：config.json 每日 03:15（7 段 cron）；单次最多处理 20 条，失败留待下一轮。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_ATTEMPTS = 3;
const BATCH = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

exports.main = async () => {
  const snap = await db.collection('orders')
    .where({ entitlementRollbackStatus: 'failed' })
    .limit(BATCH)
    .get();
  const list = snap.data || [];
  const result = { scanned: list.length, rolledBack: 0, retried: 0, manual: 0 };

  for (const order of list) {
    const outcome = await reconcileOne(order);
    result[outcome] = (result[outcome] || 0) + 1;
  }
  console.log('[reconcileRollbacks] 本轮:', JSON.stringify(result));
  return Object.assign({ ok: true }, result);
};

async function reconcileOne(order) {
  const userRes = await db.collection('users').where({ openid: order.openid }).limit(1).get();
  const user = userRes.data && userRes.data[0];
  if (!user) return recordFailure(order, 'user-not-found'); // 账号已注销/数据缺失：永久失败

  const months = Number(order.months) || 0;
  if (!months) {
    await updateOrder(order._id, {
      entitlementRollbackStatus: 'manual_required',
      entitlementRollbackError: 'months 缺失，无法计算回滚天数'
    });
    return 'manual';
  }

  const rollbackMs = months * 30 * MS_PER_DAY;
  let base = order.entitlementRollbackBase;
  let target = order.entitlementRollbackTarget;
  if (!base || !target) {
    base = new Date(user.expiredAt || Date.now()).toISOString();
    target = new Date(new Date(base).getTime() - rollbackMs).toISOString();
    // 先落基准与目标，再动用户数据：崩溃后重试是同一个绝对赋值，不会重复扣
    if (!(await updateOrder(order._id, { entitlementRollbackBase: base, entitlementRollbackTarget: target }))) {
      return 'retried';
    }
  }

  const current = new Date(user.expiredAt || 0).getTime();
  const baseMs = new Date(base).getTime();
  const targetMs = new Date(target).getTime();

  if (current <= targetMs) {
    // 已经到位（上一次扣减成功但状态没写成）→ 只补状态，不再扣
    await updateOrder(order._id, {
      entitlementRollbackStatus: 'rolled_back',
      entitlementRollbackAt: new Date().toISOString(),
      entitlementRollbackError: ''
    });
    return 'rolledBack';
  }
  if (current !== baseMs) {
    // 回滚窗口内到期日又被新购买/兑换改大 → 覆盖会吃掉新权益，交人工
    await updateOrder(order._id, {
      entitlementRollbackStatus: 'manual_required',
      entitlementRollbackError: '回滚期间到期日发生变化，需人工核对'
    });
    return 'manual';
  }

  try {
    await db.collection('users').doc(user._id).update({
      data: {
        expiredAt: target,
        subscribed: targetMs > Date.now(),
        updatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    return recordFailure(order, err.message || String(err));
  }

  await updateOrder(order._id, {
    entitlementRollbackStatus: 'rolled_back',
    entitlementRollbackAt: new Date().toISOString(),
    entitlementRollbackError: ''
  });
  return 'rolledBack';
}

async function recordFailure(order, message) {
  const attempts = (Number(order.entitlementRollbackAttempts) || 0) + 1;
  const manual = attempts >= MAX_ATTEMPTS;
  await updateOrder(order._id, {
    entitlementRollbackAttempts: attempts,
    entitlementRollbackStatus: manual ? 'manual_required' : 'failed',
    entitlementRollbackError: String(message || 'rollback failed').slice(0, 200),
    entitlementRollbackLastAt: new Date().toISOString()
  });
  return manual ? 'manual' : 'retried';
}

async function updateOrder(id, patch) {
  try {
    await db.collection('orders').doc(id).update({ data: patch });
    return true;
  } catch (err) {
    console.error('[reconcileRollbacks] 订单回写失败:', id, err.message);
    return false;
  }
}
