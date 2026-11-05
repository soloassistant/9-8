/**
 * 订阅生效链路（2026-10-28，「支付后的订阅」）。
 *
 * ## 设计：订单是权益的唯一事实源
 * 支付通道接通后，支付成功分支只做一件事：往 `orders` 表落一条 status='paid'
 * 的订单（见 marketFeed 无关的 cloudOrders.orderInsert）。订阅状态**不单独存**，
 * 而是从已支付订单**回放**出来 —— 这样：
 *   - 换设备 / 重装 / 清缓存：登录后回放一遍，订阅自动回来（不需要「找回」入口）；
 *   - 退款：订单 refund_status 变了，回放时自然剔除（浏览器改不了订单，服务端说了算）；
 *   - 现在（无支付通道）：促销码兑换是第一个真实写入方 —— 兑换成功即落一条
 *     paid 订单，链路与未来支付完全同构，不是为演示另开的小灶。
 *
 * ## 到期日口径
 * 月 = 30 天（与促销码 planDays 的语义一致）。回放 = 把 paid 且未退款的订单按
 * paid_at 升序，从最早一笔的日期起逐笔顺延 months×30 天。纯函数，可单测。
 */

import { type CloudOrder } from './cloudOrders';

/** 是否计入订阅回放：已支付且未退款（退款中也不算 —— 宁可先停权益再恢复） */
function isPaidAndActive(order: CloudOrder): boolean {
  return order.status === 'paid' && order.refundStatus !== 'refunded' && order.refundStatus !== 'refunding';
}

function addMonths30(base: string, months: number): string {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + Math.round(months) * 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 从订单列表回放到期日。纯函数。
 * @param today 今天 'YYYY-MM-DD'（注入便于测试）
 * @returns 最终到期日；没有任何有效 paid 订单返回 null
 */
export function computeExpiryFromOrders(orders: CloudOrder[], today: string): string | null {
  const paid = orders
    .filter(isPaidAndActive)
    .filter((o) => o.paidTime) // 没有 paid_at 的旧脏数据不参与（无从排序）
    .sort((a, b) => (a.paidTime! < b.paidTime! ? -1 : 1));
  if (paid.length === 0) return null;
  let expiry = paid[0].paidTime!.slice(0, 10);
  for (const o of paid) {
    // 每笔从「上一笔到期日」与「本笔支付日」中取较晚者起算 —— 中断后再买的用户不吃亏也不白送
    const start = expiry > o.paidTime!.slice(0, 10) ? expiry : o.paidTime!.slice(0, 10);
    expiry = addMonths30(start, o.months);
  }
  return expiry >= today ? expiry : null; // 回放出来已过期 = 如实未订阅
}

/** 兑换成功后落一条 promo 订单（orders 表的第一个写入方；失败只记日志不阻塞兑换） */
export async function recordPromoOrder(days: number): Promise<boolean> {
  const { orderInsert } = await import('./cloudOrders');
  const months = Math.max(1, Math.round(days / 30));
  return orderInsert({
    orderId: `promo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    planId: 'promo',
    channel: 'promo',
    amountCents: 0,
    months,
    status: 'paid',
    paidAt: new Date().toISOString()
  });
}

export interface RestoreResult {
  /** 是否发生了恢复动作（本地落后于云端时 true） */
  restored: boolean;
  /** 回放出的到期日（null = 云端没有有效订阅） */
  expiredAt: string | null;
  reason: 'no-session' | 'no-orders' | 'up-to-date' | 'restored' | 'db-error';
}

/**
 * 登录态下把订单回放成权益（跨设备恢复）。
 *
 * AC-03 改前：这里会把回放出的到期日**写回本地凭证** `h5-subscription`，
 * 于是本地存储成了事实源（伪造一个 2099 的日期即可永久会员）。
 * 改后：回放只更新进程内的服务端权益缓存（`services/entitlement`），
 * **不再写本地凭证** —— 本地存储不再参与任何权益判定。
 */
export async function restoreSubscriptionFromOrders(): Promise<RestoreResult> {
  // 动态 import：entitlement 静态依赖本文件的纯函数 computeExpiryFromOrders，
  // 静态互引会形成模块环；这里在调用期才取，环不会在求值阶段被触发。
  const { refreshEntitlement } = await import('./entitlement');
  const ent = await refreshEntitlement();
  if (ent.source === 'unavailable') {
    return { restored: false, expiredAt: null, reason: 'db-error' };
  }
  if (ent.source === 'none') {
    return { restored: false, expiredAt: null, reason: 'no-session' };
  }
  if (!ent.active || !ent.expiredAt) {
    return { restored: false, expiredAt: null, reason: 'no-orders' };
  }
  return { restored: true, expiredAt: ent.expiredAt, reason: 'restored' };
}
