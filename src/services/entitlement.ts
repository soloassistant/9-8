/**
 * 会员权益的**服务端事实源**（AC-03，2026-11-05）。
 *
 * ## 改前是什么行为（审计实测）
 * `utils/promo.ts` 的本地凭证 `h5-subscription` 直接决定「是否会员」：
 * 在控制台写 `localStorage['h5-subscription'] = {"data":{"expiredAt":"2099-12-31"}}`
 * 即可永久解锁不限额度 —— 伪造成本为 0，且清缓存/换设备后本地凭证还能被订单回放重写。
 *
 * ## 改后
 * 本地凭证**不再授予任何权益**。会员态只能由服务端确认，且每次确认都按服务端时钟判：
 *   - 微信小程序：`getUsage` 云函数按 OPENID 读 `users` 表（部署后生效）；
 *   - H5：`orders` 表由数据库 RLS 只回给本人，再按 paid / 未退款订单回放到期日
 *     （`computeExpiryFromOrders`，与订阅恢复同一口径）。
 *
 * ## 失败语义：fail-closed
 * 拿不到服务端结论 → 按**未订阅**处理，并标记 `source='unavailable'`，
 * 页面可以据此显示「权益状态暂时无法确认」，而不是把故障当成「你确实没买」。
 * 不能 fail-open —— 那等于把断网/后端故障变成免费解锁。
 *
 * ## 已知残余边界（本 PR 不假装解决）
 * H5 的 `orders` 表允许客户端插入自己的行（RLS 只约束 owner_id），
 * 所以「伪造一条 paid 订单」仍可能被回放成会员。彻底收口需要把订单写入改成
 * 服务端函数（SQL 迁移），属于后续项；本 PR 只堵「本地存储直接伪造」这条零成本路径。
 */
import Taro from '@tarojs/taro';
import { ordersListOwn } from './cloudOrders';
import { computeExpiryFromOrders } from './subscription';

export type EntitlementSource = 'none' | 'server-orders' | 'server-weapp' | 'unavailable';

export interface Entitlement {
  active: boolean;
  /** 'YYYY-MM-DD'；未激活时恒为 null（不编一个日期出来） */
  expiredAt: string | null;
  source: EntitlementSource;
}

const INACTIVE: Entitlement = { active: false, expiredAt: null, source: 'none' };

/** 进程内缓存：同步消费方（getUsage / buildProfileFromSession）读它，异步方负责刷新 */
let current: Entitlement = INACTIVE;

/** 同步读取上一次服务端确认的结果（未刷新过 = 未订阅） */
export function readEntitlement(): Entitlement {
  return current;
}

/** 是否会员 —— **只认服务端结论**，不读 localStorage */
export function hasProEntitlement(): boolean {
  return current.active;
}

/** 门禁注入口：仅供断言构造服务端结论，业务代码不要调用 */
export function _setEntitlementForTest(next: Entitlement): void {
  current = next;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 小程序：getUsage 云函数按 OPENID 读 users 表；任何异常/形状不对 → unavailable（不授予） */
async function fetchWeapp(): Promise<Entitlement> {
  const cloud = (
    Taro as unknown as {
      cloud?: {
        callFunction?: (opt: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
      };
    }
  ).cloud;
  if (!cloud?.callFunction) return { active: false, expiredAt: null, source: 'unavailable' };
  try {
    const raw = await cloud.callFunction({ name: 'getUsage', data: { action: 'getEntitlement' } });
    const body = ((raw as { result?: unknown } | null)?.result ?? raw) as {
      code?: number;
      data?: { subscribed?: boolean; expiredAt?: string | null };
    } | null;
    // 只认明确成功（code === 0）；缺 code 或非 0 一律按拿不到处理，避免把错误体当权益
    if (!body || typeof body.code !== 'number' || body.code !== 0) {
      return { active: false, expiredAt: null, source: 'unavailable' };
    }
    const active = body.data?.subscribed === true;
    const expiredAt =
      active && typeof body.data?.expiredAt === 'string' ? body.data.expiredAt.slice(0, 10) : null;
    return { active, expiredAt, source: 'server-weapp' };
  } catch (err) {
    console.error('[entitlement] weapp getUsage failed:', err);
    return { active: false, expiredAt: null, source: 'unavailable' };
  }
}

/** H5：orders 表（RLS 只回本人）回放到期日；无会话 = 确定未订阅，其余失败 = 拿不到 */
async function fetchH5(): Promise<Entitlement> {
  const res = await ordersListOwn(50);
  if (!res.ok) {
    return {
      active: false,
      expiredAt: null,
      source: res.reason === 'no-session' ? 'none' : 'unavailable'
    };
  }
  const expiredAt = computeExpiryFromOrders(res.orders, todayStr());
  return { active: !!expiredAt, expiredAt, source: 'server-orders' };
}

/** 刷新权益（启动、会员页、兑换后各调一次）。永不 reject —— 失败也返回结构化结果。 */
export async function refreshEntitlement(): Promise<Entitlement> {
  const next = process.env.TARO_ENV === 'weapp' ? await fetchWeapp() : await fetchH5();
  current = next;
  return next;
}
