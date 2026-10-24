/**
 * 续费管理（纯逻辑：不碰 Taro / storage，便于 esbuild + vm 做行为断言）
 *
 * 为什么需要：订阅到期这件事当前只有「订阅至 2026-11-24」一行静态文字，
 * 没有倒计时、没有到期前提示、也没有"到期后会怎样"的说明。结果是**静默流失** ——
 * 用户在某天打开发现 AI 与语音额度变回免费档，却不知道发生了什么，
 * 也不确定"是不是我取消了"。订阅类产品最常见的退款/投诉来源就是这个。
 *
 * 本模块只做**判定**，不发任何东西：不弹推送、不自动扣款、不改订单。
 * 产品侧明确不做自动续费（支付通道尚未接入且需要用户显式确认），
 * 所以文案必须说清"到期前只在本页提示"，不能暗示会自动续。
 *
 * 边界（都写进断言）：
 *   · 没有订阅 / 到期日非法 → status='none'，**绝不猜**一个日期出来；
 *   · 到期当天（daysLeft=0）算 expiring 而不是 expired —— 多数平台按"到期日当天仍可用"计，
 *     提前判过期会让用户在还有效时看到"已过期"；
 *   · 提醒一天最多一次（跨天重置），避免每次进页面都弹。
 */
import { dayIndex, daysBetween } from './date';

/** 距到期几天开始提醒 */
export const RENEW_WARN_DAYS = 7;

export type SubStatus = 'none' | 'active' | 'expiring' | 'expired';

export interface RenewalInfo {
  status: SubStatus;
  /** 距离到期还有几天；负数=已过期天数；status='none' 时为 null（不知道，不要编） */
  daysLeft: number | null;
  /** 规范化后的到期日 'YYYY-MM-DD'；无法解析时为空串 */
  expiredAt: string;
  /** 是否应该提醒（expiring / expired） */
  remind: boolean;
}

export interface ResolveArgs {
  /** 服务端 profile.subscribed（可能是滞后的：日期已过但标记还没清） */
  subscribed?: boolean;
  /** 'YYYY-MM-DD' 或带时间的 ISO 串（取前 10 位） */
  expiredAt?: string;
  /** 今天 'YYYY-MM-DD' */
  today: string;
  warnDays?: number;
}

/** 把 '2026-11-24T...' / '2026-11-24' 规范成 'YYYY-MM-DD'；非法返回 '' */
export function normalizeDay(raw?: string): string {
  const head = String(raw || '').slice(0, 10);
  return dayIndex(head) === null ? '' : head;
}

export function resolveRenewal(args: ResolveArgs): RenewalInfo {
  const warnDays = Number.isFinite(args.warnDays) ? Number(args.warnDays) : RENEW_WARN_DAYS;
  const day = normalizeDay(args.expiredAt);
  // 没有订阅标记、或者日期不可解析 → 一律 none。**不要**用 subscribed 硬推出一个状态：
  // 服务端 marking 与日期可能不同步，猜出来的"还剩 X 天"会直接骗人。
  if (!args.subscribed || !day) {
    return { status: 'none', daysLeft: null, expiredAt: '', remind: false };
  }
  const diff = daysBetween(args.today, day);
  if (diff === null) {
    return { status: 'none', daysLeft: null, expiredAt: '', remind: false };
  }
  if (diff < 0) return { status: 'expired', daysLeft: diff, expiredAt: day, remind: true };
  if (diff <= Math.max(0, warnDays)) {
    return { status: 'expiring', daysLeft: diff, expiredAt: day, remind: true };
  }
  return { status: 'active', daysLeft: diff, expiredAt: day, remind: false };
}

/** 提醒节流：同一天只提醒一次；跨天自动恢复 */
export function shouldRemind(lastRemindDay: string | null | undefined, today: string, info: RenewalInfo): boolean {
  if (!info.remind) return false;
  if (dayIndex(today) === null) return false;
  return String(lastRemindDay || '') !== today;
}

/**
 * 到期后降级说明里要用到的"还剩多久"文案键。
 * 单独抽出来是因为页面要 t()，而 utils 层不许硬编码中文。
 */
export type RenewalCopyKey = 'statusActive' | 'statusExpiring' | 'statusToday' | 'statusExpired';

export function copyKeyOf(info: RenewalInfo): RenewalCopyKey {
  if (info.status === 'expired') return 'statusExpired';
  if (info.status === 'expiring') return info.daysLeft === 0 ? 'statusToday' : 'statusExpiring';
  return 'statusActive';
}
