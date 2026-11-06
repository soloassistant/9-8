/**
 * 会员权益的**服务端事实源**（AC-03，2026-11-05）。
 *
 * 改前：本地凭证 `h5-subscription` 直接决定是否会员 —— 写个 expiredAt=2099 即永久 PRO。
 * 改后：本地凭证不再授予权益；小程序读 `users`（getUsage 云函数，服务端时钟），
 * H5 回放 RLS 只回本人的 `orders`（与订阅恢复同一口径）。
 * 拿不到服务端结论 → fail-closed（未订阅 + source='unavailable'），断网不得变成免费解锁。
 * H5 对 orders 只有 SELECT（v6-promo-server-codes.sql 已收回 PUBLIC/authenticated 的
 * INSERT/UPDATE/DELETE 并 DROP 掉 orders_own_insert，写入只经服务端函数 redeem_promo_order）。
 */
import Taro from '@tarojs/taro';
import { ordersListOwnForReplay } from './cloudOrders';
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
  const res = await ordersListOwnForReplay();
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
