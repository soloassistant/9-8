/**
 * 关单云函数（closeOrder）
 *
 * 解决上线阻断问题：
 *   - P0-3 支付超时无主动关单：created 订单永远不推进，脏数据淹没数据库；
 *     更严重的是用户付了钱但回调丢失时没人对账（资损）。
 *   - P2-9 无 closeOrder：本函数同时承担「定时关单」与「资损兜底对账」两个职责。
 *
 * 工作方式（定时器触发，见 config.json；也可手动调用）：
 *   1. 扫出 status=created 且 createTime 早于 30 分钟前的订单（每轮最多 50 笔）
 *   2. 逐单调 queryOrder 云函数查通道真实状态：
 *      - 通道确认已付     → queryOrder 内部已完成对账（置 paid + 延长订阅），本单计数 paidReconciled
 *      - 通道确认未付     → 关单（status=closed, closedReason=timeout）
 *      - 查不动/金额异常/未配置 → **不关**（skippedUnknown），留给下一轮或人工排查
 *        （资损安全优先：宁可留脏数据，不可把「可能已付」的订单关掉）
 *   3. 返回汇总计数，便于云函数日志观测
 *
 * 注意：
 *   - 依赖 queryOrder 云函数已部署（cloud.callFunction 同环境调用）
 *   - createTime 是 ISO 字符串（createOrder 写入 new Date().toISOString()），
 *     字典序即时间序，可用 db.command.lt 直接比较
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const STALE_MINUTES = 30;     // 订单创建超过 30 分钟未支付视为超时
const BATCH_LIMIT = 50;       // 单轮扫描上限，防止一次拉太多

// 这些通道状态下「无法确认未支付」，一律不关单，留给下一轮
const UNKNOWN_STATUSES = ['query_failed', 'amount_mismatch', 'reconcile_failed', 'unconfigured', 'unsupported'];

exports.main = async () => {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const _ = db.command;

  const snap = await db.collection('orders')
    .where({ status: 'created', createTime: _.lt(cutoff) })
    .limit(BATCH_LIMIT)
    .get();
  const orders = (snap.data || []).filter((o) => o && o.orderId && o.channel);

  const summary = {
    ok: true,
    cutoff,
    scanned: orders.length,
    closed: 0,
    paidReconciled: 0,
    skippedUnknown: 0,
    failed: 0
  };

  for (const order of orders) {
    try {
      const r = await cloud.callFunction({ name: 'queryOrder', data: { orderId: order.orderId } });
      const res = r && r.result;

      if (res && res.ok === true && res.paid === true) {
        // queryOrder 已完成对账（订单已置 paid、订阅已延长）
        summary.paidReconciled++;
        continue;
      }
      if (res && res.ok === true && UNKNOWN_STATUSES.indexOf(res.channelStatus) !== -1) {
        console.warn('[closeOrder] 通道状态不确定，本轮不关单:', order.orderId, res.channelStatus, res.error || '');
        summary.skippedUnknown++;
        continue;
      }
      if (!res || res.ok !== true) {
        console.error('[closeOrder] queryOrder 返回异常:', order.orderId, JSON.stringify(res));
        summary.skippedUnknown++;
        continue;
      }

      // 通道明确未支付 → 关单
      await db.collection('orders').doc(order._id).update({
        data: {
          status: 'closed',
          closedReason: 'timeout',
          closedTime: new Date().toISOString()
        }
      });
      summary.closed++;
      console.log('[closeOrder] 已关单:', order.orderId, 'channelStatus=', res.channelStatus);
    } catch (e) {
      summary.failed++;
      console.error('[closeOrder] 处理订单异常:', order.orderId, e.message);
    }
  }

  console.log('[closeOrder] 本轮汇总:', JSON.stringify(summary));
  return summary;
};
