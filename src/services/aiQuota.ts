/**
 * AI 对话额度闸门（H5）—— 2026-10-29
 *
 * 为什么要有（审计 P1，实测成立）：
 *   `llm_events` 这张表**写但从不读** —— `cloudLlm` 每次成功调用都 insert 一条，
 *   全仓却没有任何地方查过它。于是「免费用户每天 20 条 AI 对话」这条卖点只存在于
 *   会员页文案里：免费用户可以无限消耗付费 AI（真金白银的云端 token），也没有任何提示。
 *
 * 结构：纯规则在 `aiQuotaRules.ts`（可单测），本文件只做 IO —— 读本机镜像 + 查云端条数。
 * 口径详见 rules 里的三条不变量；这里只补一句记账时机：
 *   **只计成功回复**（cloudLlm 也是流式读完才 insert），失败/超时不扣额度。
 */
import Taro from '@tarojs/taro';
import { getCloudDatabase } from './cloudAuth';
import { readH5Subscription } from '@/utils/promo';
import {
  canChat,
  dayKey,
  decideQuota,
  FREE_CHAT_PER_DAY,
  isSameDay,
  type QuotaDecision
} from './aiQuotaRules';

export { FREE_CHAT_PER_DAY, canChat };
export type AiQuota = QuotaDecision;

/** 本地镜像 storage key（每日一条 { day, used }） */
const LOCAL_KEY = 'ai_chat_usage';

export interface LocalUsage {
  day: string;
  used: number;
}

/** 读本地镜像；跨天自动归零 */
export function readLocalUsage(now = new Date()): LocalUsage {
  const day = dayKey(now);
  try {
    const raw = Taro.getStorageSync(LOCAL_KEY) as LocalUsage | '' | null;
    // storage 缺键返回空串（不是 undefined），空串不是对象，isSameDay 会判 false → 归零
    const asObj = raw && typeof raw === 'object' ? raw : null;
    if (isSameDay(asObj, now) && asObj && typeof asObj.used === 'number' && Number.isFinite(asObj.used)) {
      return { day, used: Math.max(0, Math.floor(asObj.used)) };
    }
  } catch (err) {
    console.error('[aiQuota] read local usage failed:', err);
  }
  return { day, used: 0 };
}

/** 成功对话后本地 +1；返回加完后的值（供即时刷新） */
export function bumpLocalUsage(now = new Date()): LocalUsage {
  const cur = readLocalUsage(now);
  const next = { day: cur.day, used: cur.used + 1 };
  try {
    Taro.setStorageSync(LOCAL_KEY, next);
  } catch (err) {
    console.error('[aiQuota] write local usage failed:', err);
  }
  return next;
}

/**
 * 云端今日成功对话条数。拿不到（未登录 / 断网 / 表不可用）返回 **null 而不是 0** ——
 * 0 会让闸门误以为「今天一条都没用」，等于静默放开限制。
 */
async function countCloudToday(now = new Date()): Promise<number | null> {
  const db = await getCloudDatabase();
  if (!db) return null;
  // created_at 是 timestamptz：必须把本地日界换算成 UTC 区间，
  // 直接拿本地日期字符串比会把时区算错（东八区差 8 小时）。
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  try {
    const res = await db
      .from('llm_events')
      .select('created_at', { count: 'exact', head: true })
      .eq('kind', 'chat')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString());
    if (res.error) {
      console.error('[aiQuota] count llm_events failed:', res.error.code || '', res.error.message || '');
      return null;
    }
    return typeof res.count === 'number' ? Math.max(0, res.count) : null;
  } catch (err) {
    console.error('[aiQuota] count llm_events threw:', err);
    return null;
  }
}

/** 当前额度状态（一次云端往返；失败自动降级到本地镜像） */
export async function getAiQuota(now = new Date()): Promise<AiQuota> {
  const local = readLocalUsage(now);
  const cloud = await countCloudToday(now);
  return decideQuota({ subscribed: !!readH5Subscription(), cloudCount: cloud, localUsed: local.used });
}
