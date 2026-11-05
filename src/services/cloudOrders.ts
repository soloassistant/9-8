/**
 * 订阅订单（H5 通道）—— WorkBuddy 云数据库 `orders` 表（2026-10-27）。
 *
 * ## 为什么换掉微信云函数
 * 旧实现走 `Taro.cloud.callFunction('ordersList')`。那套只有小程序端有 `Taro.cloud`，
 * H5 根本没有这个对象 —— 于是「订阅记录」在网页端必然失败，而页面还给了一个
 * **点多少次都不会成功的「重试」按钮**。按「不按小程序做，用云服务自己的通道」的决定，
 * 订单改落 WorkBuddy 云数据库：客户端**只读**自己的行。
 *
 * ## 安全边界（改这里之前先读完）
 * - A-1（2026-11-05）：客户端**没有任何写入口**。`v5-orders-server-write.sql` 收回
 *   authenticated/anon 的 INSERT/UPDATE/DELETE，唯一写入通道是服务端函数
 *   `record_promo_order()`（SECURITY DEFINER，天数/状态/金额全由服务端生成）。
 *   改前 INSERT 策略是 `WITH CHECK (owner_id = auth.uid())` —— 「插自己的一行」是合法写入，
 *   任何登录用户直插 `status:'paid', months:120` 就能回放成 10 年 PRO。
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
 * 拉取超时。没有超时的话，请求悬住时界面就永远停在「…」——和那个假重试按钮是同一类
 * 坏体验（用户看不出是在加载还是已经死了）。8s 与 cloudSync 的拉取超时保持一致。
 */
const LIST_TIMEOUT_MS = 8000;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const res = await db
      .from('orders')
      .select(ORDER_COLUMNS)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(limit, 50)))
      .abortSignal(controller.signal);

    if (res.error) {
      // console.error 而非 warn：后者会被生产构建剔除，线上零痕迹（本仓铁律）
      console.error('[cloudOrders] ordersListOwn failed:', res.error.code || '', res.error.message || '');
      return { ok: false, reason: 'db-error' };
    }

    const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
    return { ok: true, orders: rows.map(toCloudOrder) };
  } catch (err) {
    // 中止（超时）或网络异常：一律算可重试的故障
    console.error('[cloudOrders] ordersListOwn aborted/failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: 'db-error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⚠️ 这里**故意没有** orderInsert：客户端写入订单的路径已移除（A-1）。
 * 需要写订单时走服务端函数（`subscription.recordPromoOrder` → `record_promo_order()`），
 * 不要在这个模块里重新加回 `from('orders').insert(...)`。
 */
