/**
 * 订阅订单（H5 通道）—— WorkBuddy 云数据库 `orders` 表（2026-10-27）。
 *
 * ## 为什么换掉微信云函数
 * 旧实现走 `Taro.cloud.callFunction('ordersList')`。那套只有小程序端有 `Taro.cloud`，
 * H5 根本没有这个对象 —— 于是「订阅记录」在网页端必然失败，而页面还给了一个
 * **点多少次都不会成功的「重试」按钮**。按「不按小程序做，用云服务自己的通道」的决定，
 * 订单改落 WorkBuddy 云数据库：客户端只 insert / select 自己的行。
 *
 * ## 安全边界（改这里之前先读完）
 * - `owner_id` 由 `DEFAULT auth.uid()` **服务端**填充，客户端绝不传。
 *   表上的 INSERT 策略是 `WITH CHECK (owner_id = auth.uid())`，传伪造值只会被拒。
 * - 表**只 GRANT 给 `authenticated`，没有给 `anon`**。原因不是洁癖：匿名会话的
 *   `auth.uid()` 返回字面量 `'anon'`，所有匿名访客共用同一个 owner —— 给 anon 开
 *   SELECT 等于让所有未登录访客互相读到对方的订单（`client_errors` 踩过这个坑，
 *   当时实测读到了全部匿名用户的崩溃日志）。
 * - 没有 UPDATE / DELETE 策略：订单一旦写入，浏览器改不了；退款只能服务端做。
 *
 * ## 失败语义
 * 三态而不是两态：「没登录」和「后端故障」必须分开 —— 前者不该给重试按钮，
 * 后者才值得重试。所以返回 `{ ok:false, reason:'no-session' | 'db-error' }`。
 */

import { getCloudDatabase, getSession } from './cloudAuth';

/** 一条订单（列名已从 snake_case 转成前端用的驼峰） */
export interface CloudOrder {
  orderId: string;
  channel: string;
  planId: string;
  /** 金额（元）—— 库里存的是分 */
  price: number;
  months: number;
  status: string;
  refundStatus: string;
  /** ISO 时间串；缺失时为空串（调用方不要编一个日期出来） */
  createTime: string;
  paidTime: string | null;
}

/** 查询结果：ok=false 时带上原因，调用方据此决定「给不给重试」 */
export type OrdersFetch =
  | { ok: true; orders: CloudOrder[] }
  | { ok: false; reason: 'no-session' | 'db-error' };

/** 只取展示需要的列 —— 刻意不含 owner_id（客户端不需要，也不该拿到别人的） */
const ORDER_COLUMNS = 'order_id, channel, plan_id, amount_cents, months, status, refund_status, created_at, paid_at';

/**
 * 行 → 视图模型。price 存的是**分**，且历史数据可能缺字段：
 * `Number(undefined)/100` 是 NaN，序列化到界面就成了「¥NaN」——必须兜底。
 */
export function toCloudOrder(row: Record<string, unknown>): CloudOrder {
  const cents = Number(row.amount_cents);
  const months = Number(row.months);
  return {
    orderId: String(row.order_id || ''),
    channel: String(row.channel || ''),
    planId: String(row.plan_id || ''),
    price: Number.isFinite(cents) ? Math.round(cents) / 100 : 0,
    months: Number.isFinite(months) && months > 0 ? months : 1,
    status: String(row.status || 'created'),
    refundStatus: String(row.refund_status || 'none'),
    createTime: typeof row.created_at === 'string' ? row.created_at : '',
    paidTime: typeof row.paid_at === 'string' ? row.paid_at : null
  };
}

/** 读当前用户的订单（RLS 保证只返回自己的行）。limit 收敛到 [1, 50]。 */
export async function ordersListOwn(limit = 20): Promise<OrdersFetch> {
  const session = await getSession();
  if (!session) return { ok: false, reason: 'no-session' };

  const db = await getCloudDatabase();
  if (!db) {
    console.error('[cloudOrders] 云数据库不可用（SDK 未就绪）');
    return { ok: false, reason: 'db-error' };
  }

  const res = await db
    .from('orders')
    .select(ORDER_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(limit, 50)));

  if (res.error) {
    // console.error 而非 warn：后者会被生产构建剔除，线上零痕迹（本仓铁律）
    console.error('[cloudOrders] ordersListOwn failed:', res.error.code || '', res.error.message || '');
    return { ok: false, reason: 'db-error' };
  }

  const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
  return { ok: true, orders: rows.map(toCloudOrder) };
}

/** 落一条订单所需的字段（`owner_id` 不在其中，由数据库填） */
export interface OrderDraft {
  orderId: string;
  planId: string;
  /** 'wechat' | 'alipay' | 'douyin' | 'promo' —— 表上是普通文本，不做枚举 CHECK */
  channel: string;
  /** 金额（分） */
  amountCents: number;
  months: number;
  status?: 'created' | 'paid' | 'closed' | 'failed';
  paidAt?: string | null;
}

/**
 * 写一条订单。
 *
 * ⚠️ 现状（2026-10-27）：**还没有调用方** —— H5 的 `getPayChannel()` 恒为 null，
 * 网页端没有在线支付通道，所以没有真实成交可记。这个函数是给「支付接通后」用的
 * 写入契约（届时在支付成功分支里调用）；在那之前 `orders` 表为空是**预期状态**，
 * 页面显示「暂无支付记录」也是真的，不是故障。
 *
 * 不传 owner_id：由 `DEFAULT auth.uid()` 填。显式传 null 反而会覆盖默认值并被 RLS 拒。
 */
export async function orderInsert(draft: OrderDraft): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;

  const db = await getCloudDatabase();
  if (!db) return false;

  const row: Record<string, unknown> = {
    order_id: draft.orderId,
    plan_id: draft.planId,
    channel: draft.channel,
    amount_cents: Math.max(0, Math.round(draft.amountCents)),
    months: Math.max(1, Math.min(Math.round(draft.months), 120)),
    status: draft.status || 'created'
  };
  if (draft.paidAt) row.paid_at = draft.paidAt;

  const res = await db.from('orders').insert(row).select();
  if (res.error) {
    // 23505 = 同一个 orderId 重复写入（重试/双击）。订单号按次生成，正常不会撞。
    console.error('[cloudOrders] orderInsert failed:', res.error.code || '', res.error.message || '');
    return false;
  }
  return true;
}
